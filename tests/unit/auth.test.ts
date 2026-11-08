// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../bridge/db';
import { Auth, AuthError } from '../../bridge/auth';

describe('auth', () => {
  let auth: Auth;
  beforeEach(() => {
    auth = new Auth(openDb(':memory:'));
  });

  it('bootstraps the initial admin only once', () => {
    const a = auth.ensureBootstrap('basil', 'Pass@123');
    expect(a).toMatchObject({ username: 'basil', role: 'admin' });
    expect(auth.ensureBootstrap('basil', 'Pass@123')).toBeNull();
    expect(auth.list()).toHaveLength(1);
  });

  it('signs in with the right password and rejects the wrong one', () => {
    auth.ensureBootstrap('basil', 'Pass@123');
    const ok = auth.login('Basil', 'Pass@123', { ip: '1.1.1.1', ua: 't' });
    expect(ok.user.username).toBe('basil');
    expect(ok.token.length).toBeGreaterThan(20);
    expect(() => auth.login('basil', 'nope', { ip: '1.1.1.1', ua: 't' })).toThrow(AuthError);
    expect(() => auth.login('missing', 'Pass@123', { ip: '1.1.1.1', ua: 't' })).toThrow(/Invalid username or password/);
  });

  it('lets an admin add users and refuses a duplicate username', () => {
    auth.ensureBootstrap('basil', 'Pass@123');
    const u = auth.create({ username: 'alex', password: 'Secret1!', role: 'user' });
    expect(u).toMatchObject({ username: 'alex', role: 'user' });
    expect(() => auth.create({ username: 'Alex', password: 'Secret1!' })).toThrow(/already taken/);
    expect(() => auth.create({ username: 'alex2', password: 'short' })).toThrow(/at least 8/);
    expect(() => auth.create({ username: 'alex3', password: 'nodigits!' })).toThrow(/letter and a number/);
  });

  it('keeps at least one admin', () => {
    const admin = auth.ensureBootstrap('basil', 'Pass@123')!;
    expect(() => auth.update(admin.id, { role: 'user' })).toThrow(/last admin/);
    const other = auth.create({ username: 'other', password: 'Secret1!', role: 'admin' });
    auth.update(admin.id, { role: 'user' });
    expect(auth.get(admin.id)?.role).toBe('user');
    expect(() => auth.remove(other.id, admin.id)).toThrow(/last admin/);
  });
});
