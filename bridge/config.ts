import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface LegacySite {
  name?: string;
  config?: Record<string, unknown>;
}

export interface BridgeConfig {
  /** Interface to listen on. 127.0.0.1 locally; 0.0.0.0 in a container. */
  host: string;
  port: number;
  /** Where people and scripts reach this server, e.g. https://insights.example.com. */
  publicUrl: string;
  /** Host headers accepted (DNS-rebinding guard): the public URL's host plus localhost. */
  allowedHosts: string[];
  /** Extra origins allowed to call /collect besides the registered site domains. */
  allowedOrigins: string[];
  /** Default retention; a site can set its own. */
  retentionDays: number;
  dataDir: string;
  /** Behind a reverse proxy: trust X-Forwarded-For / -Proto. */
  trustProxy: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Required on /api/* when called from a site origin (on-site heatmap mode). */
  dashboardToken: string;
  /** Site keys from older config files; turned into sites on first start. */
  legacySites: Record<string, LegacySite>;
}

export const ROOT = resolve(import.meta.dirname, '..');

function readJson(p: string): any {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p} is not valid JSON: ${(e as Error).message}`);
  }
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
const bool = (v: unknown) => v === true || /^(1|true|yes|on)$/i.test(String(v ?? ''));

/**
 * Sources, later wins: defaults -> bridge.config.json -> bridge.config.local.json
 * -> environment (ASSIST_*). Invalid values stop the server with every problem listed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = ROOT): BridgeConfig {
  const file = { ...readJson(join(root, 'bridge.config.json')), ...readJson(join(root, 'bridge.config.local.json')) };
  const pick = (envKey: string, fileKey: string, d: unknown) => env[envKey] ?? file[fileKey] ?? d;

  const errors: string[] = [];
  const port = Number(pick('ASSIST_PORT', 'port', env.PORT ?? 7821));
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`port must be 1-65535 (got ${port})`);
  const host = String(pick('ASSIST_HOST', 'host', '127.0.0.1'));
  const publicUrl = String(pick('ASSIST_PUBLIC_URL', 'publicUrl', `http://localhost:${port}`)).replace(/\/+$/, '');
  let pub: URL | null = null;
  try {
    pub = new URL(publicUrl);
    if (!/^https?:$/.test(pub.protocol)) throw 0;
  } catch {
    errors.push(`publicUrl must be an http(s) URL (got "${publicUrl}")`);
  }
  const retentionDays = Number(pick('ASSIST_RETENTION_DAYS', 'retentionDays', 30));
  if (!(retentionDays >= 1 && retentionDays <= 3650)) errors.push(`retentionDays must be 1-3650 (got ${retentionDays})`);
  const logLevel = String(pick('ASSIST_LOG_LEVEL', 'logLevel', 'info')) as BridgeConfig['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) errors.push(`logLevel must be debug, info, warn or error (got "${logLevel}")`);
  if (errors.length) throw new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));

  const local = ['localhost', '127.0.0.1', '[::1]'].flatMap((h) => [h, `${h}:${port}`]);
  const allowedHosts = [...new Set([...(pub ? [pub.host.toLowerCase(), pub.hostname.toLowerCase()] : []), ...local, ...list(pick('ASSIST_ALLOWED_HOSTS', 'allowedHosts', [])).map((h) => h.toLowerCase())])];

  const dataDir = resolve(root, String(pick('ASSIST_DATA_DIR', 'dataDir', 'data')));
  mkdirSync(dataDir, { recursive: true });
  let dashboardToken = String(env.ASSIST_DASHBOARD_TOKEN || file.dashboardToken || '');
  if (!dashboardToken) {
    const tokFile = join(dataDir, '.dashboard-token');
    if (!existsSync(tokFile)) writeFileSync(tokFile, randomBytes(18).toString('base64url'), { mode: 0o600 });
    dashboardToken = readFileSync(tokFile, 'utf8').trim();
  }

  return {
    host,
    port,
    publicUrl,
    allowedHosts,
    allowedOrigins: list(pick('ASSIST_ALLOWED_ORIGINS', 'allowedOrigins', [])),
    retentionDays,
    dataDir,
    trustProxy: bool(pick('ASSIST_TRUST_PROXY', 'trustProxy', false)),
    logLevel,
    dashboardToken,
    legacySites: file.sites && typeof file.sites === 'object' ? file.sites : {},
  };
}
