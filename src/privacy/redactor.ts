/**
 * Everything that leaves the page passes through here. Input values are never
 * sent at all; this masks PII-looking substrings in text we do send (labels,
 * error messages, URLs, titles, stack traces).
 */
const RULES: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[iban]'],
  [/\b\d(?:[ -]?\d){12,18}\b/g, '[card]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  [/(?:\+?\d{1,2}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, '[phone]'],
  [/\b\d{6,}\b/g, '[num]'],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, '[token]'],
];

export function redact(s: string, max = 300): string {
  if (!s) return '';
  let out = String(s).replace(/\s+/g, ' ').trim();
  if (out.length > max) out = out.slice(0, max) + '…';
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

const SEG_ID = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|(?=.*\d)[A-Za-z0-9_-]{16,})$/i;

function normPath(url: URL, base: string): string {
  const path = url.pathname
    .split('/')
    .map((s) => (SEG_ID.test(s) ? ':id' : s.includes('@') ? ':email' : s))
    .join('/');
  const origin = url.origin === new URL(base).origin ? '' : url.host;
  return origin + path;
}

/** Path with id-like segments normalized and query values dropped (keys kept). For resource URLs. */
export function normUrl(u: string, base = location.href): string {
  try {
    const url = new URL(u, base);
    const keys = [...new Set([...url.searchParams.keys()])].sort();
    return normPath(url, base) + (keys.length ? '?' + keys.join('&') : '');
  } catch {
    return '';
  }
}

/**
 * Page identity for snapshots and replay. Like normUrl, but the query string and
 * hash stay, so two dialogs of the same screen (`?item=A` and `?item=B`) are
 * different pages and never share a snapshot.
 */
export const HEAT = 'assist-heatmap';
export function pageUrl(u: string, base = location.href): string {
  try {
    const url = new URL(u, base);
    // The on-site heatmap token is ours, not part of the page: never record it.
    if (url.searchParams.has(HEAT)) url.searchParams.delete(HEAT);
    return normPath(url, base) + url.search + url.hash;
  } catch {
    return '';
  }
}

const SENSITIVE_NAME =
  /pass|pwd|ssn|social.?sec|tax.?id|\btin\b|card|cvv|cvc|ccv|\bpin\b|secret|token|otp|routing|account.?(no|num)|iban|dob|birth|license.?no/i;
const SENSITIVE_AC = /^(cc-|new-password|current-password|one-time-code)/;

export function isSensitive(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest('[data-assist-ignore],[data-assist-sensitive]')) return true;
  const i = el as HTMLInputElement;
  const type = (i.type || '').toLowerCase();
  if (type === 'password' || type === 'hidden') return true;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (SENSITIVE_AC.test(ac)) return true;
  const id = `${i.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${
    el.getAttribute('placeholder') || ''
  }`;
  return SENSITIVE_NAME.test(id);
}

/** Shape of a value without the value: length + character class. */
export function shape(v: string): { len: number; cls: string } {
  const len = v.length;
  let cls = '';
  if (!len) cls = 'e';
  else if (/^\d+$/.test(v)) cls = 'd';
  else if (/^[a-z\s'-]+$/i.test(v)) cls = 'a';
  else if (/@/.test(v)) cls = '@';
  else if (/^[\d\s/.:-]+$/.test(v)) cls = 'f';
  else cls = 'm';
  return { len, cls };
}
