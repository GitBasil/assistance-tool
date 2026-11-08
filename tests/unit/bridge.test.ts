// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../bridge/db';
import { Store, type StoredEvent } from '../../bridge/store';
import { Sites, SiteError, cleanConfig, domainMatch, normDomain } from '../../bridge/sites';
import { loadConfig } from '../../bridge/config';
import { hostOk, originAllowed, selfOrigin } from '../../bridge/security';

const tmp = () => mkdtempSync(join(tmpdir(), 'assist-'));
const ev = (o: Partial<StoredEvent> = {}): StoredEvent => ({ t: 'pv', at: Date.now(), sid: 's1', vid: 'v1', pid: 'p1', site: 'a', u: '/', dev: 'd', grp: 'c', bot: 0, ...o });

describe('domains', () => {
  it.each([
    ['https://Shop.Example.com/path?q', 'shop.example.com'],
    ['localhost:3000', 'localhost:3000'],
    ['*.example.com', '*.example.com'],
    ['localhost:*', 'localhost:*'],
    ['not a domain', null],
    ['javascript:alert(1)', null],
    ['', null],
  ])('normDomain(%s) = %s', (raw, want) => expect(normDomain(raw)).toBe(want));

  it.each([
    ['example.com', 'example.com', true],
    ['example.com', 'example.com:8080', false],
    ['*.example.com', 'app.example.com', true],
    ['*.example.com', 'example.com', false],
    ['*.example.com', 'example.com.evil.net', false],
    ['*.example.com', 'evilexample.com', false],
    ['localhost:*', 'localhost:5173', true],
    ['localhost:*', 'localhost', true], // any port, the default one too
    ['localhost:3000', 'localhost:3001', false],
  ])('%s matches %s: %s', (p, h, want) => expect(domainMatch(p, h)).toBe(want));
});

describe('site registry', () => {
  let sites: Sites;
  beforeEach(() => (sites = new Sites(openDb(':memory:'))));

  it('creates a site with a fresh key, normalized domains, and survives a reload', () => {
    const db = openDb(':memory:');
    const s = new Sites(db).create({ name: ' Shop ', domains: ['https://shop.example.com/', 'shop.example.com', '*.example.com'] });
    expect(s).toMatchObject({ name: 'Shop', domains: ['shop.example.com', '*.example.com'], paused: false });
    expect(s.keys[0]).toMatch(/^pk_[\w-]{16}$/);
    expect(new Sites(db).get(s.id)).toEqual(s);
  });

  it('refuses bad input with a message a person can act on', () => {
    expect(() => sites.create({ name: '', domains: ['a.com'] })).toThrow(SiteError);
    expect(() => sites.create({ name: 'x', domains: [] })).toThrow(/at least one domain/);
    expect(() => sites.create({ name: 'x', domains: ['nope nope'] })).toThrow(/not a domain/);
    expect(() => sites.create({ name: 'x', domains: ['a.com'], retentionDays: 0 })).toThrow(/Retention/);
  });

  it('resolves a batch by key and domain, preferring an exact domain over a wildcard', () => {
    const wild = sites.create({ name: 'Dev', domains: ['localhost:*'], keys: ['shared'] });
    const shield = sites.create({ name: 'Shield', domains: ['localhost:3000'], keys: ['pk_x', 'shared'] });
    expect(sites.resolve('shared', 'localhost:3000').site?.id).toBe(shield.id);
    expect(sites.resolve('shared', 'localhost:5173').site?.id).toBe(wild.id);
    expect(sites.resolve('pk_x', 'localhost:3000').site?.id).toBe(shield.id);
  });

  it('rejects unknown keys and unregistered domains, and remembers who was turned away', () => {
    const s = sites.create({ name: 'Shop', domains: ['shop.example.com'] });
    expect(sites.resolve('nope', 'shop.example.com')).toMatchObject({ site: null, error: 'unknown site key' });
    expect(sites.resolve(s.keys[0], 'evil.net')).toMatchObject({ site: null });
    expect(sites.resolve(null, 'shop.example.com').site).toBeNull();
    expect(sites.rejected.get(s.id)?.get('evil.net')?.n).toBe(1);
  });

  it('rotates keys without breaking the old one, and keeps at least one', () => {
    const s = sites.create({ name: 'Shop', domains: ['shop.example.com'] });
    const r = sites.rotateKey(s.id)!;
    expect(r.keys).toHaveLength(2);
    expect(r.keys[1]).toBe(s.keys[0]);
    const only = sites.removeKey(s.id, s.keys[0])!;
    expect(only.keys).toEqual([r.keys[0]]);
    expect(() => sites.removeKey(s.id, r.keys[0])).toThrow(/at least one key/);
  });

  it('keeps only known script settings with valid values', () => {
    expect(cleanConfig({ sampleRate: 0.25, mask: 1, features: { replay: false, bogus: true }, funnels: [{ name: 'f', steps: ['/a', '#b'] }, { name: 'one step', steps: ['/a'] }], evil: 1 })).toEqual({
      sampleRate: 0.25,
      mask: true,
      features: { replay: false },
      funnels: [{ name: 'f', steps: ['/a', '#b'] }],
    });
    expect(() => cleanConfig({ sampleRate: 2 })).toThrow(/Sample rate/);
    expect(() => cleanConfig({ consent: 'maybe' })).toThrow(/Consent/);
  });
});

