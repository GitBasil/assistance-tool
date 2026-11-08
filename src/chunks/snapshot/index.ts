import type { Ctx } from '../../core/types';
import { fingerprint } from '../../page/selectors';
import { pageUrl, redact } from '../../privacy/redactor';
import { hash } from '../../core/util';
import { UI_ATTR } from '../../core/dom';

const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'OBJECT', 'EMBED']);
const ALWAYS = new Set(['HTML', 'HEAD', 'BODY', 'STYLE', 'LINK', 'META', 'BASE', 'TITLE']);
const PLACEHOLDER = new Set(['IFRAME', 'CANVAS', 'VIDEO', 'AUDIO']);
const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);
const KEEP_TEXT = 'label,h1,h2,h3,h4,h5,h6,button,a,legend,th,summary,option,nav,[role=button],[role=tab],[role=menuitem],[data-assist-unmask]';
const ATTRS = new Set(['class', 'id', 'role', 'type', 'name', 'for', 'width', 'height', 'style', 'colspan', 'rowspan', 'disabled', 'hidden', 'open', 'rel', 'media', 'lang', 'dir', 'viewbox', 'd', 'fill', 'stroke', 'xmlns', 'cx', 'cy', 'r', 'x', 'y', 'points', 'transform', 'data-testid']);
const REDACT_ATTRS = new Set(['alt', 'title', 'placeholder', 'aria-label']);
/** Attributes that change how a component looks without changing its children (a label floating up, a tab selected). */
const STATE = ['data-shrink', 'data-state', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mask = (s: string) => s.replace(/\S/g, '•');

/**
 * Script-free DOM snapshot used to render replays and heatmaps in the
 * dashboard (sandboxed iframe, no scripts); every element tagged with its
 * fingerprint. With `mask` on: text masked except labels / headings /
 * buttons / links, no field values, images replaced. With `mask` off the
 * page is copied as shown, field values included (password values never).
 * Serialized in idle slices (<8ms).
 */
export default function install(ctx: Ctx) {
  if (!ctx.session.recording) return {};
  if (!document.body) return {};
  const masked = ctx.cfg.mask;
  const red = (v: string, n: number) => (masked ? redact(v, n) : v);

  // The replay is a series of frames: every time the DOM settles after a
  // structural change (a dialog opens or closes, a list loads, the route
  // changes) we copy the page and send a `kf` event saying "from this moment
  // the page looked like snapshot <ch>". Identical states are uploaded once.
  const QUIET = 400;
  const MAX_WAIT = 3000;
  const MIN_GAP = 700;
  const MAX_SHOTS = 150;
  let busy = false;
  let pending = false;
  let dead = false;
  let shots = 0;
  let lastShot = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPoke = 0;
  /** When the DOM last changed: the moment the visitor started seeing the state we capture next. */
  let changedAt = ctx.now();
  const known = new Map<string, string>();
  const uploaded = new Set<string>();

  function frame(ch: string, at: number, href: string) {
    if (location.href !== href) return;
    ctx.send({ t: 'kf', h: ch, d: Math.max(0, Math.round(ctx.now() - at)) });
  }

  function finish() {
    busy = false;
    if (pending && !dead) {
      pending = false;
      poke();
    }
  }

  function poke() {
    if (dead) return;
    const t = Date.now();
    changedAt = ctx.now();
    if (!firstPoke) firstPoke = t;
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(QUIET, MAX_WAIT - (t - firstPoke)), lastShot + MIN_GAP - t);
    timer = setTimeout(go, wait);
  }

  function go() {
    firstPoke = 0;
    if (dead || shots >= MAX_SHOTS) return;
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    lastShot = Date.now();
    try {
      shoot();
    } catch {
      finish();
    }
  }

  function shoot() {
  const body = document.body;
  if (!body) return finish();
  const href = location.href;
  const at = changedAt;
  const tags: string[] = [];
  const all = body.getElementsByTagName('*');
  for (let i = 0; i < all.length && i < 3000; i++) {
    const el = all[i];
    tags.push(el.tagName + (el.getAttribute('class') || '') + STATE.map((a) => el.getAttribute(a) || '').join(''));
  }
  // Cheap fingerprint of what is on screen (structure + text), so a state we have
  // already serialized is only re-announced, not copied again.
  const h = hash(pageUrl(href) + (masked ? 'm' : 'p') + all.length + tags.join(',') + body.textContent);
  const seen = known.get(h);
  if (seen) {
    frame(seen, at, href);
    return finish();
  }
  shots++;

  const out: string[] = [];
  let size = 0;
  const MAX = 1_500_000;
  type Frame = { el: Element; i: number; keep: boolean };
  const stack: Frame[] = [];

  function open(el: Element, keep: boolean): boolean {
    const tag = el.tagName;
    if (SKIP.has(tag) || el.hasAttribute(UI_ATTR) || el.closest('[data-assist-ignore]')) return false;
    // Closed dialogs and alerts stay in the DOM hidden. Copying them makes the
    // replay show an error the visitor was not looking at.
    if (!ALWAYS.has(tag)) {
      if (el.hasAttribute('hidden')) return false;
      try {
        const cs = getComputedStyle(el);
        // Not `visibility: hidden`: such elements still take up space (an outlined field's
        // legend cuts the gap for its label that way), and the copied CSS keeps them invisible.
        if (cs.display === 'none') return false;
      } catch {}
    }
    if (PLACEHOLDER.has(tag)) {
      const r = el.getBoundingClientRect();
      out.push(`<div data-assist-fp="${esc(fingerprint(el))}" style="width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;background:#e5e7eb"></div>`);
      return false;
    }
    // SVG tag names are case-sensitive (clipPath, linearGradient). Lowercasing them
    // makes the browser drop the clip and the gradient, so a sheen paints as a black bar.
    const svg = el.namespaceURI === 'http://www.w3.org/2000/svg';
    let s = '<' + (svg ? tag : tag.toLowerCase());
    for (const a of el.attributes) {
      const n = a.name.toLowerCase();
      if (svg) {
        if (n.startsWith('on') || ((n === 'href' || n.endsWith(':href')) && /^\s*javascript:/i.test(a.value))) continue;
        s += ` ${a.name}="${esc(a.value)}"`;
        continue;
      }
      if (ATTRS.has(n)) s += ` ${n}="${esc(REDACT_ATTRS.has(n) ? red(a.value, 80) : a.value)}"`;
      // Component styles key off these (MUI's data-shrink, aria-selected, data-state…).
      else if ((n.startsWith('aria-') || n.startsWith('data-')) && !n.startsWith('data-assist')) s += ` ${n}="${esc(red(a.value, 80))}"`;
      else if (REDACT_ATTRS.has(n)) s += ` ${n}="${esc(red(a.value, 80))}"`;
      else if (n === 'href') {
        if (tag === 'LINK' && /stylesheet|icon/.test(el.getAttribute('rel') || '')) s += ` href="${esc((el as HTMLLinkElement).href)}"`;
        else s += ' href="#"';
      } else if (n === 'value' && tag === 'INPUT' && /^(submit|button|reset)$/.test((el as HTMLInputElement).type)) s += ` value="${esc(red(a.value, 40))}"`;
    }
    if (tag === 'IMG') {
      if (masked) {
        const r = el.getBoundingClientRect();
        out.push(`<div data-assist-fp="${esc(fingerprint(el))}" style="display:inline-block;width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;background:#e5e7eb"></div>`);
        return false;
      } else {
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
        if (/^(https?:|data:image\/)/.test(src)) s += ` src="${esc(src)}"`;
      }
    }
    if (!masked) {
      // Live state, not the markup default: what the visitor actually sees in each field.
      if (tag === 'INPUT') {
        const i = el as HTMLInputElement;
        if (i.type === 'checkbox' || i.type === 'radio') s += i.checked ? ' checked' : '';
        else if (!/^(password|hidden|file|submit|button|reset)$/.test(i.type) && i.value) s += ` value="${esc(i.value.slice(0, 2000))}"`;
      } else if (tag === 'OPTION' && (el as HTMLOptionElement).selected) s += ' selected';
    }
    if (tag !== 'HTML' && tag !== 'HEAD' && tag !== 'BODY' && el.parentElement?.tagName !== 'HEAD') s += ` data-assist-fp="${esc(fingerprint(el))}"`;
    out.push(s + '>');
    if (tag === 'HEAD') out.push(`<base href="${esc(location.origin)}/">`);
    if (tag === 'STYLE') {
      let css = el.textContent || '';
      if (!css.trim()) {
        try {
          css = [...((el as HTMLStyleElement).sheet?.cssRules || [])].map((r) => r.cssText).join('\n');
        } catch {}
      }
      out.push(css.replace(/<\/style/gi, '<\\/style'));
      out.push('</style>');
      return false;
    }
    if (VOID.has(tag) || tag === 'TEXTAREA' || tag === 'IMG') {
      if (tag === 'TEXTAREA') {
        if (!masked) out.push(esc((el as HTMLTextAreaElement).value.slice(0, 20000)));
        out.push('</textarea>');
      }
      return false;
    }
    return true;
  }

  function text(n: Node, keep: boolean) {
    const t = n.nodeValue || '';
    if (!t.trim()) return out.push(esc(t));
    out.push(esc(!masked ? t : keep ? redact(t, 400) : mask(t)));
  }

  function step(deadline: { timeRemaining(): number }) {
    const t0 = performance.now();
    while (stack.length && size < MAX) {
      if (performance.now() - t0 > 5 || deadline.timeRemaining() < 1) return schedule();
      const f = stack[stack.length - 1];
      const kids = f.el.childNodes;
      if (f.i >= kids.length) {
        out.push(`</${f.el.tagName.toLowerCase()}>`);
        stack.pop();
        continue;
      }
      const n = kids[f.i++];
      if (n.nodeType === 3) text(n, f.keep);
      else if (n.nodeType === 1) {
        const el = n as Element;
        const keep = f.keep || el.matches(KEEP_TEXT);
        if (open(el, keep)) stack.push({ el, i: 0, keep });
      }
      size += out[out.length - 1]?.length || 0;
    }
    if (!stack.length || size >= MAX) ric(() => done('<!doctype html>' + out.join('')), { timeout: 3000 });
  }

  const ric = (window as any).requestIdleCallback || ((f: any) => setTimeout(() => f({ timeRemaining: () => 8 }), 50));
  const schedule = () => ric(step, { timeout: 3000 });

  // Join, stringify and upload each get their own idle task (each is O(page size)).
  async function done(html: string) {
    const ch = hash(html) + html.length.toString(36);
    if (!uploaded.has(ch)) {
      const meta = { h, ch, n: all.length, u: pageUrl(href), w: document.documentElement.scrollWidth, ht: document.documentElement.scrollHeight, vw: innerWidth };
      const payload = await new Promise<string>((res) => ric(() => res(JSON.stringify({ v: 1, snap: { ...meta, html } })), { timeout: 3000 }));
      try {
        let bodyData: BodyInit = payload;
        if ('CompressionStream' in window) bodyData = await new Response(new Blob([payload]).stream().pipeThrough(new (window as any).CompressionStream('gzip'))).blob();
        const r = await fetch(`${ctx.cfg.endpoint}/collect?k=${encodeURIComponent(ctx.cfg.key)}&s=${encodeURIComponent(ctx.cfg.site)}`, { method: 'POST', body: bodyData, headers: { 'content-type': 'text/plain' }, credentials: 'omit' });
        if (r.ok) uploaded.add(ch);
      } catch {}
    }
    if (uploaded.has(ch)) {
      known.set(h, ch);
      frame(ch, at, href);
    }
    finish();
  }

  const htmlEl = document.documentElement;
  if (open(htmlEl, false)) stack.push({ el: htmlEl, i: 0, keep: false });
  schedule();
  }

  // Structural changes and show/hide toggles count; text ticking (clocks, counters) does not.
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      const t = m.target as Element;
      if (t.nodeType === 1 && t.closest?.(`[${UI_ATTR}]`)) continue;
      poke();
      return;
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden', 'class', ...STATE] });
  const offRoute = ctx.bus.on('route', () => {
    shots = 0;
    poke();
  });
  ctx.bus.on('destroy', () => {
    dead = true;
    clearTimeout(timer);
    mo.disconnect();
    offRoute();
  });
  poke();
  return {};
}
