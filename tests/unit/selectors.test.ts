import { describe, it, expect, beforeEach } from 'vitest';
import { fingerprint, findByFp, stableId, stableClass, accName } from '../../src/page/selectors';
import { errFp } from '../../src/core/errors';

beforeEach(() => (document.body.innerHTML = ''));

describe('generated id/class rejection', () => {
  it.each([':r1:', 'ember123', 'mui-42', 'react-select-3-input', 'a1b2c3d4-1234-5678', 'x12', 'id-123456'])('rejects id %s', (id) => expect(stableId(id)).toBe(false));
  it.each(['email', 'submit-application', 'main-nav'])('keeps id %s', (id) => expect(stableId(id)).toBe(true));
  it.each(['css-1x2y3z', 'sc-bdVaJa', 'jsx-123456', 'emotion-0', 'is-active', 'active'])('rejects class %s', (c) => expect(stableClass(c)).toBe(false));
  it.each(['btn-primary', 'form_field', 'card__title', 'nav-link'])('keeps class %s', (c) => expect(stableClass(c)).toBe(true));
});

describe('fingerprint', () => {
  it('uses a stable id and the accessible name', () => {
    document.body.innerHTML = '<button id="save">Save changes</button>';
    expect(fingerprint(document.querySelector('button')!)).toBe('#save|button|Save changes');
  });

  it('prefers data-testid and skips generated ids', () => {
    document.body.innerHTML = '<div id=":r5:"><button data-testid="pay">Pay</button></div>';
    expect(fingerprint(document.querySelector('button')!)).toBe('[data-testid="pay"]|button|Pay');
  });

  it('uses label text for fields', () => {
    document.body.innerHTML = '<label for="d">Date of birth</label><input id="d">';
    expect(accName(document.querySelector('input')!)).toBe('Date of birth');
  });

  it('redacts PII in names', () => {
    document.body.innerHTML = '<button id="b">Email jane@example.com</button>';
    expect(fingerprint(document.querySelector('button')!)).toContain('[email]');
  });

  it('round-trips via findByFp, and falls back to role+name after a redesign', () => {
    document.body.innerHTML = '<form><button id="go">Continue</button></form>';
    const fp = fingerprint(document.querySelector('button')!);
    expect(findByFp(fp)).toBe(document.querySelector('button'));
    document.body.innerHTML = '<section><div><button class="next-btn">Continue</button></div></section>';
    expect(findByFp(fp)).toBe(document.querySelector('button'));
  });

  it('returns null rather than a wrong element', () => {
    document.body.innerHTML = '<button id="x">Cancel</button>';
    expect(findByFp('#go|button|Continue')).toBeNull();
  });
});

describe('errFp', () => {
  it('groups messages that differ only by numbers', () => {
    expect(errFp('net', 'HTTP 500 for order 123')).toBe(errFp('net', 'HTTP 500 for order 987'));
  });
  it('separates kinds and frames', () => {
    expect(errFp('js', 'x is undefined', 'a.js:1')).not.toBe(errFp('js', 'x is undefined', 'b.js:9'));
    expect(errFp('js', 'm')).not.toBe(errFp('net', 'm'));
  });
});
