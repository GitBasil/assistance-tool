/**
 * Who is browsing, taken only from the script tag:
 * `data-who="/passport|currentIdentity.userIdentifier|currentIdentity.displayName|currentIdentity.email"`
 * url fragment, then the id path, the name path, and the email path. No tag, no identity.
 */

export interface WhoSpec {
  url: string;
  id: string;
  name: string;
  email: string;
}

export function whoSpec(raw?: string | null): WhoSpec {
  const [url = '', id = '', name = '', email = ''] = String(raw || '')
    .split('|')
    .map((part) => part.trim());
  return { url, id, name, email };
}

const text = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

const at = (body: unknown, path: string) => {
  let cur: unknown = body;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return text(cur, 120);
};

/** Read exactly the paths in the tag. Anything else in the payload is ignored. */
export function readWho(body: unknown, spec: WhoSpec) {
  if (!spec.id && !spec.name && !spec.email) return null;
  const id = spec.id ? at(body, spec.id).slice(0, 64) : '';
  const name = spec.name ? at(body, spec.name).slice(0, 80) : '';
  const email = spec.email ? at(body, spec.email) : '';
  return id || name || email ? { id, name, email } : null;
}

export function applyWho(body: unknown) {
  const who = readWho(body, whoSpec((window as any).Assist?._ws));
  if (!who) return;
  const traits: { name?: string; email?: string } = {};
  if (who.name) traits.name = who.name;
  if (who.email) traits.email = who.email;
  (window as any).Assist?.identify?.(who.id || traits, traits);
}

/** Watches the request named by `data-who`. Does nothing when the attribute is absent. */
export function watchWho(hint?: string | null) {
  const h = String(hint || '').split('|')[0].toLowerCase();
  if (!h) return;
  const w = window as any;
  const orig = w.fetch;
  if (typeof orig !== 'function' || orig.aw) return;
  if (w.Assist) w.Assist._ws = hint;
  w.fetch = function (this: unknown) {
    const input = arguments[0];
    const url = String(typeof input === 'string' ? input : input?.url || '').toLowerCase();
    const pending = orig.apply(this, arguments);
    if (!url.includes(h)) return pending;
    return pending.then((res: Response) => {
      if (res?.ok)
        res
          .clone()
          .json()
          .then((body: unknown) => {
            const a = w.Assist;
            if (a?._who) a._who(body);
            else if (a) a._wb = body;
          })
          .catch(() => {});
      return res;
    });
  };
  w.fetch.aw = 1;
}
