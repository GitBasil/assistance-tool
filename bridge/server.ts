import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { loadConfig, ROOT, type BridgeConfig } from './config';
import { cors, hostOk, originAllowed, readBody, RateLimiter, HttpError, tokenOk, selfOrigin, clientIp, SECURITY_HEADERS, DASHBOARD_CSP } from './security';
import { Store, type StoredEvent } from './store';
import { Aggregator } from './aggregate';
import { openDb, type Db } from './db';
import { Sites, SiteError, hostOf, newKey, normDomain, type Site } from './sites';
import { log, setupLog } from './log';

const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const DIST = join(ROOT, 'dist');
const DASH = join(ROOT, 'bridge', 'dashboard');
const MAX_UNZIPPED = 4 * 1024 * 1024;
const RANGES: Record<string, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

let cfg: BridgeConfig;
let db: Db;
let store: Store;
let sites: Sites;
let agg = new Aggregator();
// Per client per minute. Watched pages upload up to ~4x/s each, and the live dashboard refetches on every batch.
const limiter = new RateLimiter({ collect: 6000, api: 6000, config: 600 });
const stats = { accepted: 0, rejected: 0, events: 0, snapshots: 0, started: Date.now() };

// ---------------- helpers ----------------
function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...headers })) res.setHeader(k, v);
  if (cfg?.publicUrl.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (body === undefined) return void res.writeHead(status).end();
  const s = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (!res.hasHeader('content-type')) res.setHeader('content-type', typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
  res.writeHead(status).end(s);
}

function parseJson(buf: Buffer): any {
  let b = buf;
  if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b, { maxOutputLength: MAX_UNZIPPED });
  return JSON.parse(b.toString('utf8'));
}

async function jsonBody(req: IncomingMessage) {
  try {
    return parseJson(await readBody(req, 64 * 1024));
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, 'Request body must be JSON.');
  }
}

const retention = (id: string) => sites.get(id)?.retentionDays ?? cfg.retentionDays;
const scriptUrl = () => cfg.publicUrl + '/assist.js';
const snippet = (s: Site) => `<script defer src="${scriptUrl()}" data-key="${s.keys[0]}"></script>`;

/** A site as the dashboard sees it: settings, embed snippet, health and headline numbers. */
function siteView(s: Site, counts = store.counts()) {
  const c = counts.get(s.id);
  const rej = [...(sites.rejected.get(s.id) || [])].map(([host, r]) => ({ host, ...r })).sort((a, b) => b.last - a.last);
  const sum = agg.summary(s.id);
  const last = Math.max(sum.lastEvent, c?.last || 0);
  const status = s.paused ? 'paused' : !last ? 'waiting' : Date.now() - last < 86_400_000 ? 'active' : 'quiet';
  return { ...s, retention: retention(s.id), snippet: snippet(s), status, stored: c?.events || 0, rejected: rej, ...sum, lastEvent: last };
}

// ---------------- date ranges ----------------
// "All" is the live aggregate. Shorter ranges are built from the database on demand, kept
// up to date with new events, and rebuilt every few minutes so old data slides out.
const ranged = new Map<string, { agg: Aggregator; built: number }>();
function aggFor(site: string, range: string | null) {
  const span = range ? RANGES[range] : 0;
  if (!span) return agg;
  const k = site + '|' + range;
  let r = ranged.get(k);
  if (!r || Date.now() - r.built > 5 * 60_000) {
    const a = new Aggregator();
    store.replay((e) => a.add(e), { site, since: Date.now() - span });
    ranged.set(k, (r = { agg: a, built: Date.now() }));
  }
  return r.agg;
}
/** Headline totals for the window just before the range, to show change. Null for "All". */
const previous = new Map<string, { o: ReturnType<Aggregator['overview']>; built: number }>();
function prevOverview(site: string, range: string | null) {
  const span = range ? RANGES[range] : 0;
  if (!span) return null;
  const k = site + '|' + range;
  let r = previous.get(k);
  if (!r || Date.now() - r.built > 5 * 60_000) {
    const a = new Aggregator();
    const now = Date.now();
    store.replay((e) => a.add(e), { site, since: now - 2 * span, until: now - span });
    previous.set(k, (r = { o: a.overview(site), built: now }));
  }
  const { sessions, pageviews, avgFrustration, errors, rage, dead } = r.o;
  return { sessions, pageviews, avgFrustration, errors, rage, dead };
}
function forgetRanges(site: string) {
  for (const k of previous.keys()) if (k.startsWith(site + '|')) previous.delete(k);
  for (const k of ranged.keys()) if (k.startsWith(site + '|')) ranged.delete(k);
}

