import type { Ctx } from '../../core/types';
import { findByFp } from '../../page/selectors';
import { HEAT, pageUrl } from '../../privacy/redactor';
import { on } from '../../core/util';
import { UI_ATTR } from '../../core/dom';

function h(tag: string, props: Record<string, unknown> | null = null, ...kids: (Node | string | false | null)[]): HTMLElement {
  const el = document.createElement(tag);
  if (props)
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'on') for (const ev in v as object) el.addEventListener(ev, (v as any)[ev]);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  for (const c of kids) if (c != null && c !== false) el.append(typeof c === 'object' ? c : String(c));
  return el;
}

interface HeatData {
  clicks: { el: string; rx: number; ry: number; x: number; y: number; dev: string }[];
  moves: { x: number; y: number; n: number; w: number; dev: string }[];
  scroll: { reach: number[]; sessions: number };
  attention: [string, number][];
  frustration: [string, number][];
}

/** Classic heat palette: transparent -> blue -> green -> yellow -> red. */
export function colorize(img: ImageData) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (!a) continue;
    const t = Math.min(1, a * 1.4);
    const r = t < 0.5 ? 0 : t < 0.75 ? (t - 0.5) * 4 * 255 : 255;
    const g = t < 0.25 ? t * 4 * 255 : t < 0.75 ? 255 : (1 - t) * 4 * 255;
    const b = t < 0.25 ? 255 : t < 0.5 ? (0.5 - t) * 4 * 255 : 0;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = Math.min(220, 60 + t * 200);
  }
  return img;
}

/**
 * On-site heatmap mode (?assist-heatmap=<dashboard token>): draws aggregated
 * clicks / moves / scroll reach / attention directly on the live page,
 * resolving element fingerprints so points land correctly at any viewport.
 */
