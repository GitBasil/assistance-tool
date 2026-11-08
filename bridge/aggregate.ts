import type { StoredEvent } from './store';

const CLICK_CAP = 20_000;
const SCROLL_CAP = 5_000;
const TIMELINE_CAP = 400;
const VITAL_CAP = 2_000;

export interface Click {
  el: string;
  rx: number;
  ry: number;
  x: number;
  y: number;
  dev: string;
}
/** A moment in one session's recording. `ts` is that page view's own clock. */
interface Moment {
  sid: string;
  pid: string;
  ts: number;
}
interface PageAgg {
  u: string;
  views: number;
  sessions: Set<string>;
  clicks: Click[];
  moves: Map<string, number>;
  scroll: { max: number; dev: string }[];
  attention: Map<string, number>;
  hover: Map<string, number>;
  frus: Map<string, { score: number; n: number; kinds: Record<string, number>; at?: Moment }>;
  /** The latest event on this page, so a report row can open its recording. */
  at?: Moment;
  frusTotal: number;
  errors: number;
  vitals: Map<string, Vital[]>;
}
/** One measurement: value (CLS ×1000), device, and where it happened. */
interface Vital {
  v: number;
  dev: string;
  at: Moment;
}
interface VitalStat {
  p75: number | null;
  n: number;
  rating: string;
  /** Shares of samples rated good / needs improvement / poor, in %. */
  good: number;
  ni: number;
  poor: number;
  /** The slowest sample, to open its recording. */
  slow?: Moment;
}
interface ErrAgg {
  fp: string;
  k: string;
  m: string;
  n: number;
  sessions: Set<string>;
  pages: Set<string>;
  st?: string;
  ru?: string;
  el?: string;
  first: number;
  last: number;
  bc?: unknown;
  at?: Moment;
}
interface FieldAgg {
  el: string;
  u: string;
  n: number;
  hes: number;
  hesN: number;
  dur: number;
  cor: number;
  err: number;
  emp: number;
  req: number;
  lastBeforeAbandon: number;
  at?: Moment;
}
interface FormAgg {
  el: string;
  u: string;
  start: number;
  submit: number;
  ok: number;
  fail: number;
  abandon: number;
  at?: Moment;
}
interface RecPt {
  pid: string;
  ts: number;
  x: number;
  y: number;
}
interface RecPage {
  pid: string;
  u: string;
  vw: number;
  vh: number;
  dw: number;
  dh: number;
  maxTs: number;
}
interface Rec {
  pages: RecPage[];
  moves: RecPt[];
  scrolls: RecPt[];
  clicks: RecPt[];
  /** Field values as typed (`v`) or toggled (`c`), keyed by element fingerprint. */
  inputs: { pid: string; ts: number; el: string; v?: string; c?: boolean }[];
  /** Scroll positions of inner panels and dialogs, keyed by element fingerprint. */
  boxScrolls: { pid: string; ts: number; el: string; x: number; y: number }[];
  /** Page states over time: from `ts` on, the page looked like frame `h`. */
  frames: { pid: string; ts: number; h: string }[];
}
interface Sess {
  sid: string;
  vid: string;
  site: string;
  start: number;
  end: number;
  grp: 'h' | 'c';
  dev: string;
  pages: string[];
  frus: number;
  errors: number;
  clicks: number;
  coachShown: number;
  formsStarted: number;
  formsOk: number;
  formMs: number[];
  formStart: Map<string, number>;
  timeline: Record<string, unknown>[];
  replay: Rec;
  /** Arrival time of the page's unload beacon. A later batch (back from bfcache) makes the session live again. */
  left: number;
  /** Recent context signals (see CTX), kept until corroborated or stale. */
  fev?: { g: string; at: number; ok: boolean; book: () => void }[];
}

/**
 * Frustration needs evidence. Rage / dead / error clicks, disabled-control retries,
 * field thrash and validation loops are direct evidence. The signals below are
 * everyday behaviour (browsing back and forth, resting the pointer on a row,
 * reloading) and score nothing alone: they count only when direct evidence, or
 * context signals from three different groups, land within CTX_WINDOW. [group, weight]
 */
const CTX: Record<string, [string, number]> = {
  uturn: ['n', 10], loop: ['n', 15], refresh: ['n', 20], qback: ['n', 12],
  cursor: ['m', 8], hover: ['m', 5], wander: ['m', 8], fake: ['m', 10],
  idle: ['f', 10], leave: ['f', 10], zoom: ['f', 8], paste: ['f', 8], tabcycle: ['f', 10],
};
const CTX_WINDOW = 20_000;

/** A session is live while its tab is open: the client heartbeats every 30s while visible. */
export const LIVE_MS = 75_000;
const isLive = (x: Sess, now = Date.now()) => x.left < x.end && now - x.end < LIVE_MS;
interface TourAgg {
  id: string;
  start: number;
  done: number;
  exit: number;
  steps: Map<number, number>;
  ms: number[];
  exitAt: Map<number, number>;
}
interface Bucket {
  sessions: Set<string>;
  frus: number;
  errors: number;
  pv: number;
}

interface Who {
  name: string;
  email: string;
  vids: Set<string>;
}