// ---------------- live stream (server-sent events) ----------------
const streams = new Set<{ res: ServerResponse; site: string }>();
const MAX_STREAMS = 100;

function publish(site: string, data: Record<string, unknown>) {
  if (!streams.size) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of streams) if (c.site === site || c.site === '*') c.res.write(msg);
}

function watching(site: string) {
  for (const c of streams) if (c.site === site) return true;
  return false;
}

const liveOf = (site: string) => (site === '*' ? sites.list().reduce((n, s) => n + agg.liveCount(s.id), 0) : agg.liveCount(site));

function stream(req: IncomingMessage, res: ServerResponse, site: string) {
  if (streams.size >= MAX_STREAMS) return send(res, 503, { error: 'too many live viewers' });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`retry: 3000\ndata: ${JSON.stringify({ k: 'hello', live: liveOf(site), at: Date.now() })}\n\n`);
  const c = { res, site };
  streams.add(c);
  req.on('close', () => streams.delete(c));
}

// Lets open dashboards notice sessions going quiet without any new events arriving.
setInterval(() => {
  for (const c of streams) c.res.write(`data: ${JSON.stringify({ k: 'tick', live: liveOf(c.site), at: Date.now() })}\n\n`);
}, 15_000).unref();

const S = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
const ok = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Older scripts sent the on-site heatmap token as part of the page address; it is never part of the page. */
const stripHeat = (u: string) => u.replace(/([?&])assist-heatmap=[^&#]*&?/, '$1').replace(/[?&](?=#|$)/, '');

/** Host of the page that sent a request: Origin, else Referer. */
const pageHost = (req: IncomingMessage) => hostOf(req.headers.origin) || hostOf(req.headers.referer);

// ---------------- collector ----------------
async function collect(req: IncomingMessage, res: ServerResponse, q: URLSearchParams) {
  const { site, error } = sites.resolve(q.get('k'), pageHost(req));
  if (!site) {
    stats.rejected++;
    log.debug('batch rejected', { error, host: pageHost(req) });
    return send(res, 403, { error });
  }
  let body: any;
  try {
    body = parseJson(await readBody(req));
  } catch (e) {
    stats.rejected++;
    return send(res, e instanceof HttpError ? e.status : 400, { error: 'unparseable batch' });
  }
  // Paused: accept and drop, so pages don't retry.
  if (site.paused) return send(res, 204);
  if (!ok(body) || typeof body.v !== 'number' || body.v > 1) {
    stats.rejected++;
    return send(res, 400, { error: 'unsupported schema version' });
  }
  if (ok(body.snap)) {
    const s = body.snap as any;
    if (typeof s.html !== 'string' || typeof s.u !== 'string') return send(res, 400, { error: 'bad snapshot' });
    store.saveSnapshot({ site: site.id, u: S(s.u, 400), h: S(s.h, 40), ch: S(s.ch, 40) || undefined, n: +s.n || 0, w: +s.w || 0, ht: +s.ht || 0, vw: +s.vw || 0, html: s.html.slice(0, MAX_UNZIPPED), at: Date.now() });
    stats.snapshots++;
    publish(site.id, { k: 'snap', site: site.id, u: S(s.u, 400), at: Date.now() });
    return send(res, 204);
  }
  if (!Array.isArray(body.ev)) {
    stats.rejected++;
    return send(res, 400, { error: 'no events' });
  }
  const at = Date.now();
  const hdr = {
    sid: S(body.sid, 40),
    vid: S(body.vid, 64),
    pid: S(body.pid, 40),
    site: site.id,
    u: S(body.u, 400),
    dev: S(body.dev, 2),
    grp: body.grp === 'h' ? ('h' as const) : ('c' as const),
    bot: body.bot ? 1 : 0,
    ver: S(body.ver, 20),
  };
  if (!hdr.sid) return send(res, 400, { error: 'no session' });
  const evs: StoredEvent[] = [];
  for (const e of body.ev.slice(0, 2000)) {
    if (!ok(e) || typeof e.t !== 'string' || e.t.length > 8) continue;
    // Header fields win so a hostile event can't spoof session/site. Only page views carry
    // their own page URL; on error events `u` is the failing resource, kept as `ru`.
    const own = S(e.u, 400);
    evs.push({ ...e, ...hdr, t: e.t, u: (e.t === 'pv' && own) || hdr.u, ...(e.t === 'err' && own ? { ru: own } : {}), dev: S(e.dev, 2) || hdr.dev, at });
  }
  store.append(evs);
  for (const e of evs) agg.add(e);
  for (const [k, r] of ranged) if (k.startsWith(site.id + '|')) for (const e of evs) r.agg.add(e);
  stats.accepted++;
  stats.events += evs.length;
  if (!hdr.bot && evs.length) publish(site.id, { k: 'ev', site: site.id, sid: hdr.sid, n: evs.length, t: [...new Set(evs.map((e) => e.t))], live: agg.liveCount(site.id), at });
  // 202 tells the page a dashboard is watching this site, so it switches to near-instant uploads.
  send(res, watching(site.id) || watching('*') ? 202 : 204);
}

// ---------------- dashboard API ----------------
async function sitesApi(req: IncomingMessage, res: ServerResponse, id: string | undefined, sub: string | undefined, arg: string | undefined) {
  const m = req.method;
  if (!id) {
    if (m === 'GET') {
      const counts = store.counts();
      return send(res, 200, sites.list().map((s) => siteView(s, counts)));
    }
    if (m === 'POST') {
      const b = await jsonBody(req);
      const s = sites.create({ name: b.name, domains: b.domains, config: b.config, retentionDays: b.retentionDays });
      log.info('site created', { site: s.id, name: s.name });
      return send(res, 201, siteView(s));
    }
    return send(res, 405);
  }
  const s = sites.get(id);
  if (!s) return send(res, 404, { error: 'No such site.' });
  if (!sub) {
    if (m === 'GET') return send(res, 200, siteView(s));
    if (m === 'PUT') {
      const b = await jsonBody(req);
      const next = sites.update(id, { name: b.name, domains: b.domains, config: b.config, retentionDays: b.retentionDays, paused: b.paused })!;
      if (next.retentionDays !== s.retentionDays) store.purge(retention);
      log.info('site updated', { site: id });
      return send(res, 200, siteView(next));
    }
    if (m === 'DELETE') {
      const n = store.deleteSite(id);
      sites.remove(id);
      agg.drop(id);
      forgetRanges(id);
      log.info('site deleted', { site: id, events: n });
      return send(res, 200, { deleted: n });
    }
    return send(res, 405);
  }
  if (sub === 'keys' && m === 'POST') return send(res, 200, siteView(sites.rotateKey(id)!));
  if (sub === 'keys' && m === 'DELETE' && arg) return send(res, 200, siteView(sites.removeKey(id, decodeURIComponent(arg))!));
  if (sub === 'domains' && m === 'POST') {
    // Quick action from a rejected-origin notice: allow one more host.
    const b = await jsonBody(req);
    const d = normDomain(String(b.domain || ''));
    if (!d) throw new SiteError('That is not a domain.');
    const next = sites.update(id, { domains: [...s.domains, d] })!;
    sites.rejected.get(id)?.delete(String(b.domain));
    return send(res, 200, siteView(next));
  }
  send(res, 404, { error: 'unknown api' });
}

function rebuildSite(id: string) {
  agg.drop(id);
  forgetRanges(id);
  store.replay((e) => agg.add(e), { site: id });
}

async function api(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams, onSite: boolean) {
  const [, , name, id, sub, arg] = path.split('/');
  if (name === 'sites' && !onSite) return sitesApi(req, res, id && decodeURIComponent(id), sub, arg);
  if (name === 'meta' && !onSite) return send(res, 200, { version: VERSION, publicUrl: cfg.publicUrl, scriptUrl: scriptUrl(), token: cfg.dashboardToken, retentionDays: cfg.retentionDays, ingest: stats });

  // Everything else is about one site: `site` is its id. The on-site heatmap only knows the page's host.
  const want = q.get('site') || '';
  const site = sites.get(want) || (onSite ? sites.forHost(want || pageHost(req)) : null);
  if (name === 'stream' && want === '*') return stream(req, res, '*');
  if (!site) return send(res, 404, { error: 'No such site.' });
  const sid = site.id;

  if (req.method === 'DELETE' && name === 'visitor' && id && !onSite) {
    const vids = agg.vidsOf(sid, decodeURIComponent(id));
    let n = 0;
    for (const v of vids) n += store.eraseVisitor(v, sid);
    rebuildSite(sid);
    log.info('visitor erased', { site: sid, events: n, ids: vids.length });
    return send(res, 200, { erased: n });
  }
  // A name or email typed in the dashboard. Stored as an event, so it survives a restart.
  if (req.method === 'POST' && name === 'people' && !onSite) {
    const b = await jsonBody(req);
    const vid = S(b.vid, 64);
    if (!vid) return send(res, 400, { error: 'Visitor id required.' });
    const email = S(b.email, 120).trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'That email does not look right.' });
    const ev: StoredEvent = { t: 'who', n: S(b.name, 80).trim(), em: email, sid: 'dash', vid, pid: '', site: sid, u: '', dev: '', grp: 'c', bot: 0, at: Date.now() };
    store.append([ev]);
    agg.add(ev);
    for (const [k, r] of ranged) if (k.startsWith(sid + '|')) r.agg.add(ev);
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'GET') return send(res, 405);
  if (onSite && name !== 'heatmap') return send(res, 403, { error: 'dashboard token only opens the on-site heatmap' });
  const a = aggFor(sid, q.get('range'));
  switch (name) {
    case 'stream':
      return stream(req, res, sid);
    case 'overview':
      return send(res, 200, { ...a.overview(sid, RANGES[q.get('range') || ''] || 0), prev: prevOverview(sid, q.get('range')), site: sid, siteName: site.name });
    case 'pages':
      return send(res, 200, a.pages(sid, (u) => store.hasSnapshot(sid, u)));
    case 'heatmap':
      return send(res, 200, a.heatmap(sid, stripHeat(q.get('u') || '')));
    case 'frustration':
      return send(res, 200, a.frustration(sid));
    case 'errors':
      return send(res, 200, a.errors(sid));
    case 'forms':
      return send(res, 200, a.forms(sid));
    case 'funnels':
      return send(res, 200, a.funnels(sid));
    case 'vitals':
      return send(res, 200, a.vitals(sid, S(q.get('dev'), 2)));
    case 'people':
      // All stored data: a person looked up last month should still be found.
      return send(res, 200, agg.people(sid, q.get('q') || ''));
    case 'person': {
      const p = agg.person(sid, decodeURIComponent(id || ''));
      return p ? send(res, 200, p) : send(res, 404, { error: 'No such visitor.' });
    }
    case 'sessions':
      // One visitor's history ignores the date range: earlier visits are the point.
      if (q.get('vid')) return send(res, 200, agg.sessions(sid, 100, q.get('vid')!).sort((x, y) => y.start - x.start));
      return send(res, 200, a.sessions(sid, 1000));
    // A session and its recording always come whole, whatever range listed it.
    case 'session': {
      const s = agg.session(sid, decodeURIComponent(id || ''));
      return s ? send(res, 200, s) : send(res, 404, { error: 'not found' });
    }
    case 'replay': {
      const s = agg.replay(sid, decodeURIComponent(id || ''));
      return s ? send(res, 200, s) : send(res, 404, { error: 'not found' });
    }
    case 'snapshot': {
      const ch = q.get('h');
      const s = ch ? store.frame(sid, ch) : store.snapshot(sid, q.get('u') || '');
      // Frames are immutable (content-addressed), so the dashboard may cache them.
      if (s && ch) return send(res, 200, s, { 'cache-control': 'private, max-age=86400, immutable' });
      return s ? send(res, 200, s) : send(res, 404, { error: 'no snapshot yet' });
    }
  }
  send(res, 404, { error: 'unknown api' });
}

