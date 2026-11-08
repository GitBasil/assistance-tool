import type { Ctx } from './types';
import { normUrl, redact } from '../privacy/redactor';
import { hash, on, W } from './util';

type Report = (k: string, m: string, x?: Record<string, unknown>) => void;

export const UI_SEL = '[role=alert],[aria-live=assertive],[aria-invalid=true],.error,.invalid-feedback,.field-error,.form-error,.has-error,.is-invalid';

export function errFp(k: string, msg: string, frame = '') {
  return hash(k + '|' + msg.replace(/\d+/g, 'N').slice(0, 120) + '|' + frame.replace(/\?.*$/, ''));
}

export function topFrame(stack?: string): string {
  if (!stack) return '';
  const l = stack.split('\n').find((x) => /:\d+:\d+/.test(x) && !/assist[.-]|\/collect/.test(x));
  return l ? redact(l.trim().replace(/^at\s+/, ''), 160) : '';
}

/**
 * Error capture. Defaults patch nothing: network failures come from
 * PerformanceObserver resource timing (responseStatus). network:'wrap' and
 * console:true load the chain-safe `netwrap` chunk.
 */
export function startErrors(ctx: Ctx, report: Report) {
  const offs: (() => void)[] = [];
  const { cfg, bus } = ctx;
  const own = ctx.own;

  offs.push(
    on(W, 'error', (e: ErrorEvent) => {
      const t = e.target as any;
      if (t && t !== W && t.tagName) {
        const src = t.src || t.href || '';
        if (!own(src)) report('res', t.tagName.toLowerCase() + ' failed', { u: normUrl(src), el: ctx.fp(t) });
        return;
      }
      if (own(e.filename) || own(e.error?.stack)) return bus.err?.(e.error);
      report('js', e.message || 'Script error', { st: topFrame(e.error?.stack) || redact(`${e.filename}:${e.lineno}`) });
    }),
    on(W, 'unhandledrejection', (e: PromiseRejectionEvent) => {
      const r = e.reason;
      if (own(r?.stack)) return;
      report('rej', String(r?.message || r || 'Unhandled rejection'), { st: topFrame(r?.stack) });
    }),
    on(document, 'invalid', (e: Event) => {
      const el = e.target as HTMLInputElement;
      const fp = ctx.fp(el);
      report('val', el.validationMessage || 'invalid', { el: fp, node: el });
      ctx.frus.invalid(fp);
    }),
  );

  if (cfg.network !== 'off' && 'PerformanceObserver' in W) {
    try {
      const po = new PerformanceObserver((l) => {
        for (const r of l.getEntries() as PerformanceResourceTiming[]) {
          if (own(r.name) || (r.initiatorType === 'other' && /\/favicon\.ico$/.test(r.name))) continue;
          if (r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest') bus.emit('net', r);
          const sc = (r as any).responseStatus as number | undefined;
          if (cfg.network === 'observe' && sc && sc >= 400)
            report(r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest' ? 'net' : 'res', `HTTP ${sc}`, { u: normUrl(r.name), sc, d: Math.round(r.duration), i: r.initiatorType });
        }
      });
      po.observe({ type: 'resource', buffered: false });
      offs.push(() => po.disconnect());
    } catch {
      /* unsupported */
    }
  }
  if (cfg.network === 'wrap' || cfg.console) ctx.load('netwrap').catch(() => {});
  return () => offs.forEach((f) => f());
}