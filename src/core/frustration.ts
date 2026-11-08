export interface Signal {
  k: string;
  el?: string;
  s: number;
  ts: number;
  e?: Record<string, unknown>;
  /** fingerprint of an error that preceded this signal (error -> pain link) */
  err?: string;
}

/** Weight per signal kind; score is a decaying weighted sum capped at 100. */
export const WEIGHTS: Record<string, number> = {
  rage: 25,
  dead: 15,
  errclick: 20,
  disabled: 14,
  fake: 10,
  thrash: 15,
  valloop: 20,
  resubmit: 20,
  paste: 8,
  uturn: 10,
  loop: 15,
  refresh: 20,
  qback: 12,
  cursor: 8,
  wander: 8,
  hover: 5,
  idle: 10,
  leave: 10,
  zoom: 8,
  tabcycle: 10,
};

const MOUSE_ONLY = new Set(['cursor', 'hover', 'leave', 'wander']);
const HALF_LIFE = 60000;
const COOLDOWN = 5000;
/**
 * Context signals: ordinary behaviour (browsing, comparing, resting the pointer)
 * that only means something next to other evidence. They score nothing alone and
 * count once direct evidence, or two other groups of context signals, land within
 * WINDOW. Every other kind (rage, dead, errclick...) is direct evidence of a stuck user.
 */
const CTX: Record<string, string> = { uturn: 'n', loop: 'n', refresh: 'n', qback: 'n', cursor: 'm', hover: 'm', wander: 'm', fake: 'm', idle: 'f', leave: 'f', zoom: 'f', paste: 'f', tabcycle: 'f' };
const WINDOW = 20000;

/**
 * Pure (DOM-free) frustration detectors + score. capture.ts feeds it
 * normalized inputs; tests drive it with synthetic sequences.
 */
export class Frustration {
  private _hist: { w: number; t: number; el?: string }[] = [];
  private _ev: { g: string; t: number; w: number; el?: string; ok: boolean }[] = [];
  private _dis = new Map<string, number[]>();
  private _last = new Map<string, number>();
  private _clicks: { x: number; y: number; t: number; el: string }[] = [];
  private _lastClick = { t: -1e9, el: '' };
  private _lastErr = { t: -1e9, fp: '' };
  private _fields = new Map<string, { clears: number; del: number; ins: number; paste: number[]; bad: number; edited: boolean; t: number; k: string }>();
  private _submits = new Map<string, number[]>();
  private _mv = { x: 0, dir: 0, rev: [] as number[], dist: 0, t: 0 };
  private _sc = { y: 0, dir: 0, rev: [] as number[] };
  private _tabs: { el: string; t: number }[] = [];
  kb = false;

  constructor(
    private _out: (s: Signal) => void,
    private _clock: () => number = () => performance.now(),
  ) {}

  /** Decayed score 0..100, optionally for one element. */
  score(el?: string): number {
    const t = this._clock();
    let s = 0;
    for (const h of this._hist) if (!el || h.el === el) s += h.w * Math.pow(0.5, (t - h.t) / HALF_LIFE);
    return Math.min(100, Math.round(s));
  }