const TYPES: Record<string, string> = { '.js': 'application/javascript; charset=utf-8', '.map': 'application/json', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function file(res: ServerResponse, root: string, rel: string, headers: Record<string, string> = {}) {
  const p = normalize(join(root, rel));
  if (!p.startsWith(root) || !existsSync(p) || !statSync(p).isFile()) return send(res, 404, 'not found');
  send(res, 200, readFileSync(p), { 'content-type': TYPES[extname(p)] || 'application/octet-stream', ...headers });
}

async function route(req: IncomingMessage, res: ServerResponse) {
  if (!hostOk(req, cfg)) return send(res, 421, 'misdirected request');
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  const q = url.searchParams;
  const origin = req.headers.origin;
  const self = !origin || selfOrigin(cfg, origin, req);
  const isStatic = req.method === 'GET' && (path === '/assist.js' || /^\/[\w-]+\.js(\.map)?$/.test(path));

  if (isStatic) {
    // Public, content-hashed bundle files: any origin may load them (module chunks are CORS requests).
    const hashed = path !== '/assist.js';
    return file(res, DIST, path.slice(1), {
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    });
  }
  if (path === '/health') return send(res, 200, { ok: true, version: VERSION, uptime: Math.round((Date.now() - stats.started) / 1000) });
  if (path === '/ready') {
    try {
      db.prepare('SELECT 1').get();
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 503, { ok: false });
    }
  }

  // The collector answers any origin: whether a batch counts is decided by site key + domain, and
  // nothing is read back. Turned-away pages are then listed on their site so it can be fixed.
  const open = path === '/collect' || path === '/config';
  const allowed = open || self || originAllowed(origin, cfg, sites);
  cors(req, res, allowed);
  if (req.method === 'OPTIONS') return send(res, allowed ? 204 : 403);
  if (!allowed) return send(res, 403, { error: 'origin not allowed' });

  const who = clientIp(req, cfg.trustProxy);
  const cls = path === '/collect' ? 'collect' : path === '/config' ? 'config' : 'api';
  if (!limiter.allow(who, cls)) return send(res, 429, { error: 'rate limited' });

  if (path === '/collect' && req.method === 'POST') return collect(req, res, q);
  if (path === '/config') {
    const { site } = sites.resolve(q.get('k'), pageHost(req));
    // Unknown key or unregistered domain: tell the script to stay off instead of sending batches we'd refuse.
    const body = !site || site.paused ? { disabled: true } : site.config;
    return send(res, 200, body, { 'cache-control': 'max-age=300' });
  }
  if (path.startsWith('/api/')) {
    // Same-origin dashboard, or a site origin carrying the dashboard token (on-site heatmap).
    const onSite = !self;
    if (onSite && !tokenOk(cfg, q.get('token'))) return send(res, 403, { error: 'dashboard token required' });
    return api(req, res, path, q, onSite);
  }
  if (path === '/' || path === '/dashboard') return file(res, DASH, 'index.html', { 'content-security-policy': DASHBOARD_CSP, 'cache-control': 'no-cache' });
  if (path.startsWith('/dashboard/')) return file(res, DASH, path.slice('/dashboard/'.length), { 'content-security-policy': DASHBOARD_CSP, 'cache-control': 'no-cache' });
  send(res, 404, { error: 'not found' });
}

