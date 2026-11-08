import type { Ctx } from '../../core/types';

/**
 * Session replay samples. Pointer path, scroll position and viewport only —
 * never keystrokes or field values. The dashboard plays these over the
 * redacted DOM snapshot. Samples are throttled so a busy session stays
 * well under the upload budget.
 */
export default function install(ctx: Ctx) {
  if (!ctx.session.recording || !ctx.cfg.features.replay) return {};

  const skip = (t: EventTarget | null): boolean => {
    const el = t as Element | null;
    if (!el?.closest) return false;
    if (el.closest('[data-assist-ui],[data-assist-ignore],[data-assist-sensitive],input[type=password]')) return true;
    const host = (el.getRootNode?.() as ShadowRoot | undefined)?.host;
    return !!host && skip(host);
  };

  let pts: number[] = [];
  let t0 = 0;
  let lastMove = 0;
  let lx = -1e9;
  let ly = -1e9;
  let lastScroll = 0;
  let sx = -1e9;
  let sy = -1e9;
  let lastView = 0;

  const flush = ctx.guard(() => {
    if (!pts.length) return;
    const o = Math.round(ctx.now() - t0);
    const p = pts;
    pts = [];
    ctx.send({ t: 'rp', k: 'm', o, p });
  });

  const view = ctx.guard(() => {
    const t = ctx.now();
    if (t - lastView < 400) return;
    lastView = t;
    const root = document.documentElement;
    ctx.send({ t: 'rp', k: 'z', w: innerWidth, h: innerHeight, dw: root.scrollWidth, dh: root.scrollHeight });
  });

  ctx.bus.on('move', (e: MouseEvent) => {
    if (document.visibilityState === 'hidden' || skip(e.target)) return;
    const t = ctx.now();
    const x = Math.round(e.pageX);
    const y = Math.round(e.pageY);
    if (t - lastMove < 100 || (Math.abs(x - lx) < 8 && Math.abs(y - ly) < 8)) return;
    if (!pts.length) t0 = t;
    lastMove = t;
    lx = x;
    ly = y;
    pts.push(Math.round(t - t0), x, y);
    if (pts.length >= 90) flush();
  });

  let tail: ReturnType<typeof setTimeout> | undefined;
  const winScroll = ctx.guard(() => {
    if (document.visibilityState === 'hidden') return;
    clearTimeout(tail);
    const t = ctx.now();
    const x = Math.round(scrollX);
    const y = Math.round(scrollY);
    if (x === sx && y === sy) return;
    if (t - lastScroll < 120 || (Math.abs(x - sx) < 16 && Math.abs(y - sy) < 16)) {
      tail = setTimeout(winScroll, 150);
      return;
    }
    lastScroll = t;
    sx = x;
    sy = y;
    ctx.send({ t: 'rp', k: 's', x, y });
  });
  ctx.bus.on('scroll', winScroll);

  // Panels and dialogs that scroll on their own; replayed onto the snapshot element with the same fingerprint.
  const boxes = new WeakMap<Element, { t: number; x: number; y: number; tail?: ReturnType<typeof setTimeout> }>();
  const boxScroll = ctx.guard((e: Event) => {
    const el = e.target as Element;
    if (!(el instanceof Element) || el === document.documentElement || el === document.body || skip(el)) return;
    let s = boxes.get(el);
    if (!s) boxes.set(el, (s = { t: -1e9, x: -1, y: -1 }));
    clearTimeout(s.tail);
    const x = Math.round(el.scrollLeft);
    const y = Math.round(el.scrollTop);
    if (x === s.x && y === s.y) return;
    const t = ctx.now();
    if (t - s.t < 120) {
      s.tail = setTimeout(() => boxScroll(e), 150);
      return;
    }
    s.t = t;
    s.x = x;
    s.y = y;
    ctx.send({ t: 'rp', k: 's', el: ctx.fp(el), x, y });
  });
  addEventListener('scroll', boxScroll, { capture: true, passive: true });

  // Field values as typed, so the replay shows them. Only with masking off; password values never.
  const typed = new Map<Element, ReturnType<typeof setTimeout>>();
  const field = ctx.guard((e: Event) => {
    const el = e.target as HTMLInputElement;
    if (ctx.cfg.mask || !el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || skip(el)) return;
    if (/^(password|hidden|file)$/.test(el.type)) return;
    const put = ctx.guard(() => {
      typed.delete(el);
      if (el.type === 'checkbox' || el.type === 'radio') ctx.send({ t: 'rp', k: 'i', el: ctx.fp(el), c: el.checked });
      else ctx.send({ t: 'rp', k: 'i', el: ctx.fp(el), v: String(el.value).slice(0, 2000) });
    });
    clearTimeout(typed.get(el));
    if (e.type === 'change') put();
    else typed.set(el, setTimeout(put, 150));
  });
  addEventListener('input', field, true);
  addEventListener('change', field, true);

  ctx.bus.on('summarize', flush);
  // Pointer samples go out every 2s, or every 200ms while a dashboard is watching live.
  let lastFlush = 0;
  const timer = setInterval(() => {
    const t = Date.now();
    if ((ctx.session.watched || 0) > t || t - lastFlush >= 2000) {
      lastFlush = t;
      flush();
    }
  }, 200);
  addEventListener('resize', view, { passive: true });
  ctx.bus.on('destroy', () => {
    clearInterval(timer);
    removeEventListener('resize', view);
    removeEventListener('input', field, true);
    removeEventListener('change', field, true);
    removeEventListener('scroll', boxScroll, true);
    clearTimeout(tail);
  });
  view();
  return {};
}