interface SiteAgg {
  pages: Map<string, PageAgg>;
  sessions: Map<string, Sess>;
  errors: Map<string, ErrAgg>;
  fields: Map<string, FieldAgg>;
  forms: Map<string, FormAgg>;
  funnels: Map<string, Map<number, { ids: Set<string>; at: Moment }>>;
  tours: Map<string, TourAgg>;
  coach: Map<string, { h: number; c: number }>;
  actions: Map<string, { ok: number; blocked: number }>;
  custom: Map<string, number>;
  /** Every known visitor id points at the person it belongs to (aliases share one). */
  who: Map<string, Who>;
  days: Map<string, Bucket>;
  /** Same as `days`, per UTC hour ("2026-11-05T13"), for short ranges. */
  hours: Map<string, Bucket>;
  autocomplete: { show: number; accept: number };
  asks: number;
  longTasks: { n: number; ms: number };
  bots: Set<string>;
  diag: number;
}

const newSite = (): SiteAgg => ({
  pages: new Map(),
  sessions: new Map(),
  errors: new Map(),
  fields: new Map(),
  forms: new Map(),
  funnels: new Map(),
  tours: new Map(),
  coach: new Map(),
  actions: new Map(),
  custom: new Map(),
  who: new Map(),
  days: new Map(),
  hours: new Map(),
  autocomplete: { show: 0, accept: 0 },
  asks: 0,
  longTasks: { n: 0, ms: 0 },
  bots: new Set(),
  diag: 0,
});

