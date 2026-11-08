import { randomBytes } from 'node:crypto';
import type { Db } from './db';

/** Settings a site pushes to its script through GET /config (lowest priority: the embed can override). */
export interface SiteConfig {
  sampleRate?: number;
  mask?: boolean;
  consent?: 'auto' | 'required' | 'none';
  network?: 'observe' | 'wrap' | 'off';
  console?: boolean;
  features?: Partial<Record<(typeof FEATURES)[number], boolean>>;
  funnels?: { name: string; steps: string[] }[];
  ignore?: string[];
}

export interface Site {
  id: string;
  name: string;
  /** Host patterns allowed to send events: `example.com`, `*.example.com`, `localhost:*`. */
  domains: string[];
  /** Public keys (the embed's data-key). The first one is shown in the snippet. */
  keys: string[];
  config: SiteConfig;
  /** Null: the server default. */
  retentionDays: number | null;
  /** Paused sites tell their script to stay off and drop anything sent anyway. */
  paused: boolean;
  createdAt: number;
}

export const FEATURES = ['analytics', 'heatmaps', 'errors', 'forms', 'vitals', 'snapshots', 'replay'] as const;

export class SiteError extends Error {}

const newId = () => 'st_' + randomBytes(6).toString('hex');
export const newKey = () => 'pk_' + randomBytes(12).toString('base64url');

/** `https://Shop.example.com/path` -> `shop.example.com`; `localhost:*` stays. Null if not a host pattern. */
export function normDomain(raw: string): string | null {
  let s = String(raw || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '');
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:(\d{1,5}|\*))?$/.test(s) && !/^\[[0-9a-f:]+\](:(\d{1,5}|\*))?$/.test(s)) return null;
  return s;
}

/** Does `host` (`name[:port]`, as in an Origin) match the pattern? `*.` covers subdomains, `:*` any port. */
export function domainMatch(pattern: string, host: string) {
  const [pn, pp] = splitPort(pattern);
  const [hn, hp] = splitPort(host.toLowerCase());
  if (pp !== '*' && pp !== hp) return false;
  return pn.startsWith('*.') ? hn.endsWith(pn.slice(1)) && hn.length > pn.length - 1 : pn === hn;
}
const splitPort = (h: string): [string, string] => {
  const m = /^(.*?)(?::(\d+|\*))?$/.exec(h)!;
  return [m[1], m[2] || ''];
};

/** Host of an Origin / Referer URL, or '' if there isn't one. */
export function hostOf(url: string | undefined | null) {
  try {
    return url ? new URL(url).host.toLowerCase() : '';
  } catch {
    return '';
  }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strs = (v: unknown, max: number, len = 200) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, len)).filter(Boolean))].slice(0, max) : [];

/** Keeps only known settings with valid values. Throws SiteError on a value that can't be right. */
export function cleanConfig(c: unknown): SiteConfig {
  if (!isObj(c)) return {};
  const o: SiteConfig = {};
  if (c.sampleRate != null) {
    const r = Number(c.sampleRate);
    if (!(r >= 0 && r <= 1)) throw new SiteError('Sample rate must be between 0 and 100%.');
    o.sampleRate = Math.round(r * 1000) / 1000;
  }
  if (c.mask != null) o.mask = !!c.mask;
  if (c.console != null) o.console = !!c.console;
  if (c.consent != null) {
    if (!['auto', 'required', 'none'].includes(c.consent)) throw new SiteError('Consent must be auto, required or none.');
    o.consent = c.consent;
  }
  if (c.network != null) {
    if (!['observe', 'wrap', 'off'].includes(c.network)) throw new SiteError('Network capture must be observe, wrap or off.');
    o.network = c.network;
  }
  if (isObj(c.features)) {
    o.features = {};
    for (const f of FEATURES) if (c.features[f] != null) o.features[f] = !!c.features[f];
  }
  if (c.funnels != null) {
    if (!Array.isArray(c.funnels)) throw new SiteError('Funnels must be a list.');
    o.funnels = c.funnels
      .filter(isObj)
      .map((f) => ({ name: String(f.name || '').trim().slice(0, 60), steps: strs(f.steps, 20, 300) }))
      .filter((f) => f.name && f.steps.length >= 2)
      .slice(0, 30);
  }
  if (c.ignore != null) o.ignore = strs(c.ignore, 50, 300);
  return o;
}

interface Row {
  id: string;
  name: string;
  domains: string;
  keys: string;
  config: string;
  retention_days: number | null;
  paused: number;
  created_at: number;
}
const parse = (s: string, d: any) => {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};
const fromRow = (r: Row): Site => ({
  id: r.id,
  name: r.name,
  domains: parse(r.domains, []),
  keys: parse(r.keys, []),
  config: parse(r.config, {}),
  retentionDays: r.retention_days == null ? null : Number(r.retention_days),
  paused: !!r.paused,
  createdAt: Number(r.created_at),
});

export interface SiteInput {
  name?: unknown;
  domains?: unknown;
  config?: unknown;
  retentionDays?: unknown;
  paused?: unknown;
}

/**
 * The sites this server collects for. Kept in memory (it is read on every
 * request) and written through to SQLite.
 */
export class Sites {
  private all = new Map<string, Site>();
  /** Batches turned away, per site and origin, so the dashboard can say why a site is silent. */
  rejected = new Map<string, Map<string, { n: number; last: number }>>();