describe('event store', () => {
  it('appends, replays by site and time, erases a visitor, deletes a site', () => {
    const dir = tmp();
    const store = new Store(openDb(':memory:'), dir);
    const t = Date.now();
    store.append([ev({ site: 'a', at: t - 5000 }), ev({ site: 'a', at: t, vid: 'v2' }), ev({ site: 'b', at: t })]);
    const seen = (o = {}) => {
      const out: StoredEvent[] = [];
      store.replay((e) => out.push(e), o);
      return out;
    };
    expect(seen()).toHaveLength(3);
    expect(seen({ site: 'a' })).toHaveLength(2);
    expect(seen({ site: 'a', since: t - 1000 })).toHaveLength(1);
    expect(store.counts().get('a')).toEqual({ events: 2, last: t });
    expect(store.eraseVisitor('v2', 'a')).toBe(1);
    store.saveSnapshot({ site: 'b', u: '/', h: 'h', w: 1, ht: 1, vw: 1, html: '<p>', at: t });
    expect(store.hasSnapshot('b', '/')).toBe(true);
    expect(store.deleteSite('b')).toBe(1);
    expect(store.hasSnapshot('b', '/')).toBe(false);
  });

  it('purges by each site’s own retention', () => {
    const store = new Store(openDb(':memory:'), tmp());
    const old = Date.now() - 10 * 86_400_000;
    store.append([ev({ site: 'short', at: old }), ev({ site: 'long', at: old })]);
    expect(store.purge((s) => (s === 'short' ? 7 : 30))).toBe(1);
    expect(store.counts().has('long')).toBe(true);
  });

  it('imports old NDJSON day files once, renaming sites, and keeps the files', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'events-2026-01-01.ndjson'), [JSON.stringify(ev({ site: 'localhost:3000' })), 'not json', JSON.stringify(ev({ site: 'localhost:5173' }))].join('\n') + '\n');
    const store = new Store(openDb(':memory:'), dir);
    expect(await store.importLegacy((h) => 'id-' + h)).toBe(2);
    expect([...store.counts().keys()].sort()).toEqual(['id-localhost:3000', 'id-localhost:5173']);
    expect(store.legacyFiles()).toEqual([]);
    expect(existsSync(join(dir, 'legacy', 'events-2026-01-01.ndjson'))).toBe(true);
    expect(await store.importLegacy((h) => h)).toBe(0);
  });
});

describe('server config', () => {
  it('reads the environment over the config file and derives accepted hosts', () => {
    const root = tmp();
    writeFileSync(join(root, 'bridge.config.json'), JSON.stringify({ port: 9000, retentionDays: 10 }));
    const c = loadConfig({ ASSIST_PUBLIC_URL: 'https://insights.example.com/', ASSIST_HOST: '0.0.0.0', ASSIST_DATA_DIR: join(root, 'd') }, root);
    expect(c).toMatchObject({ port: 9000, host: '0.0.0.0', retentionDays: 10, publicUrl: 'https://insights.example.com' });
    expect(c.allowedHosts).toContain('insights.example.com');
    expect(c.allowedHosts).toContain('localhost:9000');
    expect(readdirSync(join(root, 'd'))).toContain('.dashboard-token');
  });

  it('lists every invalid setting at once', () => {
    expect(() => loadConfig({ ASSIST_PORT: '0', ASSIST_PUBLIC_URL: 'ftp://x', ASSIST_RETENTION_DAYS: '-1', ASSIST_DATA_DIR: tmp() }, tmp())).toThrow(/port[\s\S]*publicUrl[\s\S]*retentionDays/);
  });
});

describe('request guards', () => {
  const cfg = { allowedHosts: ['insights.example.com', 'localhost', 'localhost:7821'], allowedOrigins: [], publicUrl: 'https://insights.example.com' };
  const sites = { hostAllowed: (h: string) => h === 'shop.example.com' };

  it('rejects DNS-rebinding hosts', () => {
    expect(hostOk({ headers: { host: 'localhost:7821' } } as any, cfg)).toBe(true);
    expect(hostOk({ headers: { host: 'insights.example.com' } } as any, cfg)).toBe(true);
    expect(hostOk({ headers: { host: 'attacker.com' } } as any, cfg)).toBe(false);
  });

  it.each([
    ['https://shop.example.com', true],
    ['https://evil.net', false],
    [undefined, false],
    ['null', false],
  ])('CORS for %s -> %s', (o, want) => expect(originAllowed(o as any, cfg, sites)).toBe(want));

  it('knows the dashboard’s own origin', () => {
    expect(selfOrigin(cfg, 'https://insights.example.com')).toBe(true);
    expect(selfOrigin(cfg, 'http://localhost:7821', { headers: { host: 'localhost:7821' } } as any)).toBe(true);
    expect(selfOrigin(cfg, 'https://shop.example.com', { headers: { host: 'insights.example.com' } } as any)).toBe(false);
  });
});
