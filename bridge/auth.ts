import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db';
import { tx } from './db';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  role: Role;
  createdAt: number;
  updatedAt: number;
}

export interface SessionUser extends User {}

export class AuthError extends Error {}

const COOKIE = 'assist_sid';
const SESSION_MS = 14 * 86_400_000;
/** Extend the cookie when less than this remains, so active users stay signed in. */
const SESSION_TOUCH_MS = 7 * 86_400_000;
const MAX_SESSIONS_PER_USER = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

const newId = (p: string) => p + randomBytes(6).toString('hex');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const got = scryptSync(password, salt, SCRYPT.keylen, {
    N: +n || SCRYPT.N,
    r: +r || SCRYPT.r,
    p: +p || SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function publicUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const USER_RE = /^[a-zA-Z0-9._-]{2,40}$/;
const checkUsername = (u: string) => {
  const username = String(u || '').trim();
  if (!USER_RE.test(username)) throw new AuthError('Username must be 2–40 letters, numbers, dots, underscores or hyphens.');
  return username.toLowerCase();
};
const checkPassword = (p: string) => {
  const password = String(p || '');
  if (password.length < 8) throw new AuthError('Password must be at least 8 characters.');
  if (password.length > 200) throw new AuthError('Password is too long.');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new AuthError('Password must include a letter and a number.');
  return password;
};

export class Auth {
  constructor(private db: Db) {}

  /** First boot: create the initial admin if the users table is empty. */
  ensureBootstrap(username: string, password: string) {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    if (n > 0) return null;
    return this.create({ username, password, role: 'admin' });
  }

  list(): User[] {
    return (this.db.prepare('SELECT id, username, role, created_at, updated_at FROM users ORDER BY username').all() as any[]).map(publicUser);
  }

  get(id: string): User | null {
    const row = this.db.prepare('SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?').get(id);
    return row ? publicUser(row) : null;
  }

  create(input: { username: string; password: string; role?: Role }): User {
    const username = checkUsername(input.username);
    const password = checkPassword(input.password);
    const role: Role = input.role === 'admin' ? 'admin' : 'user';
    const now = Date.now();
    const id = newId('usr_');
    try {
      this.db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, hashPassword(password), role, now, now);
    } catch (e: any) {
      if (String(e?.message || e).includes('UNIQUE')) throw new AuthError('That username is already taken.');
      throw e;
    }
    return this.get(id)!;
  }

  update(id: string, patch: { password?: string; role?: Role }): User {
    const cur = this.get(id);
    if (!cur) throw new AuthError('No such user.');
    const role = patch.role === undefined ? cur.role : patch.role === 'admin' ? 'admin' : 'user';
    if (cur.role === 'admin' && role !== 'admin') {
      const admins = (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
      if (admins <= 1) throw new AuthError('You cannot remove the last admin.');
    }
    const passwordHash = patch.password !== undefined ? hashPassword(checkPassword(patch.password)) : null;
    const now = Date.now();
    if (passwordHash) this.db.prepare('UPDATE users SET password_hash = ?, role = ?, updated_at = ? WHERE id = ?').run(passwordHash, role, now, id);
    else this.db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, now, id);
    if (passwordHash) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return this.get(id)!;
  }

  remove(id: string, actorId: string) {
    const cur = this.get(id);
    if (!cur) throw new AuthError('No such user.');
    if (id === actorId) throw new AuthError('You cannot delete your own account.');
    if (cur.role === 'admin') {
      const admins = (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
      if (admins <= 1) throw new AuthError('You cannot delete the last admin.');
    }
    tx(this.db, () => {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
  }

  login(username: string, password: string, meta: { ip: string; ua: string }): { user: User; token: string; expiresAt: number } {
    const u = String(username || '').trim().toLowerCase();
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(u) as any;
    // Dummy hash so a missing user still pays the scrypt cost (same shape as a real row).
    const DUMMY = 'scrypt$16384$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';
    const ok = verifyPassword(String(password || ''), row?.password_hash || DUMMY);
    if (!row || !ok) throw new AuthError('Invalid username or password.');
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + SESSION_MS;
    const sid = newId('ses_');
    tx(this.db, () => {
      this.db.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sid, row.id, sha(token), now, expiresAt, meta.ip.slice(0, 80), meta.ua.slice(0, 200));
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
      // Cap concurrent sessions per user (drop oldest first).
      const ids = this.db.prepare('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(row.id) as { id: string }[];
      for (const extra of ids.slice(MAX_SESSIONS_PER_USER)) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(extra.id);
    });
    return { user: publicUser(row), token, expiresAt };
  }

  logout(req: IncomingMessage) {
    const token = parseCookies(req)[COOKIE];
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  }

  userFromRequest(req: IncomingMessage): SessionUser | null {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.role, u.created_at, u.updated_at, s.id AS sid, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(sha(token)) as any;
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at < now) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
      return null;
    }
    // Rolling expiry for active dashboards.
    if (row.expires_at - now < SESSION_TOUCH_MS) {
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(now + SESSION_MS, row.sid);
    }
    return publicUser(row);
  }

  /** When a session was touched, refresh the browser cookie Max-Age. */
  maybeRefreshCookie(req: IncomingMessage, res: ServerResponse, secure: boolean) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return;
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha(token)) as { expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return;
    // Only rewrite the cookie when we recently extended the session (within 2 minutes of full TTL).
    if (row.expires_at - Date.now() > SESSION_MS - 120_000) this.setSessionCookie(res, token, row.expires_at, secure);
  }

  setSessionCookie(res: ServerResponse, token: string, expiresAt: number, secure: boolean) {
    const parts = [
      `${COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`,
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  clearSessionCookie(res: ServerResponse, secure: boolean) {
    const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}
