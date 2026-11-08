import type { Ctx } from '../../core/types';
import { isSensitive, shape } from '../../privacy/redactor';
import { D, W, elOf, idle, now, on, sset } from '../../core/util';
import { FIELD, device, formOf, ignored } from '../../core/dom';
import { scanUiErrors } from './uierrors';
import { applyWho } from '../../core/who';
const KEY_ELS = 'form,h1,h2,[type=submit],button[class*=primary],.btn-primary,[role=alert],[data-assist-track]';
const CTA = 'button,[role=button],a[href],[type=submit]';

interface FieldRec {
  focusT: number;
  firstT: number;
  cor: number;
  err: number;
  vi: number;
}
interface FormRec {
  started: boolean;
  submitted: boolean;
  last: string;
  err: number;
}

/**
 * Page-level analytics loaded right after start: form & field metrics,
 * submit outcome, abandonment, idle-on-incomplete, leave intent, hover
 * dwell & hesitation, scroll depth bands, element attention, funnels, zoom.
 * Emits summaries when core fires `summarize` (page end / route change).
 */
export default function install(ctx: Ctx) {
  const assist = (W as any).Assist;
  if (assist) {
    assist._who = applyWho;
    if (assist._wb) (applyWho(assist._wb), (assist._wb = 0));
  }
  const { cfg, frus, bus } = ctx;
  const F = cfg.features;
  const send = ctx.send;
  const skip = (el: Element | null) => ignored(cfg, el);
  const offs: (() => void)[] = [];

  const fields = new WeakMap<Element, FieldRec>();
  const forms = new Map<Element, FormRec>();
  const formRec = (f: Element) => {
    let r = forms.get(f);
    if (!r) forms.set(f, (r = { started: false, submitted: false, last: '', err: 0 }));
    return r;
  };
  let visitIdx = 0;
  let lastAct = now();
  let pendingSubmit: { form: string; t: number } | null = null;
  const act = () => (lastAct = now());

  // ---------- fields ----------
  offs.push(
    on(D, 'focusin', (e: FocusEvent) => {
      const el = elOf(e);
      if (!el || !el.matches(FIELD) || skip(el)) return;
      fields.set(el, { focusT: now(), firstT: 0, cor: 0, err: fields.get(el)?.err || 0, vi: visitIdx++ });
      bus.emit('focus', el);
    }),
    on(D, 'focusout', (e: FocusEvent) => {
      const el = elOf(e);
      const r = el && fields.get(el);
      if (!el || !r || !r.focusT) return;
      const v = (el as HTMLInputElement).value || '';
      const f = formOf(el);
      if (F.forms)
        send({
          t: 'fld',
          el: ctx.fp(el),
          f: f ? ctx.fp(f) : undefined,
          hes: r.firstT ? Math.round(r.firstT - r.focusT) : -1,
          dur: Math.round(now() - r.focusT),
          cor: r.cor,
          err: r.err,
          emp: v ? 0 : 1,
          ...(isSensitive(el) ? {} : shape(v)),
          oi: f && (f as HTMLFormElement).elements ? [...(f as HTMLFormElement).elements].indexOf(el) : -1,
          vi: r.vi,
          req: (el as HTMLInputElement).required ? 1 : 0,
        });
      r.focusT = 0;
      bus.emit('blur', el);
    }),
    on(D, 'input', (e: InputEvent) => {
      const el = elOf(e);
      if (!el || skip(el)) return;
      act();
      const r = fields.get(el);
      if (r) {
        if (!r.firstT) r.firstT = now();
        if ((e.inputType || '').startsWith('delete')) r.cor++;
      }
      const f = formOf(el);
      if (!f) return;
      const fr = formRec(f);
      fr.last = ctx.fp(el);
      if (!fr.started) {
        fr.started = true;
        if (F.forms) send({ t: 'frm', el: ctx.fp(f), a: 'start' });
      }
    }),
    on(D, 'invalid', (e: Event) => {
      const el = e.target as Element;
      const r = fields.get(el);
      if (r) r.err++;
      const f = formOf(el);
      if (f) formRec(f).err++;
      if (pendingSubmit && now() - pendingSubmit.t < 500) {
        frus.submitInvalid(pendingSubmit.form);
        pendingSubmit = null;
      }
    }),
    on(D, 'submit', (e: SubmitEvent) => {
      const f = e.target as HTMLFormElement;
      if (skip(f)) return;
      const fr = formRec(f);
      fr.submitted = true;
      const fp = ctx.fp(f);
      const e0 = fr.err;
      sset('sub', Date.now(), true);
      if (F.forms) send({ t: 'frm', el: fp, a: 'submit' });
      setTimeout(() => {
        const failed = fr.err > e0;
        if (failed) {
          fr.submitted = false;
          frus.submitInvalid(fp);
        }
        if (F.forms) send({ t: 'frm', el: fp, a: failed ? 'fail' : 'ok' });
      }, 3000);
    }),
    on(D, 'keydown', act),
    on(D, 'paste', act),
  );
  bus.on('click', ({ el }: { el: Element }) => {
    act();
    if (el.matches('[type=submit],button:not([type])') && formOf(el)) pendingSubmit = { form: ctx.fp(formOf(el)!), t: now() };
    funnelClick(el);
  });
  bus.on('error', (x: { k: string; node?: Element }) => {
    if (x.k !== 'ui' || !x.node) return;
    const f = formOf(x.node);
    if (f) formRec(f).err++;
    const r = fields.get(x.node);
    if (r) r.err++;
    if (pendingSubmit && now() - pendingSubmit.t < 1500) {
      frus.submitInvalid(pendingSubmit.form);
      pendingSubmit = null;
    }
  });

  // ---------- leave intent / idle on incomplete ----------
  const dirtyForm = () => {
    for (const [f, r] of forms) if (r.started && !r.submitted && f.isConnected) return f;
    return null;
  };
  const leave = () => {
    const f = dirtyForm();
    if (f) {
      frus.signal('leave', ctx.fp(f));
      bus.emit('leaveIntent', f);
    }
  };
  offs.push(on(D, 'mouseout', (e: MouseEvent) => !e.relatedTarget && e.clientY <= 0 && leave()));

  const IDLE_MS = 20000;
  let idleTimer: any = 0;
  const armIdle = (ms: number): any =>
    (idleTimer = setTimeout(() => {
      const since = now() - lastAct;
      if (since < IDLE_MS) return armIdle(IDLE_MS - since);
      const f = dirtyForm();
      const empty =
        f &&
        [...f.querySelectorAll('[required],[aria-required=true]')].find(
          (x) => !(x as HTMLInputElement).value && x.matches(FIELD),
        );
      if (f && empty) {
        frus.signal('idle', ctx.fp(empty));
        bus.emit('idleForm', { form: f, field: empty });
      }
      lastAct = now();
      armIdle(IDLE_MS);
    }, ms));
  armIdle(IDLE_MS);
  offs.push(() => clearTimeout(idleTimer));

  // ---------- hover dwell + hesitation ----------
  const hover = new Map<string, number>();
  let dEl: Element | null = null,
    dT = 0,
    dX = 0,
    dY = 0,
    hTimer: any = 0;
  const flushDwell = () => {
    if (dEl && dT && now() - dT >= 1000 && !skip(dEl)) {
      const k = ctx.fp(dEl.closest(CTA) || dEl);
      hover.set(k, (hover.get(k) || 0) + (now() - dT));
    }
    dT = 0;
  };
  bus.on('move', (e: MouseEvent) => {
    act();
    if (e.target !== dEl || Math.hypot(e.clientX - dX, e.clientY - dY) > 10) {
      flushDwell();
      dEl = e.target as Element;
      dX = e.clientX;
      dY = e.clientY;
      dT = now();
    }
  });
  offs.push(
    on(D, 'pointerover', (e: PointerEvent) => {
      clearTimeout(hTimer);
      if (e.pointerType !== 'mouse') return;
      const el = elOf(e)?.closest(CTA);
      if (el && !skip(el)) hTimer = setTimeout(() => frus.signal('hover', ctx.fp(el)), 6000);
    }),
    on(D, 'pointerdown', () => clearTimeout(hTimer)),
  );

  // ---------- scroll depth bands ----------
  const bands = new Array(10).fill(0);
  let maxDepth = 0,
    band = 0,
    bandT = now(),
    docH = 1;
  const depth = () => {
    const t = now();
    const d = Math.min(1, (scrollY + innerHeight) / docH);
    if (d > maxDepth) maxDepth = d;
    bands[band] += t - bandT;
    band = Math.max(0, Math.min(9, Math.floor(d * 10 - 1e-6)));
    bandT = t;
  };
  bus.on('scroll', () => {
    act();
    depth();
  });
  if ('ResizeObserver' in W) {
    const ro = new ResizeObserver((en) => (docH = Math.max(1, en[0].contentRect.height)));
    ro.observe(D.documentElement);
    offs.push(() => ro.disconnect());
  }

  // ---------- attention: visible time of key elements ----------
  const vis = new Map<Element, { fp: string; ms: number; since: number }>();
  let io: IntersectionObserver | null = null;
  function observeKeys() {
    if (!F.heatmaps || !('IntersectionObserver' in W)) return;
    io ||= new IntersectionObserver(
      (en) => {
        const t = now();
        for (const x of en) {
          const v = vis.get(x.target);
          if (!v) continue;
          if (x.isIntersecting) v.since = t;
          else if (v.since) {
            v.ms += t - v.since;
            v.since = 0;
          }
        }
      },
      { threshold: 0.5 },
    );
    for (const el of D.querySelectorAll(KEY_ELS)) {
      if (vis.size >= 30) break;
      if (vis.has(el) || skip(el)) continue;
      vis.set(el, { fp: ctx.fp(el), ms: 0, since: 0 });
      io.observe(el);
    }
  }
  bus.on('dom', (nodes: Element[]) => {
    if (F.errors) scanUiErrors(ctx, nodes);
    observeKeys();
  });

  // ---------- pinch zoom on a field ----------
  const vv = (W as any).visualViewport;
  if (vv)
    offs.push(
      on(vv, 'resize', () => {
        const a = D.activeElement;
        if (vv.scale > 1.15 && a && a.matches(FIELD)) frus.signal('zoom', ctx.fp(a), { s: +vv.scale.toFixed(2) });
      }),
    );

  // ---------- funnels ----------
  const glob = (p: string, u: string) =>
    new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(u);
  function hit(n: string, i: number) {
    const k = 'fn:' + n;
    const done = ctx.store.get<number[]>(k, [], true);
    if (done.includes(i)) return;
    done.push(i);
    ctx.store.set(k, done, true);
    send({ t: 'fn', n, i });
  }
  function funnelPage() {
    for (const f of cfg.funnels) f.steps.forEach((s, i) => s.startsWith('/') && glob(s, location.pathname) && hit(f.name, i));
  }
  function funnelClick(el: Element) {
    for (const f of cfg.funnels)
      f.steps.forEach((s, i) => {
        if (s.startsWith('/')) return;
        try {
          if (el.closest(s)) hit(f.name, i);
        } catch {}
      });
  }

  // ---------- summaries ----------
  bus.on('summarize', () => {
    flushDwell();
    depth();
    if (F.heatmaps) {
      if (hover.size) send({ t: 'hv', a: [...hover].map(([k, ms]) => [k, Math.round(ms)]) });
      hover.clear();
      const t = now();
      const va: [string, number][] = [];
      for (const v of vis.values()) {
        const ms = v.ms + (v.since ? t - v.since : 0);
        if (v.since) v.since = t;
        v.ms = 0;
        if (ms > 100) va.push([v.fp, Math.round(ms)]);
      }
      if (va.length) send({ t: 'vis', a: va });
      send({ t: 'sd', max: Math.round(maxDepth * 100), b: bands.map(Math.round), h: Math.round(docH), dev: device() });
      bands.fill(0);
    }
    for (const [f, r] of forms)
      if (r.started && !r.submitted) {
        if (F.forms) send({ t: 'frm', el: ctx.fp(f), a: 'abandon', last: r.last });
        r.started = false;
      }
  });

  const reset = () => {
    maxDepth = 0;
    vis.clear();
    io?.disconnect();
    io = null;
    forms.clear();
    idle(() => {
      docH = Math.max(1, D.documentElement.scrollHeight);
      observeKeys();
      depth();
    });
    funnelPage();
  };
  bus.on('route', reset);
  bus.on('destroy', () => offs.forEach((f) => f()));
  reset();

  return { dirtyForm, leave };
}