  constructor(private db: Db) {
    for (const r of db.prepare('SELECT * FROM sites ORDER BY created_at').all() as unknown as Row[]) this.all.set(r.id, fromRow(r));
  }

  list() {
    return [...this.all.values()];
  }
  get(id: string) {
    return this.all.get(id) || null;
  }

  create(input: SiteInput & { keys?: string[]; id?: string }) {
    const s: Site = { id: input.id || newId(), name: '', domains: [], keys: input.keys?.length ? input.keys : [newKey()], config: {}, retentionDays: null, paused: false, createdAt: Date.now() };
    this.apply(s, { name: input.name ?? '', domains: input.domains ?? [], config: input.config, retentionDays: input.retentionDays, paused: input.paused });
    this.save(s);
    return s;
  }

  update(id: string, input: SiteInput) {
    const s = this.get(id);
    if (!s) return null;
    const next = structuredClone(s);
    this.apply(next, input);
    this.save(next);
    return next;
  }

  private apply(s: Site, i: SiteInput) {
    if (i.name !== undefined) {
      const n = String(i.name || '').trim().slice(0, 80);
      if (!n) throw new SiteError('Give the site a name.');
      s.name = n;
    }
    if (i.domains !== undefined) {
      if (!Array.isArray(i.domains)) throw new SiteError('Domains must be a list.');
      const out: string[] = [];
      for (const d of i.domains) {
        if (typeof d === 'string' && !d.trim()) continue;
        const n = normDomain(String(d));
        if (!n) throw new SiteError(`"${String(d).slice(0, 80)}" is not a domain. Use a host like shop.example.com, *.example.com or localhost:3000.`);
        if (!out.includes(n)) out.push(n);
      }
      if (!out.length) throw new SiteError('Add at least one domain the site runs on.');
      s.domains = out.slice(0, 50);
    }
    if (i.config !== undefined) s.config = cleanConfig(i.config);
    if (i.retentionDays !== undefined) {
      if (i.retentionDays === null || i.retentionDays === '') s.retentionDays = null;
      else {
        const d = Math.round(Number(i.retentionDays));
        if (!(d >= 1 && d <= 3650)) throw new SiteError('Retention must be between 1 and 3650 days.');
        s.retentionDays = d;
      }
    }
    if (i.paused !== undefined) s.paused = !!i.paused;
  }

  private save(s: Site) {
    this.db
      .prepare(
        `INSERT INTO sites (id, name, domains, keys, config, retention_days, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, domains = excluded.domains, keys = excluded.keys, config = excluded.config,
           retention_days = excluded.retention_days, paused = excluded.paused`,
      )
      .run(s.id, s.name, JSON.stringify(s.domains), JSON.stringify(s.keys), JSON.stringify(s.config), s.retentionDays, s.paused ? 1 : 0, s.createdAt);
    this.all.set(s.id, s);
  }

  /** Replaces the site's primary key. Older keys keep working until removed, so live embeds don't break. */
  rotateKey(id: string) {
    const s = this.get(id);
    if (!s) return null;
    const next = { ...s, keys: [newKey(), ...s.keys].slice(0, 10) };
    this.save(next);
    return next;
  }

  removeKey(id: string, key: string) {
    const s = this.get(id);
    if (!s) return null;
    if (s.keys.length <= 1) throw new SiteError('A site needs at least one key.');
    const next = { ...s, keys: s.keys.filter((k) => k !== key) };
    this.save(next);
    return next;
  }

  remove(id: string) {
    this.db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    this.rejected.delete(id);
    return this.all.delete(id);
  }

  /**
   * The site a batch belongs to: its key must be one of the site's keys and
   * the page's host one of its domains. A key shared by several sites (an old
   * shared dev key) is told apart by host; an exact domain beats a wildcard.
   */
  resolve(key: string | null, host: string): { site: Site | null; error?: string } {
    if (!key) return { site: null, error: 'missing site key' };
    const owners = this.list().filter((s) => s.keys.includes(key));
    if (!owners.length) return { site: null, error: 'unknown site key' };
    let best: Site | null = null;
    let rank = 0;
    for (const s of owners)
      for (const d of s.domains)
        if (host && domainMatch(d, host)) {
          const r = d.includes('*') ? 1 : 2;
          if (r > rank) (best = s), (rank = r);
        }
    if (best) return { site: best };
    for (const s of owners) this.reject(s.id, host || '(no origin)');
    return { site: null, error: 'this domain is not registered for the site' };
  }

  private reject(id: string, host: string) {
    let m = this.rejected.get(id);
    if (!m) this.rejected.set(id, (m = new Map()));
    const r = m.get(host) || { n: 0, last: 0 };
    r.n++;
    r.last = Date.now();
    m.set(host, r);
    if (m.size > 20) m.delete(m.keys().next().value!);
  }

  /** Any site may send from this host. Used for CORS. */
  hostAllowed(host: string) {
    return !!host && this.list().some((s) => s.domains.some((d) => domainMatch(d, host)));
  }

  /** The site whose domain is exactly / most specifically this host (the on-site heatmap asks by host). */
  forHost(host: string) {
    let best: Site | null = null;
    let rank = 0;
    for (const s of this.list())
      for (const d of s.domains)
        if (domainMatch(d, host)) {
          const r = d.includes('*') ? 1 : 2;
          if (r > rank) (best = s), (rank = r);
        }
    return best;
  }
}
