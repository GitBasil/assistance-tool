import { describe, it, expect } from 'vitest';
import { redact, normUrl, pageUrl, isSensitive, shape } from '../../src/privacy/redactor';

describe('redact', () => {
  it.each([
    ['Contact jane.doe+x@mail.example.com now', 'Contact [email] now'],
    ['Card 4111 1111 1111 1111 declined', 'Card [card] declined'],
    ['SSN 123-45-6789', 'SSN [ssn]'],
    ['Call (313) 555-0100', 'Call [phone]'],
    ['IBAN DE89370400440532013000', 'IBAN [iban]'],
    ['Loan #12345678 failed', 'Loan #[num] failed'],
    ['token eyJhbGciOiJIUzI1NiJ9abc123xyz456', 'token [token]'],
  ])('%s', (input, want) => expect(redact(input)).toBe(want));

  it('keeps ordinary text', () => {
    expect(redact('Please match the requested format.')).toBe('Please match the requested format.');
  });

  it('collapses whitespace and truncates', () => {
    expect(redact('a   b\n\nc')).toBe('a b c');
    expect(redact('x'.repeat(50), 10)).toBe('x'.repeat(10) + '…');
  });
});

describe('normUrl', () => {
  const base = location.origin + '/start';
  it('normalizes id-like path segments', () => {
    expect(normUrl('/loans/12345/docs', base)).toBe('/loans/:id/docs');
    expect(normUrl('/u/0f8fad5b-d9cb-469f-a165-70867728950e', base)).toBe('/u/:id');
    expect(normUrl('/u/jane@example.com', base)).toBe('/u/:email');
  });
  it('drops query values and hash, keeps sorted keys', () => {
    expect(normUrl('/search?q=jane+doe&page=2#top', base)).toBe('/search?page&q');
  });
  it('keeps host for cross-origin urls', () => {
    expect(normUrl('https://api.other.com/v1/users/42', base)).toBe('api.other.com/v1/users/:id');
  });
});

describe('pageUrl', () => {
  const base = location.origin + '/start';
  it('keeps the query string so each dialog is its own page', () => {
    expect(pageUrl('/console/lost-and-found?item=LF-26-0011', base)).toBe('/console/lost-and-found?item=LF-26-0011');
    expect(pageUrl('/console/lost-and-found?item=LF-26-0005', base)).not.toBe(pageUrl('/console/lost-and-found?item=LF-26-0011', base));
  });
  it('still normalizes id-like path segments', () => {
    expect(pageUrl('/loans/12345/docs?tab=photos', base)).toBe('/loans/:id/docs?tab=photos');
  });
  it('drops the on-site heatmap token, so the page matches its recorded data and the token is never stored', () => {
    expect(pageUrl('/console/lost-and-found?assist-heatmap=secret', base)).toBe('/console/lost-and-found');
    expect(pageUrl('/console/lost-and-found?item=LF-26-0011&assist-heatmap=secret', base)).toBe('/console/lost-and-found?item=LF-26-0011');
  });
});

describe('isSensitive', () => {
  const el = (html: string) => {
    document.body.innerHTML = html;
    return document.body.firstElementChild!;
  };
  it.each([
    ['<input type="password">', true],
    ['<input name="ssn">', true],
    ['<input autocomplete="cc-number">', true],
    ['<input id="cardNumber">', true],
    ['<input aria-label="Routing number">', true],
    ['<div data-assist-ignore><input id="x"></div>', true],
    ['<input name="city">', false],
    ['<input type="email" name="email">', false],
  ])('%s -> %s', (html, want) => {
    const e = el(html);
    expect(isSensitive(e.matches('input') ? e : e.querySelector('input'))).toBe(want);
  });
});

describe('shape', () => {
  it('never returns the value, only length and class', () => {
    expect(shape('')).toEqual({ len: 0, cls: 'e' });
    expect(shape('12345')).toEqual({ len: 5, cls: 'd' });
    expect(shape("O'Brien")).toEqual({ len: 7, cls: 'a' });
    expect(shape('a@b.co')).toEqual({ len: 6, cls: '@' });
    expect(shape('01/02/1990')).toEqual({ len: 10, cls: 'f' });
    expect(shape('Main St 5')).toEqual({ len: 9, cls: 'm' });
  });
});
