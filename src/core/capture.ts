import type { Ctx, Ev } from './types';
import { pageUrl } from '../privacy/redactor';
import { D, W, afterPaint, elOf, idle, isEditable, now, on, sget, sset } from './util';
import { UI_SEL } from './errors';
import { INTERACTIVE, device, ignored, isOurs } from './dom';

const MULTI =
  'input[type=number],[role=spinbutton],[role=slider],[data-assist-multiclick],[aria-roledescription=carousel],.carousel,.pagination,[class*=pager],nav[aria-label*=agination]';

/**
 * Time-critical capture that must run from the first millisecond: clicks
 * (heatmap + rage/dead/disabled), pointer movement, scroll wander, typing
 * thrash, DOM activity + UI error text, navigation patterns. Page-end
 * summaries (forms, depth, attention, funnels) live in the analytics chunk.
 */
export function startCapture(ctx: Ctx, emit: (e: Ev) => void, crumb: (k: string, el?: string) => void, report: (k: string, m: string, x?: Record<string, unknown>) => void) {
  const { cfg, frus, bus } = ctx;
  const F = cfg.features;
  const offs: (() => void)[] = [];
  const skip = (el: Element | null) => ignored(cfg, el);

  let mut = 0;
  let net = 0;
  let lastTyping = -1e9;
  let pointerSeen = false;
  let grid = new Map<string, number>();
  let docW = 1;
  bus.on('net', () => net++);

  offs.push(
    on(D, 'pointerdown', (e: PointerEvent) => {
      pointerSeen = true;
      frus.kb = false;
      const el = elOf(e);
      const dis = el && !skip(el) && el.closest(':disabled,[aria-disabled=true]');
      if (dis) {
        frus.disabled(ctx.fp(dis));
        bus.emit('disabledClick', dis);
      }
    }),
    on(D, 'click', (e: MouseEvent) => {
      const el = elOf(e);
      if (!el || skip(el)) return;
      const target = el.closest(INTERACTIVE) || el;
      const fp = ctx.fp(target);
      // Synchronous part stays cheap (no layout/style reads): errors thrown by the
      // site's own handler and native validation must see this click first.
      crumb('click', fp);
      act();
      bus.emit('click', { el: target, fp, e });
      const { clientX: cx, clientY: cy, pageX: px, pageY: py, detail } = e;
      if (detail === 0) return; // keyboard-activated: no coordinates
      // Repeated clicks in a text field or that select text are selection, not rage.
      const selecting = isEditable(target) || (detail > 1 && !!D.getSelection()?.toString());
      frus.click(cx, cy, fp, selecting || !!el.closest(MULTI));
      const m0 = mut,
        n0 = net,
        u0 = location.href,
        a0 = D.activeElement;
      afterPaint(() => {
        const live = target.isConnected;
        const r = live ? target.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
        if (F.heatmaps)
          emit({
            t: 'c',
            el: fp,
            rx: r.width ? Math.round(((cx - r.left) / r.width) * 1000) : 0,
            ry: r.height ? Math.round(((cy - r.top) / r.height) * 1000) : 0,
            x: Math.round(px),
            y: Math.round(py),
            dev: device(),
          });
        if (!live) return;
        const cs = getComputedStyle(target);
        if (!target.matches(':disabled') && (+cs.opacity < 0.6 || /\bdisabled\b/.test(String(target.className)))) {
          frus.disabled(fp, { styled: 1 });
          bus.emit('disabledClick', target);
        }
        if (detail >= 2 || /^(INPUT|TEXTAREA|SELECT|OPTION|LABEL)$/.test(el.tagName) || (el as HTMLElement).isContentEditable) return;
        if (W.getSelection?.()?.toString()) return;
        const interactive = target !== el || target.matches(INTERACTIVE);
        const pointer = cs.cursor === 'pointer';
        const linkish = !interactive && (/underline/.test(cs.textDecorationLine || '') || el.tagName === 'IMG');
        if (!interactive && !pointer && !linkish) return;
        // These leave the page by design, so nothing changing here is expected.
        if (target.closest('a[target=_blank],a[download],a[href^=mailto],a[href^=tel]')) return;
        setTimeout(() => {
          const a = D.activeElement;
          const moved = a !== a0 && a !== target && !target.contains(a);
          if (mut === m0 && net === n0 && location.href === u0 && !moved) {
            const k = interactive || pointer ? 'dead' : 'fake';
            frus.signal(k, fp);
            bus.emit('deadClick', { el: target, kind: k });
          }
        }, 1000);
      });
    }),
  );

  // Pointer movement: rAF-sampled, never reads layout.
  let mx = 0,
    my = 0,
    raf = 0,
    last = 0;
  offs.push(
    on(D, 'mousemove', (e: MouseEvent) => {
      mx = e.clientX;
      my = e.clientY;
      pointerSeen = true;
      bus.emit('move', e);
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          const t = now();
          frus.move(mx, t);
          if (t - last < 100 || !F.heatmaps) return;
          last = t;
          const k = Math.round((mx + scrollX) / 20) + ',' + Math.round((my + scrollY) / 20);
          grid.set(k, (grid.get(k) || 0) + 1);
          if (grid.size > 400) pushMoves();
        });
    }),
  );

  let sraf = 0;
  offs.push(
    on(W, 'scroll', () => {
      if (!sraf)
        sraf = requestAnimationFrame(() => {
          sraf = 0;
          frus.scroll(scrollY);
          bus.emit('scroll');
        });
    }),
    on(D, 'keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (!pointerSeen) frus.kb = true;
      setTimeout(() => {
        const a = D.activeElement;
        if (a && a !== D.body && !skip(a)) frus.tab(ctx.fp(a));
      }, 0);
    }),
    on(D, 'input', (e: InputEvent) => {
      const el = elOf(e);
      if (!el || !isEditable(el) || skip(el)) return;
      lastTyping = now();
      act();
      const it = e.inputType || '';
      const v = (el as HTMLInputElement).value ?? '';
      const search = (el as HTMLInputElement).type === 'search' || el.getAttribute('role') === 'searchbox' || el.getAttribute('role') === 'combobox';
      frus.input(ctx.fp(el), it === 'insertFromPaste' ? 'paste' : !v ? 'clear' : it.startsWith('delete') ? 'del' : 'ins', search);
      bus.emit('typing', el);
    }),
  );

  // DOM mutations: activity counter (dead clicks) + UI error text.
  let pending: Element[] = [];
  let mtimer: any = 0;
  const mo = new MutationObserver((list) => {
    let counted = false;
    for (const m of list) {
      if (isOurs(m.target)) continue;
      if (!counted) {
        mut++;
        counted = true;
      }
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => n.nodeType === 1 && !isOurs(n) && pending.length < 50 && pending.push(n as Element));
      } else if (m.attributeName === 'aria-invalid') {
        const el = m.target as Element;
        if (el.getAttribute('aria-invalid') === 'true') pending.push(el);
        else frus.valid(ctx.fp(el));
      } else {
        // error text revealed by toggling hidden / class / style
        const el = m.target as HTMLElement;
        if (pending.length < 50 && !el.hidden && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && el.matches?.(UI_SEL) && !isOurs(el)) pending.push(el);
      }
    }
    if (pending.length && !mtimer)
      mtimer = setTimeout(() => {
        mtimer = 0;
        const nodes = pending;
        pending = [];
        idle(() => bus.emit('dom', nodes));
      }, 250);
  });
  mo.observe(D.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-invalid', 'class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked', 'data-state'],
  });
  offs.push(() => mo.disconnect());

  if ('ResizeObserver' in W) {
    const ro = new ResizeObserver((en) => (docW = Math.max(1, en[0].contentRect.width)));
    ro.observe(D.documentElement);
    offs.push(() => ro.disconnect());
  }

  function pushMoves() {
    if (!grid.size) return;
    emit({ t: 'mv', g: [...grid].map(([k, n]) => [...k.split(',').map(Number), n]), w: Math.round(docW), dev: device() });
    grid = new Map();
  }

  // Did the visitor do anything on this page (click / type)? Kept in session storage so it survives full page loads.
  let acted = false;
  const act = () => {
    if (!acted) {
      acted = true;
      sset('act', 1, true);
    }
  };
  let first = true;
  const path = (x: string) => x.split(/[?#]/)[0];

  /** Navigation-pattern signals, once per page view. */
  function navSignals() {
    const u = pageUrl(location.href);
    const t = Date.now();
    const touched = sget<number>('act', 0, true);
    sset('act', 0, true);
    acted = false;
    const h = sget<{ u: string; t: number }[]>('nav', [], true).filter((x) => t - x.t < 600000);
    const prev = h[h.length - 1];
    // The navigation type describes the document load only: later SPA route changes are never reloads.
    const navType = first ? (performance.getEntriesByType?.('navigation')[0] as any)?.type : '';
    first = false;
    if (prev && prev.u === u && navType === 'reload') {
      const r = sget<number[]>('reloads', [], true).filter((x) => t - x < 60000);
      r.push(t);
      sset('reloads', r, true);
      if (r.length >= 3) frus.signal('refresh', undefined, { n: r.length });
    } else {
      const p2 = h[h.length - 2];
      // Bounced straight back (browser Back): a different page, left within 5s with no click or typing on it.
      // Closing a dialog or switching a tab by clicking is navigation, not a U-turn.
      if (p2 && p2.u === u && path(prev.u) !== path(u) && t - prev.t < 5000 && !touched) frus.signal('uturn', undefined, { from: prev.u });
      const seq = h.slice(-3).map((x) => x.u).concat(u);
      // A, B, A, B on two different pages within 30s
      if (seq.length === 4 && seq[0] === seq[2] && seq[1] === seq[3] && path(seq[0]) !== path(seq[1]) && t - h[h.length - 3].t < 30000)
        frus.signal('loop', undefined, { a: seq[0], b: seq[1] });
      const sub = sget<number>('sub', 0, true);
      if (navType === 'back_forward' && sub && t - sub < 8000) frus.signal('qback');
      h.push({ u, t });
    }
    sset('nav', h.slice(-10), true);
  }

  return {
    summarize: pushMoves,
    navSignals,
    lastTyping: () => lastTyping,
    stop: () => offs.forEach((f) => f()),
  };
}

export type Capture = ReturnType<typeof startCapture>;