export default async function install(ctx: Ctx) {
  const token = new URLSearchParams(location.search).get(HEAT) || ctx.store.get(HEAT, '', true);
  const host = document.createElement('div');
  host.setAttribute(UI_ATTR, '');
  const r = host.attachShadow({ mode: 'open' });
  r.append(h('style', { text: '.bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483646;display:flex;gap:6px;align-items:center;padding:8px 10px;background:#fff;color:#111;border:1px solid #e5e7eb;border-radius:10px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.12)} .bar button,.bar select{font:inherit;border:1px solid #e5e7eb;background:#fff;border-radius:6px;padding:4px 8px;cursor:pointer} .bar button.on{background:#111;color:#fff}' }));
  document.documentElement.append(host);
  let mode: 'clicks' | 'moves' | 'scroll' | 'attention' | 'frustration' = 'clicks';
  let dev = '';
  let data: HeatData | null = null;

  // Above the page's own layers (sticky headers, drawers), below the bar.
  const canvas = h('canvas', { style: { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483645' } }) as HTMLCanvasElement;
  const info = h('span', { class: 'muted' });
  const bar = h(
    'div',
    { class: 'bar' },
    ...(['clicks', 'moves', 'scroll', 'attention', 'frustration'] as const).map((m) => h('button', { type: 'button', 'data-m': m, text: m[0].toUpperCase() + m.slice(1), on: { click: () => ((mode = m), draw()) } })),
    (() => {
      const s = h('select', { class: 'in', 'aria-label': 'Device', style: { flex: 'none' } }, h('option', { value: '', text: 'All devices' }), h('option', { value: 'd', text: 'Desktop' }), h('option', { value: 't', text: 'Tablet' }), h('option', { value: 'm', text: 'Mobile' })) as HTMLSelectElement;
      s.addEventListener('change', () => ((dev = s.value), draw()));
      return s;
    })(),
    info,
    h('button', { type: 'button', 'aria-label': 'Close heatmap', text: '×', on: { click: () => (host.remove(), off.forEach((f) => f()), ctx.store.set(HEAT, undefined, true)) } }),
  );
  r.append(canvas, bar);

  let err = '';
  let seq = 0;
  // Per page: a single-page app changes pages without reloading, so fetch again on each route.
  async function load() {
    const n = ++seq;
    const u = pageUrl(location.href);
    let d: HeatData | null = null;
    err = '';
    try {
      const res = await fetch(`${ctx.cfg.endpoint}/api/heatmap?site=${encodeURIComponent(ctx.cfg.site)}&u=${encodeURIComponent(u)}&token=${encodeURIComponent(token)}`, { credentials: 'omit' });
      if (res.ok) d = await res.json();
      else err = res.status === 403 ? 'Heatmap link expired or wrong: open it again from the dashboard.' : `Heatmap unavailable (${res.status}).`;
    } catch {
      err = 'Could not reach the insights server.';
    }
    if (n !== seq) return;
    data = d;
    draw();
  }

  function draw() {
    const W = innerWidth,
      H = innerHeight;
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    bar.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.m === mode));
    if (!data) return void (info.textContent = err || 'Loading…');
    const sx = scrollX,
      sy = scrollY;
    const docW = document.documentElement.scrollWidth;
    const pts: [number, number, number][] = [];
    let resolved = 0,
      total = 0;
    if (mode === 'clicks') {
      for (const c of data.clicks) {
        if (dev && c.dev !== dev) continue;
        total++;
        const el = findByFp(c.el);
        if (el) {
          const rc = el.getBoundingClientRect();
          resolved++;
          pts.push([rc.left + (c.rx / 1000) * rc.width, rc.top + (c.ry / 1000) * rc.height, 1]);
        } else pts.push([c.x - sx, c.y - sy, 1]);
      }
      info.textContent = total ? `${total} clicks · ${Math.round((resolved / total) * 100)}% matched to elements` : 'No clicks recorded on this page yet';
    } else if (mode === 'moves') {
      for (const m of data.moves) {
        if (dev && m.dev !== dev) continue;
        const k = docW / (m.w || docW);
        pts.push([m.x * k - sx, m.y * k - sy, m.n]);
        total += m.n;
      }
      info.textContent = `${total} movement samples`;
    } else if (mode === 'scroll') {
      const reach = data.scroll.reach;
      const docH = document.documentElement.scrollHeight;
      for (let i = 0; i < 10; i++) {
        const y0 = (i / 10) * docH - sy;
        const pct = reach[i] ?? 0;
        g.fillStyle = `hsla(${pct * 1.2}, 85%, 50%, .28)`;
        g.fillRect(0, y0, W, docH / 10);
        g.fillStyle = '#111';
        g.font = '600 13px system-ui';
        g.fillText(`${Math.round(pct)}% of visitors reached here`, 12, y0 + 18);
      }
      info.textContent = `${data.scroll.sessions} sessions`;
      return;
    } else {
      const list = mode === 'attention' ? data.attention : data.frustration;
      const max = Math.max(1, ...list.map((x) => x[1]));
      for (const [fp, v] of list) {
        const el = findByFp(fp);
        if (!el) continue;
        const rc = el.getBoundingClientRect();
        const t = v / max;
        g.strokeStyle = mode === 'attention' ? `rgba(37,99,235,${0.3 + t * 0.7})` : `rgba(220,38,38,${0.3 + t * 0.7})`;
        g.lineWidth = 2 + t * 4;
        g.strokeRect(rc.left - 3, rc.top - 3, rc.width + 6, rc.height + 6);
        g.fillStyle = g.strokeStyle;
        g.font = '600 12px system-ui';
        g.fillText(mode === 'attention' ? `${(v / 1000).toFixed(1)}s visible` : `frustration ${v}`, rc.left, rc.top - 6);
      }
      info.textContent = `${list.length} elements`;
      return;
    }
    const max = Math.max(1, ...pts.map((p) => p[2]));
    for (const [x, y, n] of pts) {
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      const rad = 28;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, `rgba(0,0,0,${Math.min(0.9, 0.15 + (n / max) * 0.5)})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    g.putImageData(colorize(g.getImageData(0, 0, W, H)), 0, 0);
  }
  let raf = 0;
  const redraw = () => (raf ||= requestAnimationFrame(() => ((raf = 0), draw())));
  // Apps render after load and re-render on their own: match elements again once the DOM settles.
  let settle = 0;
  const mo = new MutationObserver(() => (clearTimeout(settle), (settle = setTimeout(redraw, 250) as unknown as number)));
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  const off = [on(window, 'scroll', redraw), on(window, 'resize', redraw), ctx.bus.on('route', () => load()), () => (mo.disconnect(), clearTimeout(settle))];
  draw();
  load();
  return { draw };
}
