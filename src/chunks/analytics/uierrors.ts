import type { Ctx } from '../../core/types';
import { UI_SEL } from '../../core/errors';

const ERR_WORDS = /\b(invalid|required|failed|error|try again|incorrect|not valid|must be|too (short|long)|unable|problem)\b/i;

/** Nearest form field an error message refers to. */
export function fieldFor(node: Element): Element | null {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) return node;
  const id = node.id;
  if (id) {
    const f = node.ownerDocument.querySelector(`[aria-describedby~="${id}"],[aria-errormessage="${id}"]`);
    if (f) return f;
  }
  let p: Element | null = node;
  for (let i = 0; p && i < 3; i++, p = p.parentElement) {
    const f = p.querySelector('input:not([type=hidden]),select,textarea');
    if (f) return f;
  }
  return null;
}

/** The message shown for an invalid field: aria-errormessage / aria-describedby text, else the native message. */
function fieldError(f: HTMLInputElement) {
  for (const a of ['aria-errormessage', 'aria-describedby']) {
    const t = (f.getAttribute(a) || '')
      .split(/\s+/)
      .map((id) => id && document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ');
    if (t) return t;
  }
  return f.validationMessage || 'Invalid value';
}

/** Error messages shown in the page UI, from nodes the core's mutation pipeline batched up. */
export function scanUiErrors(ctx: Ctx, nodes: Element[]) {
  for (const n of nodes) {
    // CSS-in-JS libraries inject <style> text full of ".error" / ":invalid" rules: that is code, not a message shown to anyone.
    if (/^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE|LINK|META|svg|SVG)$/.test(n.tagName)) continue;
    let hits: Element[] = [];
    if (n.matches?.(UI_SEL)) hits.push(n);
    if (n.querySelectorAll) hits = hits.concat([...n.querySelectorAll(UI_SEL)].slice(0, 5));
    if (!hits.length && n.childElementCount < 3) {
      const t = n.textContent || '';
      if (t.length < 160 && ERR_WORDS.test(t)) hits.push(n);
    }
    for (const h of hits) {
      const isField = /^(INPUT|SELECT|TEXTAREA)$/.test(h.tagName);
      const text = isField ? fieldError(h as HTMLInputElement) : (h.textContent || '').trim();
      if (!text) continue;
      const f = fieldFor(h);
      const fp = f ? ctx.fp(f) : undefined;
      ctx.report('ui', text, { el: fp, node: f });
      if (fp) ctx.frus.invalid(fp);
    }
  }
}
