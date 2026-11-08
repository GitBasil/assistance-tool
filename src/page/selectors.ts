import { redact } from '../privacy/redactor';

/**
 * Element fingerprint: "selector|role|name". Stable across deploys and
 * viewports; generated ids/classes are rejected.
 */
const GEN_ID = /^:r|^ember\d|^ext-gen|^ng-|^mui-\d|^react-|[0-9a-f]{8}-[0-9a-f]{4}|\d{3,}|^[a-z]{1,3}\d+$/i;
const GEN_CLASS =
  /^(css|sc|jsx|emotion|svelte|tw|chakra|mantine|makeStyles)-|^[a-z]{1,3}-?(?=[A-Za-z]*\d)[A-Za-z0-9]{5,}$|__(?=[\w-]*[\dA-Z])[\w-]{5}$|_(?=[a-z]*\d)[a-z0-9]{5,}$|\d{2,}|^(is|has)-|^(active|hover|focus|open|show|selected|disabled|ng-|v-)/;
const ATTRS = ['data-assist-id', 'data-testid', 'data-test', 'data-cy', 'data-qa'];

export const esc = (s: string) =>
  (window as any).CSS?.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => '\\' + c);

export const stableId = (id: string) => !!id && id.length < 40 && !GEN_ID.test(id);
export const stableClass = (c: string) => c.length > 2 && c.length < 30 && !GEN_CLASS.test(c);

const ROLE_BY_TAG: Record<string, string> = {
  A: 'link',
  BUTTON: 'button',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  FORM: 'form',
  IMG: 'img',
  NAV: 'navigation',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  LABEL: 'label',
  SUMMARY: 'button',
  OPTION: 'option',
  LEGEND: 'legend',
  TH: 'columnheader',
};

export function role(el: Element): string {
  const r = el.getAttribute('role');
  if (r) return r;
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    return t === 'checkbox' || t === 'radio' ? t : t === 'submit' || t === 'button' ? 'button' : 'textbox';
  }
  return ROLE_BY_TAG[el.tagName] || '';
}

/** Accessible-ish name: aria, label, text, placeholder, title. */
export function accName(el: Element, max = 60): string {
  const a = el.getAttribute('aria-label');
  if (a) return a.trim().slice(0, max);
  const lb = el.getAttribute('aria-labelledby');
  if (lb) {
    const t = lb
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent || '')
      .join(' ')
      .trim();
    if (t) return t.slice(0, max);
  }
  const f = el as HTMLInputElement;
  if (f.labels && f.labels.length) return (f.labels[0].textContent || '').trim().slice(0, max);
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    return (el.getAttribute('placeholder') || el.getAttribute('title') || f.name || '').slice(0, max);
  }
  const txt = el.childElementCount > 8 ? '' : (el.textContent || '').slice(0, 400);
  return (txt.replace(/\s+/g, ' ').trim() || el.getAttribute('title') || el.getAttribute('alt') || '')
    .trim()
    .slice(0, max);
}

function own(el: Element): string | null {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) return `[${a}="${v.replace(/"/g, '\\"')}"]`;
  }
  if (stableId(el.id)) return '#' + esc(el.id);
  const n = el.getAttribute('name');
  if (n && /^(INPUT|SELECT|TEXTAREA|BUTTON|FORM)$/.test(el.tagName) && !GEN_ID.test(n))
    return `${el.tagName.toLowerCase()}[name="${n.replace(/"/g, '\\"')}"]`;
  return null;
}

function step(el: Element): string {
  let s = el.tagName.toLowerCase();
  const c = [...el.classList].find(stableClass);
  if (c) s += '.' + esc(c);
  const p = el.parentElement;
  if (p) {
    let i = 0,
      n = 0;
    for (const sib of p.children)
      if (sib.tagName === el.tagName) {
        n++;
        if (sib === el) i = n;
      }
    if (n > 1) s += `:nth-of-type(${i})`;
  }
  return s;
}

const cache = new WeakMap<Element, string>();

export function selector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let d = 0; cur && d < 5; d++) {
    const o = own(cur);
    if (o) {
      parts.unshift(o);
      break;
    }
    if (cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
    parts.unshift(step(cur));
    cur = cur.parentElement;
  }
  return parts.join('>');
}

export function fingerprint(el: Element): string {
  let f = cache.get(el);
  if (!f) {
    const r = role(el);
    const name = r || el.hasAttribute('data-assist-unmask') ? redact(accName(el, 40), 40).replace(/\|/g, '/') : '';
    f = `${selector(el)}|${r}|${name}`;
    cache.set(el, f);
  }
  return f;
}

/** Resolve a fingerprint (or plain selector) back to a live element. */
export function findByFp(fp: string, root: ParentNode = document): Element | null {
  if (!fp) return null;
  const [sel, r, name] = fp.split('|');
  try {
    const el = sel && root.querySelector(sel);
    if (el) return el;
  } catch {
    /* invalid selector */
  }
  if (!r && !name) return null;
  // fuzzy: same role + same accessible name
  const cand = root.querySelectorAll(
    'a,button,input,select,textarea,[role],label,h1,h2,h3,h4,[tabindex],form,img',
  );
  let best: Element | null = null;
  let bestScore = 0;
  for (const c of cand) {
    let s = 0;
    if (r && role(c) === r) s += 1;
    if (name && redact(accName(c, 40), 40) === name) s += 2;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return bestScore >= 3 ? best : null;
}