// ---------------- startup ----------------
const friendly = (host: string) => (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? `Local ${host.split(':')[1] ? 'port ' + host.split(':')[1] : 'site'}` : host);

/**
 * Earlier versions kept day files of NDJSON keyed by page host, and site keys in
 * the config file. Each host becomes a site that keeps accepting the old keys
 * from that host, so existing embeds keep working without edits.
 */
async function migrateLegacy() {
  const oldKeys = Object.keys(cfg.legacySites);
  const oldCfg = cfg.legacySites[oldKeys[0]]?.config || {};
  if (store.legacyFiles().length) {
    const made = new Map<string, string>();
    const n = await store.importLegacy((host) => {
      let id = made.get(host);
      if (id) return id;
      const d = normDomain(host) || 'unknown.invalid';
      const s = sites.list().find((x) => x.domains.includes(d)) || sites.create({ name: friendly(host), domains: [d], keys: [newKey(), ...oldKeys], config: oldCfg });
      store.renameFiles(host, s.id);
      made.set(host, (id = s.id));
      return id;
    });
    log.info('imported event logs from the previous version', { events: n, sites: made.size, movedTo: join(cfg.dataDir, 'legacy') });
  }
  if (!sites.list().length && oldKeys.length) {
    const s = sites.create({ name: cfg.legacySites[oldKeys[0]]?.name || 'Local development', domains: ['localhost:*', '127.0.0.1:*'], keys: oldKeys, config: oldCfg });
    log.info('created a local development site from the config file', { site: s.id });
  }
}

