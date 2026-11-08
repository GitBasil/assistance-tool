import type { Ctx } from '../../core/types';
import { normUrl } from '../../privacy/redactor';

type Report = (k: string, m: string, x?: Record<string, unknown>) => void;

/**
 * Opt-in (network:'wrap' / console:true). Chain-safe: keeps whatever wrapper
 * is already installed (Sentry, Datadog, zone.js), never wraps twice, keeps
 * name/toString, and only unwraps if nobody wrapped on top of us.
 */
export default function install(ctx: Ctx) {
  const own = ctx.own;
  const offs: (() => void)[] = [];
  if (ctx.cfg.network === 'wrap') offs.push(wrapNetwork(ctx.report, own));
  if (ctx.cfg.console) offs.push(wrapConsole(ctx.report));
  ctx.bus.on('destroy', () => offs.forEach((f) => f()));
  return { stop: () => offs.forEach((f) => f()) };
}

export function wrapNetwork(report: Report, own: (s?: string) => boolean) {
  const w = window as any;
  const restore: (() => void)[] = [];
  const of = w.fetch;
  if (of && !of.__assist) {
    const nf: any = function (this: any, input: any, init?: any) {
      const u = typeof input === 'string' ? input : input?.url || String(input);
      const t0 = performance.now();
      const p = of.apply(this, arguments as any);
      if (own(u)) return p;
      return p.then(
        (r: Response) => {
          if (r.status >= 400)
            report('net', `HTTP ${r.status}`, { u: normUrl(u), sc: r.status, mt: (init?.method || 'GET').toUpperCase(), d: Math.round(performance.now() - t0) });
          return r;
        },
        (e: any) => {
          if (e?.name !== 'AbortError') report('net', 'Network request failed', { u: normUrl(u), sc: 0, d: Math.round(performance.now() - t0) });
          throw e;
        },
      );
    };
    nf.__assist = 1;
    try {
      Object.defineProperty(nf, 'name', { value: 'fetch' });
      nf.toString = () => of.toString();
    } catch {}
    w.fetch = nf;
    restore.push(() => w.fetch === nf && (w.fetch = of));
  }
  const X = w.XMLHttpRequest?.prototype;
  if (X && !X.open.__assist) {
    const oo = X.open;
    const os = X.send;
    const no: any = function (this: any, m: string, u: string) {
      this.__assistReq = { m, u, t: 0 };
      return oo.apply(this, arguments as any);
    };
    const ns: any = function (this: any) {
      const r = this.__assistReq;
      if (r && !own(String(r.u))) {
        r.t = performance.now();
        this.addEventListener('loadend', () => {
          if (this.status >= 400 || this.status === 0)
            report('net', this.status ? `HTTP ${this.status}` : 'Network request failed', { u: normUrl(String(r.u)), sc: this.status, mt: r.m, d: Math.round(performance.now() - r.t) });
        });
      }
      return os.apply(this, arguments as any);
    };
    no.__assist = ns.__assist = 1;
    X.open = no;
    X.send = ns;
    restore.push(() => {
      if (X.open === no) X.open = oo;
      if (X.send === ns) X.send = os;
    });
  }
  return () => restore.forEach((f) => f());
}

export function wrapConsole(report: Report) {
  const c = console as any;
  const orig = c.error;
  if (orig.__assist) return () => {};
  const f: any = function (this: any, ...a: any[]) {
    try {
      report('con', a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : '')).join(' '));
    } catch {}
    return orig.apply(this, a);
  };
  f.__assist = 1;
  c.error = f;
  return () => c.error === f && (c.error = orig);
}