  /** Elements ranked by local frustration. */
  hotspots(n = 5): [string, number][] {
    const m = new Map<string, number>();
    for (const h of this._hist) if (h.el) m.set(h.el, this.score(h.el));
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  signal(k: string, el?: string, e?: Record<string, unknown>, sev = 1): Signal | null {
    if (this.kb && MOUSE_ONLY.has(k)) return null;
    const t = this._clock();
    const key = k + '|' + (el || '');
    if (t - (this._last.get(key) ?? -1e9) < COOLDOWN) return null;
    this._last.set(key, t);
    const w = (WEIGHTS[k] ?? 10) * sev;
    const cur = { g: CTX[k] || '', t, w, el, ok: false };
    this._ev = this._ev.filter((x) => t - x.t < WINDOW);
    this._ev.push(cur);
    // Direct evidence counts at once and vouches for any context signal in the window; context
    // signals also vouch for each other, but only when three different groups show up together.
    for (const x of this._ev) {
      if (x.ok || (x.g && !this._ev.some((y) => !y.g) && new Set(this._ev.map((y) => y.g).filter((g) => g && g !== x.g)).size < 2)) continue;
      x.ok = true;
      this._hist.push({ w: x.w, t: x.t, el: x.el });
    }
    if (this._hist.length > 200) this._hist.splice(0, 50);
    const s: Signal = { k, el, s: cur.ok ? Math.round(w) : 0, ts: t, e };
    if (t - this._lastErr.t < 5000) s.err = this._lastErr.fp;
    this._out(s);
    return s;
  }

  click(x: number, y: number, el: string, multiOk = false) {
    const t = this._clock();
    this._lastClick = { t, el };
    this._sc.rev = [];
    this._clicks = this._clicks.filter((c) => t - c.t < 1000);
    this._clicks.push({ x, y, t, el });
    if (multiOk) return;
    const near = this._clicks.filter((c) => Math.hypot(c.x - x, c.y - y) <= 30);
    if (near.length >= 3) {
      this.signal('rage', el, { n: near.length }, near.length >= 5 ? 1.5 : 1);
      this._clicks = [];
    }
  }

  /** An error happened (js / network / ui). Links to the click that likely caused it. */
  error(fp: string) {
    const t = this._clock();
    this._lastErr = { t, fp };
    if (t - this._lastClick.t < 1000) this.signal('errclick', this._lastClick.el, { err: fp });
  }

  private _f(el: string) {
    let f = this._fields.get(el);
    if (!f) this._fields.set(el, (f = { clears: 0, del: 0, ins: 0, paste: [], bad: 0, edited: false, t: 0, k: '' }));
    return f;
  }

  /** A click on a disabled control. One is a slip; a second within 8s is someone who expected it to work. */
  disabled(el: string, e?: Record<string, unknown>) {
    const t = this._clock();
    const a = (this._dis.get(el) || []).filter((x) => t - x < 8000);
    a.push(t);
    this._dis.set(el, a);
    if (a.length >= 2) this.signal('disabled', el, e);
  }

  /** `search`: search boxes are cleared and retyped as a matter of course, so clears there say nothing. */
  input(el: string, kind: 'clear' | 'del' | 'ins' | 'paste', search = false) {
    const f = this._f(el);
    f.edited = true;
    const t = this._clock();
    // stale tallies from an earlier burst of editing don't add up to thrashing
    if (t - f.t > 30000) f.clears = f.del = f.ins = 0;
    if (kind === 'clear') f.clears++;
    else if (kind === 'del') {
      // holding Backspace is one deletion, not fifteen
      if (t - f.t > 400 || f.k !== 'del') f.del++;
    } else if (kind === 'ins') f.ins++;
    else {
      f.paste = f.paste.filter((p) => t - p < 30000);
      f.paste.push(t);
      if (f.paste.length >= 2) this.signal('paste', el, { n: f.paste.length });
    }
    f.t = t;
    f.k = kind;
    if ((!search && f.clears >= 3) || (f.del >= 6 && f.del * 5 > f.ins)) {
      this.signal('thrash', el, { clears: f.clears, del: f.del, ins: f.ins });
      f.clears = f.del = f.ins = 0;
    }
  }

  /** Field failed validation (native invalid, aria-invalid, error text). */
  invalid(el: string) {
    const f = this._f(el);
    if (f.bad > 0 && f.edited) this.signal('valloop', el, { n: f.bad + 1 });
    f.bad++;
    f.edited = false;
  }

  valid(el: string) {
    const f = this._fields.get(el);
    if (f) f.bad = 0;
  }

  submitInvalid(form: string) {
    const t = this._clock();
    const a = (this._submits.get(form) || []).filter((x) => t - x < 60000);
    a.push(t);
    this._submits.set(form, a);
    if (a.length >= 2) this.signal('resubmit', form, { n: a.length });
  }

  move(x: number, t = this._clock()) {
    const m = this._mv;
    const dx = x - m.x;
    if (Math.abs(dx) > 20) {
      const dir = dx > 0 ? 1 : -1;
      if (m.dir && dir !== m.dir) m.rev.push(t);
      m.dir = dir;
      m.x = x;
      m.rev = m.rev.filter((r) => t - r < 1500);
      if (m.rev.length >= 8) {
        this.signal('cursor', undefined, { rev: m.rev.length });
        m.rev = [];
      }
    }
  }

  scroll(y: number, t = this._clock()) {
    const s = this._sc;
    const dy = y - s.y;
    if (Math.abs(dy) < 40) return;
    const dir = dy > 0 ? 1 : -1;
    if (s.dir && dir !== s.dir) s.rev.push(t);
    s.dir = dir;
    s.y = y;
    s.rev = s.rev.filter((r) => t - r < 15000);
    if (s.rev.length >= 6) {
      this.signal('wander', undefined, { rev: s.rev.length });
      s.rev = [];
    }
  }

  tab(el: string) {
    const t = this._clock();
    this._tabs = this._tabs.filter((x) => t - x.t < 20000);
    this._tabs.push({ el, t });
    if (this._tabs.filter((x) => x.el === el).length >= 3) {
      this.signal('tabcycle', el);
      this._tabs = [];
    }
  }

  reset() {
    this._hist = [];
    this._ev = [];
    this._dis.clear();
    this._fields.clear();
    this._submits.clear();
    this._clicks = [];
  }
}
