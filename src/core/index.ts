import { defaults, fromScript, merge, validate, type Config } from './config';
import { Bus } from './bus';
import { Frustration, type Signal } from './frustration';
import { createSession, touch } from './session';
import { createBatcher } from './batcher';
import { startErrors, errFp } from './errors';
import { startCapture, type Capture } from './capture';
import { device } from './dom';
import { watchRoutes } from './route';
import { createGzip, createLoader } from './loader';
import { fingerprint } from '../page/selectors';
import { HEAT, normUrl, pageUrl, redact } from '../privacy/redactor';
import type { Breadcrumb, Ctx, Ev, Session } from './types';
import { D, W, idle, now, on, rid, setGuard, sget, sset } from './util';
import { watchWho } from './who';

const VERSION = __VERSION__;
const script = D.currentScript as HTMLScriptElement | null;

type Api = Record<string, any>;
const BRIDGE = /^\/(collect|config)(?:[?#]|$)/;

const QUEUED = ['init', 'track', 'identify', 'consent', 'on', 'destroy'];

/**
 * Load-time work is only this: claim window.Assist with a queueing stub and
 * schedule the real boot as separate short tasks, so parsing/compiling the
 * core and starting capture never block the host page's own startup.
 */
function install() {
  const w = W as any;
  const prev: Api | undefined = w.Assist;
  if (prev && prev.__loaded) {
    if (prev.version !== VERSION && prev.config?.debug) console.warn('[assist]', prev.version);
    return;
  }
  // Read before a single-page app rewrites the address; kept for the tab so the overlay survives navigation.
  const heat = new URLSearchParams(location.search).get(HEAT);
  if (heat) sset(HEAT, heat, true);
  const queue: [string, any[]][] = (prev && prev.q) || [];
  const stub: Api = { __loaded: true, q: queue, getSessionInsights: () => null };
  for (const m of QUEUED) stub[m] = (...a: any[]) => (queue.push([m, a]), m === 'init' ? stub : undefined);
  w.Assist = stub;
  watchWho(script?.dataset.who);
  // First storage access is a synchronous IPC: give it its own task.
  setTimeout(() => {
    sget('vid', 0);
    sget('sid', 0, true);
    setTimeout(() => {
      try {
        boot(queue);
      } catch {
        /* never break the host page */
      }
    });
  });
}

function boot(queue: [string, any[]][]) {
  const w = W as any;

  const src = script?.src || '';
  const base0 = src ? src.slice(0, src.lastIndexOf('/') + 1) : '';
  let initOpts: any = {};
  for (const [m, a] of queue) if (m === 'init') initOpts = merge(initOpts, a[0]);

  const remote = sget<any>('rc', null);
  let cfg: Config = merge(
    defaults(),
    remote && Date.now() - remote.t < 86400000 ? remote.c : {},
    fromScript(script),
    w.AssistConfig,
    initOpts,
  );
  if (!cfg.endpoint) cfg.endpoint = src ? new URL(src).origin : 'http://localhost:7821';
  const warnings = validate(cfg);
  const base = cfg.base || base0 || cfg.endpoint + '/';
  // Exact files, not the directory/origin: the site may self-host us next to its own code.
  const mine = [src.split(/[?#]/)[0], ...Object.values(__CHUNKS__).map((f) => base + f)].filter(Boolean);

  // ---- state ----
  const bus = new Bus();
  let session: Session;
  let capture: Capture | null = null;
  let stopErrors: (() => void) | null = null;
  let stopRoutes: (() => void) | null = null;
  let started = false;
  let dead = false;
  let ownErrors = 0;
  let level = 0;
  const crumbs: Breadcrumb[] = [];
  const errCounts = new Map<string, number>();
  const signals: Signal[] = [];
  const offs: (() => void)[] = [];
  let lastTyping = -1e9;
  let whoSent = '';

  const guard = <F extends (...a: any[]) => any>(fn: F): F =>
    function (this: any, ...a: any[]) {
      if (dead) return;
      try {
        return fn.apply(this, a);
      } catch (e) {
        oops(e);
      }
    } as F;

  function oops(e: unknown) {
    ownErrors++;
    if (cfg.debug) console.warn('[assist]', e);
    if (ownErrors >= 20 && !dead) {
      try {
        batcher.push({ t: 'diag', m: 'self-disabled', n: ownErrors, e: redact(String((e as any)?.message || e), 200) });
        batcher.flush(true);
      } catch {}
      destroy();
    }
  }
  setGuard(guard);
  bus.err = oops;

  const crumb = (k: string, el?: string) => {
    crumbs.push({ k, el, ts: Math.round(now()) });
    if (crumbs.length > 20) crumbs.shift();
  };

  const emit = (e: Ev) => {
    e.ts = Math.round(now() - pvStart);
    batcher.push(e);
  };
  let pvStart = now();

  const frus = new Frustration((s) => {
    signals.push(s);
    if (signals.length > 50) signals.shift();
    emit({ t: 'f', k: s.k, el: s.el, s: s.s, e: s.e, err: s.err });
    crumb('f:' + s.k, s.el);
    bus.emit('frustration', s);
    const sc = frus.score();
    const lv = sc >= 70 ? 2 : sc >= 40 ? 1 : 0;
    if (lv > level) {
      level = lv;
      bus.emit('struggle', { level: lv, score: sc, signal: s });
    } else if (lv < level) level = lv;
  });

  const report = (k: string, m: string, { node, ...x }: Record<string, unknown> = {}) => {
    if (!cfg.features.errors) return;
    const msg = redact(m, 200);
    const fp = errFp(k, msg, String(x.st || x.u || ''));
    const n = (errCounts.get(fp) || 0) + 1;
    errCounts.set(fp, n);
    if (k === 'js' || k === 'rej' || k === 'net' || k === 'con') frus.error(fp);
    crumb('err:' + k, x.el as string);
    bus.emit('error', { k, m: msg, fp, node, ...x });
    if (n === 1) emit({ t: 'err', k, m: msg, fp, ...x, bc: crumbs.slice(-20) });
  };

  const ctx: Ctx = {
    version: VERSION,
    cfg,
    bus,
    get session() {
      return session;
    },
    frus,
    base,
    own: (s = '') => mine.some((m) => s.includes(m)) || (!!cfg.endpoint && s.startsWith(cfg.endpoint) && BRIDGE.test(s.slice(cfg.endpoint.length))),
    send: (e) => emit(e),
    report: (k, m, x) => report(k, m, x),
    load: null as any,
    fp: (el) => fingerprint(el),
    redact,
    guard,
    crumbs: () => crumbs.slice(),
    store: {
      get: (k, d, s) => (session?.storage ? sget(k, d, s) : d),
      set: (k, v, s) => session?.storage && sset(k, v, s),
    },
    lastInput: () => Math.max(lastTyping, capture?.lastTyping() ?? -1e9),
    keyboardMode: () => frus.kb,
    now,
  } as Ctx;
  ctx.load = createLoader(() => ctx, base);

  const gz = createGzip(base, __CHUNKS__.worker);
  const header = () => ({
    sid: session.sid,
    vid: session.vid,
    pid: session.pid,
    site: cfg.site,
    u: pageUrl(location.href),
    dev: device(),
      grp: 'c',
    bot: session.bot ? 1 : 0,
    ver: VERSION,
  });
  let batcher = createBatcher(cfg, (session = createSession(cfg, sget<boolean | null>('consent', null))), header, gz.gzip);

  function pageview() {
    pvStart = now();
    const c = (navigator as any).connection;
    emit({
      t: 'pv',
      u: pageUrl(location.href),
      ti: redact(D.title, 120),
      r: D.referrer ? normUrl(D.referrer) : '',
      vw: innerWidth,
      vh: innerHeight,
      dev: device(),
      ct: c?.effectiveType,
      lang: (D.documentElement.lang || navigator.language || '').slice(0, 5),
    });
  }

  function pageEnd(final: boolean) {
    capture?.summarize();
    bus.emit('summarize');
    const rep = [...errCounts].filter(([, n]) => n > 1);
    if (rep.length) emit({ t: 'errn', a: rep });
    errCounts.clear();
    batcher.flush(final);
  }

  function start() {
    if (started || dead || cfg.disabled) return;
    if (W.top !== W && cfg.frames === 'top') return;
    started = true;
    if (cfg.debug && warnings.length) console.warn('[assist] config', warnings);

    stopErrors = startErrors(ctx, report);
    setTimeout(
      guard(() => {
        if (dead) return;
        capture = startCapture(ctx, emit, crumb, report);
        pageview();
        setTimeout(guard(startRest));
      }),
    );
  }

  function startRest() {
    if (dead) return;
    capture!.navSignals();
    ctx.load('analytics').catch(() => {});

    stopRoutes = watchRoutes(
      guard(() => {
        pageEnd(false);
        batcher.newPage();
        session.pid = rid();
        touch(session);
        pageview();
        capture!.navSignals();
        bus.emit('route', location.href);
      }),
    );
    offs.push(
      on(D, 'visibilitychange', () => {
        if (D.visibilityState === 'hidden') pageEnd(true);
        else touch(session);
      }),
      on(W, 'pagehide', () => {
        emit({ t: 'bye' });
        pageEnd(true);
      }),
      on(D, 'keydown', () => (lastTyping = now())),
    );
    // Lets the dashboard tell an open-but-idle tab from a closed one.
    const hb = setInterval(guard(() => D.visibilityState === 'visible' && emit({ t: 'hb' })), 30000);
    offs.push(() => clearInterval(hb));

    // Deferred work: never during initial load.
    const later = () =>
      idle(
        guard(() => {
          fetchRemote();
          const F = cfg.features;
          const want = new Set(cfg.preload);
          if (session.recording && F.vitals) want.add('vitals');
          if (session.recording && F.snapshots) want.add('snapshot');
          if (session.recording && F.replay) want.add('replay');
          if (sget(HEAT, '', true)) want.add('heatmap');
          // One chunk per idle callback: each import evaluates in its own short task.
          for (const n of want) idle(() => ctx.load(n).catch(() => {}), 6000);
        }),
        4000,
      );
    if (D.readyState === 'complete') later();
    else on(W, 'load', later, { once: true });
  }

  function fetchRemote() {
    if (!cfg.remoteConfig || !cfg.endpoint) return;
    const c = sget<any>('rc', null);
    if (c && Date.now() - c.t < 300000) return;
    fetch(`${cfg.endpoint}/config?site=${encodeURIComponent(cfg.site)}&k=${encodeURIComponent(cfg.key)}`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        guard((rc: any) => {
          if (!rc) return;
          if (session.storage) sset('rc', { t: Date.now(), c: rc });
          applyConfig(rc);
        }),
      )
      .catch(() => {});
  }

  function applyConfig(o: any) {
    const next = merge(cfg, o);
    validate(next);
    Object.assign(cfg, next);
    if (cfg.disabled) return destroy();
    bus.emit('config', cfg);
  }

  function destroy() {
    if (dead) return;
    try {
      pageEnd(true);
    } catch {}
    dead = true;
    capture?.stop();
    stopErrors?.();
    stopRoutes?.();
    offs.forEach((f) => f());
    bus.emit('destroy');
    bus.clear();
    api.__loaded = false;
  }

  const api: Api = {
    __loaded: true,
    version: VERSION,
    config: cfg,
    ctx,
    init(opts: any = {}) {
      if (!started) {
        Object.assign(cfg, merge(cfg, opts));
        validate(cfg);
        start();
      } else applyConfig(opts);
      return api;
    },
    track(name: string, props?: Record<string, unknown>) {
      const p: Record<string, unknown> = {};
      for (const k in props || {}) {
        const v = (props as any)[k];
        p[k] = typeof v === 'string' ? redact(v, 120) : typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
      }
      emit({ t: 'cu', n: redact(String(name), 60), p });
    },
    /**
     * Name the current visitor. The script does this from `data-who` on its own tag.
     * The id stays an id: a bare email is kept as their email, never as the id.
     */
    identify(user?: string | { id?: string; name?: string; email?: string }, traits?: { name?: string; email?: string }) {
      const o = user && typeof user === 'object' ? user : {};
      const x = traits && typeof traits === 'object' ? traits : {};
      let id = (typeof user === 'string' ? user : String(o.id || '')).trim();
      let email = String(o.email || x.email || '').trim();
      const name = String(o.name || x.name || '').trim().slice(0, 80);
      if (id.includes('@')) (email = email || id), (id = '');
      id = id.slice(0, 64);
      email = email.slice(0, 120);
      const prev = session.vid;
      if (id && id !== prev) {
        session.vid = id;
        if (session.storage) sset('vid', id);
      }
      if (!name && !email && !(id && id !== prev)) return;
      // Once per page load: stored data can be erased on the dashboard, so the tab must not remember it sent this.
      const sig = [id || prev, name, email].join('\n');
      if (whoSent === sig) return;
      whoSent = sig;
      emit({ t: 'who', ...(name ? { n: name } : {}), ...(email ? { em: email } : {}), ...(id && id !== prev ? { al: prev } : {}) });
    },
    consent(granted: boolean) {
      sset('consent', undefined);
      batcher.stop();
      session = createSession(cfg, !!granted);
      if (session.storage) sset('consent', !!granted);
      batcher = createBatcher(cfg, session, header, gz.gzip);
      if (granted && started) pageview();
      bus.emit('consent', granted);
    },
    on: (type: string, fn: (d: any) => void) => bus.on(type, fn),
    getSessionInsights: () => ({
      score: frus.score(),
      level,
      hotspots: frus.hotspots(),
      signals: signals.slice(-20),
      errors: [...errCounts].map(([fp, n]) => ({ fp, n })),
      session: { sid: session.sid, pid: session.pid, recording: session.recording },
      stats: batcher.stats(),
    }),
    destroy,
    q: [],
  };
  // watchWho stored the tag and any sign-in body on the stub. Keep both; this object replaces it.
  api._ws = w.Assist._ws;
  api._wb = w.Assist._wb;
  w.Assist = api;

  setTimeout(
    guard(() => {
      start();
      // replay queued calls (init already merged)
      for (const [m, a] of queue.splice(0)) if (m !== 'init' && typeof api[m] === 'function') guard(api[m])(...a);
    }),
  );
}

try {
  install();
} catch (e) {
  /* never break the host page */
}