const inc = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) || 0) + by);
const pct = (a: number[], p: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const rate = (n: string, v: number | null) => {
  const g = VITAL_GOOD[n];
  return v == null || !g ? '' : v <= g[0] ? 'good' : v <= g[1] ? 'ni' : 'poor';
};
function vitalStat(n: string, a: Vital[]): VitalStat {
  const p75 = pct(a.map((x) => x.v), 75);
  const g = VITAL_GOOD[n];
  let good = 0;
  let poor = 0;
  let slow: Vital | undefined;
  for (const x of a) {
    if (g && x.v <= g[0]) good++;
    else if (g && x.v > g[1]) poor++;
    if (!slow || x.v > slow.v) slow = x;
  }
  const share = (k: number) => (a.length ? Math.round((k / a.length) * 100) : 0);
  return { p75, n: a.length, rating: rate(n, p75), good: share(good), poor: share(poor), ni: a.length ? 100 - share(good) - share(poor) : 0, slow: slow?.at };
}
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const top = <T>(arr: T[], by: (x: T) => number, n = 50) => arr.sort((a, b) => by(b) - by(a)).slice(0, n);
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clamp = (n: number, hi: number) => Math.max(0, Math.min(hi, Math.round(n)));

const PAGE_CAP = 40;

function dropPid<T extends { pid?: unknown }>(arr: T[], pid: string) {
  let w = 0;
  for (const x of arr) if (x.pid !== pid) arr[w++] = x;
  arr.length = w;
}

/** Keep the newest half once the cap is passed, so a long session stays bounded. */
function pushPt(arr: RecPt[], pt: RecPt, cap: number) {
  arr.push(pt);
  if (arr.length <= cap) return;
  let w = 0;
  for (let i = 0; i < arr.length; i += 2) arr[w++] = arr[i];
  arr.length = w;
}

function touchRec(ss: Sess, e: StoredEvent): RecPage {
  const pid = str(e.pid, 40) || '_';
  let pg = ss.replay.pages.find((p) => p.pid === pid);
  if (!pg) {
    // Past the cap, forget the oldest page so the page the visitor is on now still records.
    // Folding new pages into the last one left the replay stuck on an earlier screen.
    while (ss.replay.pages.length >= PAGE_CAP) {
      const old = ss.replay.pages.shift()!;
      const r = ss.replay;
      dropPid(r.moves, old.pid);
      dropPid(r.scrolls, old.pid);
      dropPid(r.clicks, old.pid);
      dropPid(r.inputs, old.pid);
      dropPid(r.boxScrolls, old.pid);
      dropPid(r.frames, old.pid);
      dropPid(ss.timeline, old.pid);
    }
    ss.replay.pages.push((pg = { pid, u: str(e.u, 400), vw: 0, vh: 0, dw: 0, dh: 0, maxTs: 0 }));
  }
  const ts = num(e.ts);
  if (ts > pg.maxTs) pg.maxTs = ts;
  return pg;
}

const pageDur = (p: RecPage) => Math.max(800, p.maxTs + 400);
function recordedMs(r: Rec) {
  if (!r.pages.length || !(r.moves.length || r.scrolls.length || r.clicks.length || r.inputs.length || r.boxScrolls.length)) return 0;
  return r.pages.reduce((s, p) => s + pageDur(p), 0);
}

/** Thresholds from web.dev: good / needs-improvement boundaries. */
const VITAL_GOOD: Record<string, [number, number]> = { LCP: [2500, 4000], INP: [200, 500], CLS: [100, 250], FCP: [1800, 3000], TTFB: [800, 1800] };

/**
 * In-memory aggregates rebuilt from the NDJSON log at startup and updated per
 * event. Everything is treated as hostile input: strings are length-capped and
 * numbers coerced; bots are kept out of every aggregate.
 */
export class Aggregator {
  sites = new Map<string, SiteAgg>();

  site(s: string) {
    let a = this.sites.get(s);
    if (!a) this.sites.set(s, (a = newSite()));
    return a;
  }

  private page(s: SiteAgg, u: string) {
    let p = s.pages.get(u);
    if (!p)
      s.pages.set(
        u,
        (p = { u, views: 0, sessions: new Set(), clicks: [], moves: new Map(), scroll: [], attention: new Map(), hover: new Map(), frus: new Map(), frusTotal: 0, errors: 0, vitals: new Map() }),
      );
    return p;
  }

  private sess(s: SiteAgg, e: StoredEvent) {
    let x = s.sessions.get(e.sid);
    if (!x)
      s.sessions.set(
        e.sid,
        (x = { sid: e.sid, vid: e.vid, site: e.site, start: e.at, end: e.at, grp: e.grp === 'h' ? 'h' : 'c', dev: e.dev, pages: [], frus: 0, errors: 0, clicks: 0, coachShown: 0, formsStarted: 0, formsOk: 0, formMs: [], formStart: new Map(), timeline: [], replay: { pages: [], moves: [], scrolls: [], clicks: [], inputs: [], boxScrolls: [], frames: [] }, left: -1 }),
      );
    x.end = Math.max(x.end, e.at);
    if (e.t === 'bye') x.left = e.at;
    return x;
  }

  /** The event's day and hour buckets; every counter is bumped on both. */
  private bucketsOf(s: SiteAgg, at: number) {
    const iso = new Date(at).toISOString();
    const get = (m: Map<string, Bucket>, k: string) => {
      let x = m.get(k);
      if (!x) m.set(k, (x = { sessions: new Set(), frus: 0, errors: 0, pv: 0 }));
      return x;
    };
    return [get(s.days, iso.slice(0, 10)), get(s.hours, iso.slice(0, 13))];
  }

  /** The person record for a visitor id, created on first sight. */
  private touchWho(s: SiteAgg, vid: string): Who {
    let w = s.who.get(vid);
    if (!w) s.who.set(vid, (w = { name: '', email: '', vids: new Set([vid]) }));
    else w.vids.add(vid);
    return w;
  }

  /**
   * Attach a name or email, and fold an earlier anonymous id into the same person.
   * A field is changed only when the event carries it, so a later id-only call
   * doesn't wipe a name already stored.
   */
  private noteWho(s: SiteAgg, vid: string, name: string | undefined, email: string | undefined, alias: string) {
    if (!vid) return;
    let w = this.touchWho(s, vid);
    if (alias && alias !== vid) {
      const old = this.touchWho(s, alias);
      if (old !== w) {
        if (!w.name) w.name = old.name;
        if (!w.email) w.email = old.email;
        for (const v of old.vids) (w.vids.add(v), s.who.set(v, w));
      }
    }
    if (name !== undefined) w.name = name;
    if (email !== undefined) w.email = email;
  }

  /** Every visitor id that is the same person, or just this one when nobody identified them. */
  vidsOf(site: string, vid: string): string[] {
    return [...(this.site(site).who.get(vid)?.vids ?? [vid])];
  }

  add(e: StoredEvent) {
    if (!e || typeof e.t !== 'string' || typeof e.sid !== 'string') return;
    const s = this.site(str(e.site, 120) || 'unknown');
    if (e.t === 'who') {
      if (!e.bot) this.noteWho(s, str(e.vid, 64), typeof e.n === 'string' ? str(e.n, 80) : undefined, typeof e.em === 'string' ? str(e.em, 120) : undefined, str(e.al, 64));
      return;
    }
    if (e.bot) {
      s.bots.add(e.sid);
      return;
    }
    const u = str(e.u, 400);
    const p = this.page(s, u);
    const ss = this.sess(s, e);
    const day = this.bucketsOf(s, e.at);
    for (const b of day) b.sessions.add(e.sid);
    p.sessions.add(e.sid);
    const pg = touchRec(ss, e);
    const here = (): Moment => ({ sid: str(e.sid, 40), pid: pg.pid, ts: num(e.ts) });
    p.at = here();
    const tl = (o: Record<string, unknown>) => ss.timeline.length < TIMELINE_CAP && ss.timeline.push({ at: e.at, ts: num(e.ts), pid: pg.pid, u, ...o });

    switch (e.t) {
      case 'pv':
        p.views++;
        for (const b of day) b.pv++;
        if (ss.pages[ss.pages.length - 1] !== u) ss.pages.push(u);
        if (num(e.vw)) pg.vw = clamp(num(e.vw), 4000);
        if (num(e.vh)) pg.vh = clamp(num(e.vh), 4000);
        pg.u = u;
        tl({ t: 'pv', ti: str(e.ti, 120) });
        break;
      case 'c': {
        ss.clicks++;
        if (p.clicks.length >= CLICK_CAP) p.clicks.splice(0, p.clicks.length - CLICK_CAP + 1);
        const x = clamp(num(e.x), 30000);
        const y = clamp(num(e.y), 60000);
        p.clicks.push({ el: str(e.el, 400), rx: num(e.rx), ry: num(e.ry), x, y, dev: str(e.dev, 2) });
        pushPt(ss.replay.clicks, { pid: pg.pid, ts: num(e.ts), x, y }, 2000);
        tl({ t: 'c', el: str(e.el, 400) });
        break;
      }
      case 'rp': {
        const k = str(e.k, 2);
        if (k === 'z') {
          if (num(e.w)) pg.vw = clamp(num(e.w), 4000);
          if (num(e.h)) pg.vh = clamp(num(e.h), 4000);
          if (num(e.dw)) pg.dw = clamp(num(e.dw), 20000);
          if (num(e.dh)) pg.dh = clamp(num(e.dh), 60000);
        } else if (k === 's' && typeof e.el === 'string') {
          const bs = ss.replay.boxScrolls;
          bs.push({ pid: pg.pid, ts: num(e.ts), el: str(e.el, 400), x: clamp(num(e.x), 30000), y: clamp(num(e.y), 60000) });
          if (bs.length > 3000) bs.shift();
        } else if (k === 's') {
          pushPt(ss.replay.scrolls, { pid: pg.pid, ts: num(e.ts), x: clamp(num(e.x), 30000), y: clamp(num(e.y), 60000) }, 2400);
        } else if (k === 'i' && typeof e.el === 'string') {
          const ins = ss.replay.inputs;
          // Not thinned like pointer samples: dropping one would show a wrong value. Oldest go first.
          ins.push({ pid: pg.pid, ts: num(e.ts), el: str(e.el, 400), ...(typeof e.c === 'boolean' ? { c: e.c } : { v: str(e.v, 2000) }) });
          if (ins.length > 3000) ins.shift();
        } else if (k === 'm' && Array.isArray(e.p)) {
          const raw = (e.p as unknown[]).slice(0, 240);
          const t0 = num(e.ts) - num(e.o);
          for (let i = 0; i + 2 < raw.length; i += 3)
            pushPt(ss.replay.moves, { pid: pg.pid, ts: Math.max(0, Math.round(t0 + num(raw[i]))), x: clamp(num(raw[i + 1]), 30000), y: clamp(num(raw[i + 2]), 60000) }, 7200);
        }
        break;
      }
      case 'mv':
        if (Array.isArray(e.g))
          for (const g of (e.g as unknown[]).slice(0, 5000)) {
            if (!Array.isArray(g)) continue;
            inc(p.moves, `${num(g[0])}|${num(g[1])}|${num(e.w)}|${str(e.dev, 2)}`, num(g[2]));
          }
        break;
      case 'sd':
        if (p.scroll.length >= SCROLL_CAP) p.scroll.shift();
        p.scroll.push({ max: Math.max(0, Math.min(100, num(e.max))), dev: str(e.dev, 2) });
        break;
      case 'vis':
      case 'hv':
        if (Array.isArray(e.a))
          for (const [fp, ms] of (e.a as unknown[]).slice(0, 500) as [unknown, unknown][]) inc(e.t === 'vis' ? p.attention : p.hover, str(fp, 400), num(ms));
        break;
      case 'f': {
        const el = str(e.el, 400) || '(page)';
        const k = str(e.k, 20);
        const c = CTX[k];
        const sc = c ? c[1] : num(e.s) || 1;
        const at = here();
        // Books the signal into the page / session / day totals.
        const book = () => {
          let f = p.frus.get(el);
          if (!f) p.frus.set(el, (f = { score: 0, n: 0, kinds: {} }));
          f.score += sc;
          f.n++;
          f.kinds[k] = (f.kinds[k] || 0) + 1;
          f.at = at;
          p.frusTotal += sc;
          ss.frus += sc;
          for (const b of day) b.frus += sc;
        };
        const cur = { g: c ? c[0] : '', at: e.at, ok: false, book };
        const win = (ss.fev = (ss.fev || []).filter((x) => e.at - x.at < CTX_WINDOW));
        win.push(cur);
        if (win.length > 50) win.shift();
        // Direct evidence counts at once and vouches for context signals in the window; context signals
        // also vouch for each other, but only when three different groups show up together.
        const direct = win.some((y) => !y.g);
        for (const x of win) {
          if (x.ok || (x.g && !direct && new Set(win.map((y) => y.g).filter((g) => g && g !== x.g)).size < 2)) continue;
          x.ok = true;
          x.book();
        }
        tl({ t: 'f', k, el, ...(cur.ok ? {} : { hint: 1 }) });
        break;
      }
      case 'err': {
        // Older clients read CSS-in-JS <style> text as on-screen errors (".x:invalid{...}"): that's code, not a message.
        if (e.k === 'ui' && /^[^{}]{0,200}\{[^{}]*:[^{}]*\}/.test(str(e.m, 300))) break;
        const fp = str(e.fp, 40);
        let x = s.errors.get(fp);
        if (!x) s.errors.set(fp, (x = { fp, k: str(e.k, 8), m: str(e.m, 300), n: 0, sessions: new Set(), pages: new Set(), first: e.at, last: e.at }));
        x.n++;
        x.sessions.add(e.sid);
        x.pages.add(u);
        x.last = e.at;
        x.st = str(e.st, 300) || x.st;
        x.ru = str(e.ru, 400) || x.ru;
        x.el = str(e.el, 400) || x.el;
        x.at = here();
        if (Array.isArray(e.bc)) x.bc = (e.bc as unknown[]).slice(-20);
        p.errors++;
        ss.errors++;
        for (const b of day) b.errors++;
        tl({ t: 'err', k: x.k, m: x.m });
        break;
      }
      case 'errn':
        if (Array.isArray(e.a))
          for (const [fp, n] of e.a as [unknown, unknown][]) {
            const x = s.errors.get(str(fp, 40));
            if (x) x.n += Math.max(0, num(n) - 1);
          }
        break;
      case 'fld': {
        const el = str(e.el, 400);
        let f = s.fields.get(el);
        if (!f) s.fields.set(el, (f = { el, u, n: 0, hes: 0, hesN: 0, dur: 0, cor: 0, err: 0, emp: 0, req: 0, lastBeforeAbandon: 0 }));
        f.n++;
        if (num(e.hes) >= 0) (f.hes += num(e.hes), f.hesN++);
        f.dur += num(e.dur);
        f.cor += num(e.cor);
        f.err += num(e.err);
        f.emp += num(e.emp);
        f.req = num(e.req);
        f.at = here();
        break;
      }
      case 'frm': {
        const el = str(e.el, 400);
        let f = s.forms.get(el);
        if (!f) s.forms.set(el, (f = { el, u, start: 0, submit: 0, ok: 0, fail: 0, abandon: 0 }));
        f.at = here();
        const a = str(e.a, 8);
        if (a === 'start') (f.start++, ss.formsStarted++, ss.formStart.set(el, e.at));
        else if (a === 'submit') f.submit++;
        else if (a === 'ok') {
          f.ok++;
          ss.formsOk++;
          const st = ss.formStart.get(el);
          if (st) ss.formMs.push(e.at - st);
        } else if (a === 'fail') f.fail++;
        else if (a === 'abandon') {
          f.abandon++;
          const last = s.fields.get(str(e.last, 400));
          if (last) last.lastBeforeAbandon++;
        }
        tl({ t: 'frm', a, el });
        break;
      }
      case 'fn': {
        const n = str(e.n, 80);
        let f = s.funnels.get(n);
        if (!f) s.funnels.set(n, (f = new Map()));
        const i = num(e.i);
        let step = f.get(i);
        if (!step) f.set(i, (step = { ids: new Set(), at: here() }));
        step.ids.add(e.sid);
        step.at = here();
        break;
      }
      case 'vit': {
        const n = str(e.n, 6);
        let a = p.vitals.get(n);
        if (!a) p.vitals.set(n, (a = []));
        if (a.length >= VITAL_CAP) a.shift();
        a.push({ v: num(e.v), dev: str(e.dev, 2), at: here() });
        break;
      }
      case 'lt':
        s.longTasks.n += num(e.n);
        s.longTasks.ms += num(e.d);
        break;
      case 'coach': {
        const k = `${str(e.a, 10)}|${str(e.k, 60)}`;
        let c = s.coach.get(k);
        if (!c) s.coach.set(k, (c = { h: 0, c: 0 }));
        c[e.grp === 'h' ? 'h' : 'c']++;
        if (e.a === 'show') ss.coachShown++;
        tl({ t: 'coach', a: str(e.a, 10), k: str(e.k, 60) });
        break;
      }
      case 'act': {
        const k = str(e.a, 20);
        let c = s.actions.get(k);
        if (!c) s.actions.set(k, (c = { ok: 0, blocked: 0 }));
        e.ok ? c.ok++ : c.blocked++;
        tl({ t: 'act', a: k, ok: e.ok ? 1 : 0 });
        break;
      }
      case 'tour': {
        const id = str(e.id, 80);
        let t = s.tours.get(id);
        if (!t) s.tours.set(id, (t = { id, start: 0, done: 0, exit: 0, steps: new Map(), ms: [], exitAt: new Map() }));
        if (e.a === 'start') t.start++;
        else if (e.a === 'step') inc(t.steps, num(e.i));
        else if (e.a === 'done') (t.done++, t.ms.push(num(e.ms)));
        else if (e.a === 'exit') (t.exit++, inc(t.exitAt, num(e.i)));
        tl({ t: 'tour', a: str(e.a, 6), id });
        break;
      }
      case 'ac':
        if (e.a === 'show') s.autocomplete.show++;
        else if (e.a === 'accept') s.autocomplete.accept++;
        break;
      case 'ask':
        s.asks++;
        tl({ t: 'ask' });
        break;
      case 'cu':
        inc(s.custom, str(e.n, 60));
        tl({ t: 'cu', n: str(e.n, 60) });
        break;
      case 'diag':
        s.diag++;
        break;
      case 'bye':
        tl({ t: 'bye' });
        break;
      case 'kf': {
        const h = str(e.h, 40);
        if (!h) break;
        const fr = ss.replay.frames;
        const ts = Math.max(0, num(e.ts) - num(e.d));
        // Keep each page's frames in time order: a slow serialization can report late.
        let i = fr.length;
        while (i > 0 && fr[i - 1].pid === pg.pid && fr[i - 1].ts > ts) i--;
        fr.splice(i, 0, { pid: pg.pid, ts, h });
        if (fr.length > 2000) fr.shift();
        break;
      }
    }
  }

  // ---------------- queries ----------------
  siteNames() {
    // Most recently active first, so the dashboard opens on live traffic rather than an old demo site.
    const last = (a: SiteAgg) => {
      let t = 0;
      for (const s of a.sessions.values()) if (s.end > t) t = s.end;
      return t;
    };
    return [...this.sites.entries()].sort((a, b) => last(b[1]) - last(a[1])).map(([k]) => k);
  }

  /** Headline numbers for the all-sites view. Doesn't create an empty site. */
  summary(site: string) {
    const s = this.sites.get(site);
    const now = Date.now();
    const out = { sessions: 0, sessions24h: 0, pageviews: 0, live: 0, errors: 0, avgFrustration: 0, lastEvent: 0, trend: [] as { d: string; sessions: number }[] };
    if (!s) return out;
    const list = [...s.sessions.values()];
    out.sessions = list.length;
    for (const x of list) {
      if (x.start > now - 86_400_000) out.sessions24h++;
      if (isLive(x, now)) out.live++;
      if (x.end > out.lastEvent) out.lastEvent = x.end;
    }
    for (const p of s.pages.values()) out.pageviews += p.views;
    for (const e of s.errors.values()) out.errors += e.n;
    out.avgFrustration = Math.round(avg(list.map((x) => x.frus)) * 10) / 10;
    // Last 14 days, gaps filled, so every site's sparkline has the same time axis.
    const days = new Map([...s.days].map(([d, x]) => [d, x.sessions.size]));
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      out.trend.push({ d, sessions: days.get(d) || 0 });
    }
    return out;
  }

  /** Forgets one site (before re-reading it from the store). */
  drop(site: string) {
    this.sites.delete(site);
  }

  /** `span` is the date range in ms (0 = all data): up to two days are charted per hour, longer per day. */
  overview(site: string, span = 0) {
    const s = this.site(site);
    const sessions = [...s.sessions.values()];
    const pages = [...s.pages.values()];
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    const hourly = span > 0 && span <= 2 * DAY;
    const step = hourly ? HOUR : DAY;
    const now = Math.floor(Date.now() / step) * step;
    const first = Math.min(...[...s.days.keys()].map((d) => Date.parse(d)), now);
    const from = span ? now - Math.ceil(span / step) * step + step : Math.max(first, now - 89 * DAY);
    const series: { t: number; sessions: number; pv: number; errors: number; frus: number }[] = [];
    for (let t = from; t <= now; t += step) {
      const b = (hourly ? s.hours : s.days).get(new Date(t).toISOString().slice(0, hourly ? 13 : 10));
      series.push({ t, sessions: b?.sessions.size || 0, pv: b?.pv || 0, errors: b?.errors || 0, frus: b ? Math.round(b.frus / Math.max(1, b.sessions.size)) : 0 });
    }
    const routes = new Map<string, { route: string; top: string; topViews: number; views: number; sids: Set<string>; frus: number; errors: number; variants: number; at?: Moment; worst: number }>();
    for (const p of pages) {
      const route = p.u.split(/[?#]/)[0] || '/';
      let r = routes.get(route);
      if (!r) routes.set(route, (r = { route, top: p.u, topViews: -1, views: 0, sids: new Set(), frus: 0, errors: 0, variants: 0, worst: -1 }));
      if (p.views > r.topViews) (r.top = p.u), (r.topViews = p.views);
      r.views += p.views;
      for (const x of p.sessions) r.sids.add(x);
      r.frus += p.frusTotal;
      r.errors += p.errors;
      r.variants++;
      const per = p.frusTotal / Math.max(1, p.sessions.size);
      if (p.at && per > r.worst) (r.worst = per), (r.at = p.at);
    }
    const lengths = sessions.map((x) => x.end - x.start).sort((a, b) => a - b);
    const rage = pages.reduce((n, p) => n + [...p.frus.values()].reduce((m, f) => m + (f.kinds.rage || 0), 0), 0);
    const dead = pages.reduce((n, p) => n + [...p.frus.values()].reduce((m, f) => m + (f.kinds.dead || 0), 0), 0);
    return {
      site,
      sites: this.siteNames(),
      sessions: sessions.length,
      bots: s.bots.size,
      pageviews: pages.reduce((n, p) => n + p.views, 0),
      avgFrustration: Math.round(avg(sessions.map((x) => x.frus)) * 10) / 10,
      errors: [...s.errors.values()].reduce((n, e) => n + e.n, 0),
      rage,
      dead,
      trend: [...s.days]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-30)
        .map(([d, x]) => ({ d, sessions: x.sessions.size, frus: Math.round(x.frus / Math.max(1, x.sessions.size)), errors: x.errors, pv: x.pv })),
      topPages: top(
        pages.map((p) => ({ u: p.u, views: p.views, sessions: p.sessions.size, frus: Math.round(p.frusTotal / Math.max(1, p.sessions.size)), errors: p.errors, at: p.at })),
        (x) => x.frus,
        10,
      ),
      series: { unit: hourly ? 'hour' : 'day', points: series },
      routes: [...routes.values()]
        .map(({ sids, worst, frus, topViews, ...r }) => ({ ...r, sessions: sids.size, frus: Math.round(frus / Math.max(1, sids.size)) }))
        .sort((a, b) => b.views - a.views),
      frustrated: sessions.filter((x) => Math.round(x.frus) > 50).length,
      errorSessions: sessions.filter((x) => x.errors > 0).length,
      medianDuration: lengths.length ? lengths[lengths.length >> 1] : 0,
      pagesPerSession: sessions.length ? Math.round((sessions.reduce((n, x) => n + x.pages.length, 0) / sessions.length) * 10) / 10 : 0,
      bounced: sessions.filter((x) => x.pages.length <= 1).length,
      autocomplete: s.autocomplete,
      asks: s.asks,
      diag: s.diag,
    };
  }

  pages(site: string, hasSnap: (u: string) => boolean) {
    return [...this.site(site).pages.values()]
      .map((p) => ({ u: p.u, views: p.views, sessions: p.sessions.size, clicks: p.clicks.length, frus: Math.round(p.frusTotal), errors: p.errors, snapshot: hasSnap(p.u), at: p.at }))
      .sort((a, b) => b.views - a.views);
  }

  heatmap(site: string, u: string) {
    const p = this.site(site).pages.get(u);
    if (!p) return { clicks: [], moves: [], scroll: { reach: [], sessions: 0 }, attention: [], frustration: [] };
    const moves = [...p.moves].map(([k, n]) => {
      const [x, y, w, dev] = k.split('|');
      return { x: +x * 20, y: +y * 20, n, w: +w, dev };
    });
    const reach = (dev?: string) => {
      const list = dev ? p.scroll.filter((s) => s.dev === dev) : p.scroll;
      return Array.from({ length: 10 }, (_, i) => (list.length ? (list.filter((s) => s.max >= i * 10).length / list.length) * 100 : 0));
    };
    return {
      clicks: p.clicks.slice(-5000),
      moves,
      scroll: { reach: reach(), byDev: { d: reach('d'), t: reach('t'), m: reach('m') }, sessions: p.scroll.length },
      attention: top([...p.attention], (x) => x[1], 60),
      frustration: top(
        [...p.frus].map(([el, f]) => ({ el, score: Math.round(f.score), at: f.at })),
        (x) => x.score,
        60,
      ),
    };
  }

  frustration(site: string) {
    const out: { u: string; el: string; score: number; n: number; kinds: Record<string, number>; at?: Moment }[] = [];
    for (const p of this.site(site).pages.values()) for (const [el, f] of p.frus) out.push({ u: p.u, el, score: Math.round(f.score), n: f.n, kinds: f.kinds, at: f.at });
    return top(out, (x) => x.score, 100);
  }

  errors(site: string) {
    return top(
      [...this.site(site).errors.values()].map((e) => ({ fp: e.fp, k: e.k, m: e.m, n: e.n, sessions: e.sessions.size, pages: [...e.pages].slice(0, 10), st: e.st, ru: e.ru, el: e.el, first: e.first, last: e.last, bc: e.bc, at: e.at })),
      (x) => x.sessions * 1000 + x.n,
      200,
    );
  }

  forms(site: string) {
    const s = this.site(site);
    return {
      forms: [...s.forms.values()].map((f) => ({ ...f, completion: f.start ? Math.round((f.ok / f.start) * 100) : null })),
      fields: top(
        [...s.fields.values()].map((f) => ({
          el: f.el,
          u: f.u,
          n: f.n,
          hesitation: f.hesN ? Math.round(f.hes / f.hesN) : null,
          duration: f.n ? Math.round(f.dur / f.n) : null,
          corrections: f.n ? Math.round((f.cor / f.n) * 10) / 10 : 0,
          errorRate: f.n ? Math.round((f.err / f.n) * 100) : 0,
          leftEmpty: f.n ? Math.round((f.emp / f.n) * 100) : 0,
          dropOff: f.lastBeforeAbandon,
          required: !!f.req,
          at: f.at,
        })),
        (x) => x.errorRate * 10 + (x.hesitation || 0) / 100 + x.dropOff * 50,
        100,
      ),
    };
  }

  funnels(site: string) {
    return [...this.site(site).funnels].map(([name, steps]) => {
      const n = Math.max(...steps.keys()) + 1;
      const counts = Array.from({ length: n }, (_, i) => steps.get(i)?.ids.size || 0);
      return { name, steps: counts.map((c, i) => ({ i, sessions: c, conv: i && counts[i - 1] ? Math.round((c / counts[i - 1]) * 100) : 100, at: steps.get(i)?.at })) };
    });
  }

  /**
   * Web vitals at the 75th percentile (what Google's Core Web Vitals assessment uses), for the
   * whole site and per route. A route is the path without its query, so `/item?id=1` and
   * `/item?id=2` are one row with two variants. `dev` keeps one device's samples only.
   */
  vitals(site: string, dev = '') {
    const s = this.site(site);
    const keep = (a: Vital[]) => (dev ? a.filter((x) => x.dev === dev) : a);
    const all = new Map<string, Vital[]>();
    const routes = new Map<string, { route: string; views: number; samples: Map<string, Vital[]>; variants: { u: string; views: number; metrics: Record<string, VitalStat> }[] }>();
    const devices: Record<string, number> = {};
    for (const p of s.pages.values()) {
      if (!p.vitals.size) continue;
      // Page loads per device: every load reports TTFB/FCP, so the fullest metric stands for loads.
      const loads = [...p.vitals.values()].reduce((a, b) => (b.length > a.length ? b : a));
      for (const x of loads) devices[x.dev] = (devices[x.dev] || 0) + 1;
      const metrics: Record<string, VitalStat> = {};
      const route = p.u.split(/[?#]/)[0] || '/';
      let r = routes.get(route);
      if (!r) routes.set(route, (r = { route, views: 0, samples: new Map(), variants: [] }));
      for (const [n, raw] of p.vitals) {
        const a = keep(raw);
        if (!a.length) continue;
        metrics[n] = vitalStat(n, a);
        r.samples.set(n, [...(r.samples.get(n) || []), ...a]);
        all.set(n, [...(all.get(n) || []), ...a]);
      }
      if (!Object.keys(metrics).length) continue;
      r.views += p.views;
      r.variants.push({ u: p.u, views: p.views, metrics });
    }
    const pages = [...routes.values()]
      .filter((r) => r.samples.size)
      .map((r) => ({
        route: r.route,
        views: r.views,
        metrics: Object.fromEntries([...r.samples].map(([n, a]) => [n, vitalStat(n, a)])),
        variants: r.variants.length > 1 ? r.variants.sort((a, b) => b.views - a.views) : [],
      }));
    return {
      summary: Object.fromEntries([...all].map(([n, a]) => [n, vitalStat(n, a)])),
      pages,
      devices,
      longTasks: s.longTasks,
    };
  }

  private sessionRow(s: SiteAgg, x: Sess, now: number) {
    const w = s.who.get(x.vid);
    // One key for every id the same person has used, so the list can group their visits.
    const person = w && w.vids.size > 1 ? [...w.vids].sort()[0] : x.vid;
    return { sid: x.sid, vid: x.vid, person, name: w?.name || '', email: w?.email || '', start: x.start, end: x.end, grp: x.grp, dev: x.dev, pages: x.pages.length, frus: Math.round(x.frus), errors: x.errors, clicks: x.clicks, coached: x.coachShown, replayMs: recordedMs(x.replay), live: isLive(x, now) };
  }

  sessions(site: string, limit = 200, vid?: string) {
    const s = this.site(site);
    const now = Date.now();
    const vids = vid ? new Set(this.vidsOf(site, vid)) : null;
    return [...s.sessions.values()]
      .filter((x) => !vids || vids.has(x.vid))
      .sort((a, b) => Number(isLive(b, now)) - Number(isLive(a, now)) || b.start - a.start)
      .slice(0, limit)
      .map((x) => this.sessionRow(s, x, now));
  }

  session(site: string, sid: string) {
    const x = this.site(site).sessions.get(sid);
    if (!x) return null;
    const { formStart, replay, left, fev, ...rest } = x;
    const w = this.site(site).who.get(x.vid);
    return { ...rest, name: w?.name || '', email: w?.email || '', replayMs: recordedMs(replay), live: isLive(x) };
  }

  /** Visitors, named ones and anonymous, most recently seen first. `q` matches name, email or id. */
  people(site: string, q = '') {
    const s = this.site(site);
    const now = Date.now();
    const needle = q.trim().toLowerCase();
    const byVid = new Map<string, Sess[]>();
    for (const x of s.sessions.values()) {
      const list = byVid.get(x.vid);
      if (list) list.push(x);
      else byVid.set(x.vid, [x]);
    }
    const seen = new Set<string>();
    const rows = [];
    for (const vid of byVid.keys()) {
      if (seen.has(vid)) continue;
      const w = s.who.get(vid);
      const vids = w ? [...w.vids] : [vid];
      for (const v of vids) seen.add(v);
      const all = vids.flatMap((v) => byVid.get(v) || []);
      if (!all.length) continue;
      const name = w?.name || '';
      const email = w?.email || '';
      if (needle && ![name, email, ...vids].join(' ').toLowerCase().includes(needle)) continue;
      const last = Math.max(...all.map((x) => x.end));
      rows.push({
        vid: vids[0],
        name,
        email,
        sessions: all.length,
        first: Math.min(...all.map((x) => x.start)),
        last,
        frus: Math.round(all.reduce((n, x) => n + x.frus, 0)),
        errors: all.reduce((n, x) => n + x.errors, 0),
        live: all.some((x) => isLive(x, now)),
      });
    }
    return rows.sort((a, b) => Number(b.name || b.email ? 1 : 0) - Number(a.name || a.email ? 1 : 0) || b.last - a.last).slice(0, needle ? 100 : 200);
  }

  /** One person across every id they have used: their sessions and what they did, newest first. */
  person(site: string, vid: string) {
    const s = this.site(site);
    const now = Date.now();
    const w = s.who.get(vid);
    const vids = w ? [...w.vids] : [vid];
    const sessions = [...s.sessions.values()].filter((x) => vids.includes(x.vid)).sort((a, b) => b.start - a.start);
    if (!sessions.length && !w) return null;
    const activity = sessions
      .flatMap((x) => x.timeline.map((e) => ({ at: num(e.at), sid: x.sid, pid: str(e.pid, 40), ts: num(e.ts), t: str(e.t, 12), u: str(e.u, 400), el: str(e.el, 400), m: str(e.m, 200), k: str(e.k, 24), a: str(e.a, 24), n: str(e.n, 60), ok: num(e.ok) })))
      .sort((a, b) => b.at - a.at)
      .slice(0, 300);
    return { vid: vids[0], vids, name: w?.name || '', email: w?.email || '', sessions: sessions.slice(0, 200).map((x) => this.sessionRow(s, x, now)), activity };
  }

  liveCount(site: string) {
    const now = Date.now();
    let n = 0;
    for (const x of this.site(site).sessions.values()) if (isLive(x, now)) n++;
    return n;
  }

  /** Pointer, scroll and click samples for the dashboard player. One clock per page view (`ts` restarts at each page). */
  replay(site: string, sid: string) {
    const x = this.site(site).sessions.get(sid);
    if (!x) return null;
    const r = x.replay;
    return {
      pages: r.pages.map((p) => ({ pid: p.pid, u: p.u, w: p.vw || 1280, h: p.vh || 800, dw: p.dw || p.vw || 1280, dh: p.dh || 0, dur: pageDur(p) })),
      moves: r.moves,
      scrolls: r.scrolls,
      clicks: r.clicks,
      inputs: r.inputs,
      boxScrolls: r.boxScrolls,
      frames: r.frames,
    };
  }

}
