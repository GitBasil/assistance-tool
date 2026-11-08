import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { BridgeConfig } from './config';
import { hostOf, type Sites } from './sites';

export const MAX_BODY = 256 * 1024;

/** DNS-rebinding guard: only accept requests addressed to this server's own names. */
export function hostOk(req: IncomingMessage, cfg: Pick<BridgeConfig, 'allowedHosts'>): boolean {
  const host = (req.headers.host || '').toLowerCase();
  return cfg.allowedHosts.includes(host) || cfg.allowedHosts.includes(host.replace(/:\d+$/, ''));
}

/** Client address for rate limiting; the proxy's view when one is trusted. */
export function clientIp(req: IncomingMessage, trustProxy: boolean) {
  const xff = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return xff || req.socket.remoteAddress || 'unknown';
}

const patternCache = new Map<string, RegExp>();
const toRe = (p: string) => {
  let re = patternCache.get(p);
  if (!re) {
    re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+') + '$', 'i');
    patternCache.set(p, re);
  }
  return re;
};

/** A registered site's domain, or one of the extra `allowedOrigins` patterns. */
export function originAllowed(origin: string | undefined, cfg: Pick<BridgeConfig, 'allowedOrigins'>, sites?: Pick<Sites, 'hostAllowed'>): boolean {
  if (!origin || origin === 'null') return false;
  if (sites?.hostAllowed(hostOf(origin))) return true;
  return cfg.allowedOrigins.some((p) => p === '*' || toRe(p).test(origin));
}

/** The dashboard's own origin: the public URL, or whatever accepted host name the request came in on. */
export function selfOrigin(cfg: Pick<BridgeConfig, 'publicUrl' | 'allowedHosts'>, origin: string | undefined, req?: IncomingMessage) {
  if (!origin) return false;
  if (origin === new URL(cfg.publicUrl).origin) return true;
  const h = hostOf(origin);
  return !!req && !!h && h === String(req.headers.host || '').toLowerCase() && cfg.allowedHosts.includes(h);
}

export function cors(req: IncomingMessage, res: ServerResponse, allowed: boolean) {
  const origin = req.headers.origin;
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

export function tokenOk(cfg: Pick<BridgeConfig, 'dashboardToken'>, t: string | null) {
  if (!t) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(cfg.dashboardToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fixed-window rate limiter keyed by origin + route class. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private limits: Record<string, number>, private windowMs = 60_000) {}
  allow(key: string, cls: string): boolean {
    const k = cls + '|' + key;
    const t = Date.now();
    let h = this.hits.get(k);
    if (!h || t > h.reset) this.hits.set(k, (h = { n: 0, reset: t + this.windowMs }));
    if (this.hits.size > 10_000) for (const [kk, v] of this.hits) if (t > v.reset) this.hits.delete(kk);
    return ++h.n <= (this.limits[cls] ?? 60);
  }
}

export class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const len = +(req.headers['content-length'] || 0);
    if (len > limit) return reject(new HttpError(413, 'body too large'));
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/** Extra lock-down for the dashboard HTML/JS/CSS only (not public /assist.js). */
export const DASHBOARD_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * Strict CSP for the dashboard: scripts only from the bridge itself. Snapshots render
 * in a script-less sandboxed srcdoc iframe (which inherits this policy), so the site's
 * stylesheets, fonts and images may load but nothing captured can ever execute.
 */
export const DASHBOARD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' http: https:; font-src 'self' data: http: https:; img-src 'self' data: http: https:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self' http: https:; form-action 'self'; frame-ancestors 'none'";
