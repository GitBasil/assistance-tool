import { accName, fingerprint, role } from './selectors';
import { isSensitive, redact } from '../privacy/redactor';
import { hash } from '../core/util';
import { UI_ATTR, FIELD } from '../core/dom';
import { deepAll } from './deep';

export interface FieldInfo {
  el: HTMLInputElement;
  fp: string;
  label: string;
  type: string;
  required: boolean;
  pattern?: string;
  min?: string;
  max?: string;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  title?: string;
  options?: string[];
  autocomplete?: string;
  invalid: boolean;
  empty: boolean;
  sensitive: boolean;
  form?: Element | null;
}
export interface Item {
  el: Element;
  fp: string;
  text: string;
}
export interface PageModel {
  title: string;
  path: string;
  headings: (Item & { level: number })[];
  fields: FieldInfo[];
  buttons: (Item & { primary: boolean; disabled: boolean })[];
  links: Item[];
  forms: Item[];
  errors: Item[];
  sections: Item[];
  hash: string;
}

export { deepAll };

const ours = (el: Element) => !!el.closest(`[${UI_ATTR}],[data-assist-ignore]`);
const shown = (el: Element) => {
  const e = el as HTMLElement;
  return !e.hidden && (e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
};

export function scan(): PageModel {
  const fields: FieldInfo[] = [];
  for (const el of deepAll(FIELD) as HTMLInputElement[]) {
    if (ours(el) || !shown(el)) continue;
    const opts = el.tagName === 'SELECT' ? [...(el as unknown as HTMLSelectElement).options].slice(0, 25).map((o) => redact(o.text, 60)) : undefined;
    fields.push({
      el,
      fp: fingerprint(el),
      label: redact(accName(el, 80), 80),
      type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text',
      required: el.required || el.getAttribute('aria-required') === 'true',
      pattern: el.getAttribute('pattern') || undefined,
      min: el.getAttribute('min') || undefined,
      max: el.getAttribute('max') || undefined,
      minLength: el.minLength > 0 ? el.minLength : undefined,
      maxLength: el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : undefined,
      placeholder: el.placeholder ? redact(el.placeholder, 60) : undefined,
      title: el.title ? redact(el.title, 120) : undefined,
      options: opts,
      autocomplete: el.getAttribute('autocomplete') || undefined,
      invalid: el.getAttribute('aria-invalid') === 'true' || (el.matches(':invalid') && !!el.value),
      empty: !el.value && !el.checked,
      sensitive: isSensitive(el),
      form: el.form || el.closest('form,[role=form]'),
    });
    if (fields.length >= 80) break;
  }
  const items = (sel: string, max: number) =>
    deepAll(sel)
      .filter((el) => !ours(el) && shown(el))
      .slice(0, max)
      .map((el) => ({ el, fp: fingerprint(el), text: redact(accName(el, 80), 80) }))
      .filter((x) => x.text);
  const buttons = items('button,[role=button],input[type=submit],input[type=button],a[class*=btn]', 60).map((b) => ({
    ...b,
    primary: b.el.matches('[type=submit],.btn-primary,[class*=primary],[class*=Primary]'),
    disabled: b.el.matches(':disabled,[aria-disabled=true]'),
  }));
  const headings = items('h1,h2,h3,[role=heading]', 40).map((x) => ({ ...x, level: +(x.el.tagName[1] || x.el.getAttribute('aria-level') || 2) }));
  const links = items('a[href]:not([class*=btn])', 60);
  const forms = deepAll('form,[role=form]')
    .filter((el) => !ours(el))
    .slice(0, 10)
    .map((el) => ({ el, fp: fingerprint(el), text: redact(el.getAttribute('aria-label') || el.getAttribute('name') || el.querySelector('legend,h1,h2,h3')?.textContent || 'form', 60) }));
  const errors = items('[role=alert],.error,.invalid-feedback,[aria-invalid=true]', 15);
  const sections = items('section[aria-label],section h2,fieldset legend,[role=region][aria-label],nav[aria-label]', 30);
  const structure = [...headings.map((x) => 'h' + x.text), ...fields.map((f) => f.fp), ...buttons.map((b) => b.fp)].join('\n');
  return {
    title: redact(document.title, 120),
    path: location.pathname,
    headings,
    fields,
    buttons,
    links,
    forms,
    errors,
    sections,
    hash: hash(location.pathname + '\n' + structure),
  };
}

/**
 * Compact, redacted page description for the AI. Elements get short refs
 * (e1, e2...) that the model uses to point at things; `refs` maps them back
 * to fingerprints. Never includes input values.
 */
export function summarize(m: PageModel, maxChars = 12000) {
  const refs: Record<string, string> = {};
  let n = 0;
  const ref = (fp: string) => {
    const r = 'e' + ++n;
    refs[r] = fp;
    return r;
  };
  const s: any = {
    title: m.title,
    path: m.path,
    headings: m.headings.map((x) => `${'#'.repeat(Math.min(x.level, 3))} ${x.text}`),
    fields: m.fields.map((f) => {
      const o: any = { ref: ref(f.fp), label: f.label, type: f.type };
      if (f.required) o.required = true;
      if (f.pattern) o.pattern = f.pattern;
      if (f.min) o.min = f.min;
      if (f.max) o.max = f.max;
      if (f.minLength) o.minLength = f.minLength;
      if (f.maxLength) o.maxLength = f.maxLength;
      if (f.placeholder) o.placeholder = f.placeholder;
      if (f.title) o.title = f.title;
      if (f.options) o.options = f.options;
      if (f.sensitive) o.sensitive = true;
      if (f.invalid) o.invalid = true;
      if (!f.empty) o.filled = true;
      return o;
    }),
    buttons: m.buttons.map((b) => ({ ref: ref(b.fp), text: b.text, ...(b.primary ? { primary: true } : {}), ...(b.disabled ? { disabled: true } : {}) })),
    links: m.links.slice(0, 40).map((l) => ({ ref: ref(l.fp), text: l.text })),
    sections: m.sections.map((x) => ({ ref: ref(x.fp), text: x.text })),
    errors: m.errors.map((e) => e.text),
  };
  let json = JSON.stringify(s);
  while (json.length > maxChars && (s.links.length || s.sections.length > 5 || s.headings.length > 10)) {
    if (s.links.length) s.links.splice(-10);
    else if (s.sections.length > 5) s.sections.splice(-5);
    else s.headings.splice(-5);
    json = JSON.stringify(s);
  }
  return { summary: s, refs };
}

export { role };