async function main() {
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  setupLog(cfg.logLevel);
  db = openDb(join(cfg.dataDir, 'assist.db'));
  store = new Store(db, cfg.dataDir);
  sites = new Sites(db);
  await migrateLegacy();
  const purged = store.purge(retention);
  const t0 = Date.now();
  const n = store.replay((e) => agg.add(e));
  log.info('loaded stored events', { events: n, ms: Date.now() - t0, purged });
  setInterval(() => {
    const p = store.purge(retention);
    if (p) log.info('retention purge', { removed: p });
  }, 6 * 3600_000).unref();

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : e instanceof SiteError ? 400 : 500;
      if (status === 500) log.error('request failed', { path: req.url, err: (e as Error).stack || String(e) });
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : (e as Error).message });
      else res.end();
    });
  });
  server.requestTimeout = 150_000;
  server.headersTimeout = 20_000;
  server.on('error', (e: NodeJS.ErrnoException) => {
    log.error(e.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use` : 'server error', { err: e.message });
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    log.info(`listening on http://${cfg.host}:${cfg.port}`, { version: VERSION, publicUrl: cfg.publicUrl, sites: sites.list().length });
    log.info(`dashboard: ${cfg.publicUrl}/dashboard`);
  });

  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal: sig });
    for (const c of streams) c.res.end();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
