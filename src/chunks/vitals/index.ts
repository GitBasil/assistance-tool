import type { Ctx } from '../../core/types';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

/** Core Web Vitals (web-vitals library for correct INP/CLS/LCP) + long tasks. */
export default function install(ctx: Ctx) {
  const send = (m: Metric) => ctx.send({ t: 'vit', n: m.name, v: Math.round(m.name === 'CLS' ? m.value * 1000 : m.value), r: m.rating[0] });
  onLCP(send);
  onCLS(send);
  onINP(send);
  onFCP(send);
  onTTFB(send);
  let n = 0,
    total = 0,
    worst = 0;
  try {
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        n++;
        total += e.duration;
        worst = Math.max(worst, e.duration);
      }
    });
    po.observe({ type: 'longtask', buffered: true });
    ctx.bus.on('summarize', () => {
      if (n) ctx.send({ t: 'lt', n, d: Math.round(total), w: Math.round(worst) });
      n = total = worst = 0;
    });
    ctx.bus.on('destroy', () => po.disconnect());
  } catch {}
  return {};
}
