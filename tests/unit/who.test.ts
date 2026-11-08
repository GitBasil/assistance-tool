import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyWho, readWho, watchWho, whoSpec } from '../../src/core/who';

const spec = whoSpec('/passport|currentIdentity.userIdentifier|currentIdentity.displayName|currentIdentity.email');

describe('readWho', () => {
  it('reads only the paths named on the tag', () => {
    expect(
      readWho(
        {
          currentIdentity: {
            userIdentifier: 'S-1-5-21-100',
            displayName: 'Jordan Lee',
            email: 'jordan.lee@uwm.com',
          },
        },
        spec,
      ),
    ).toEqual({ id: 'S-1-5-21-100', name: 'Jordan Lee', email: 'jordan.lee@uwm.com' });
  });

  it('does not guess a person when the tag names no fields', () => {
    expect(readWho({ currentIdentity: { userIdentifier: 'sid', displayName: 'Jordan Lee', email: 'jordan.lee@uwm.com' } }, whoSpec('/passport'))).toBeNull();
    expect(readWho(null, spec)).toBeNull();
  });
});

describe('watchWho', () => {
  afterEach(() => {
    delete (window as any).Assist;
    vi.unstubAllGlobals();
  });

  it('does nothing unless data-who is on the script tag', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    watchWho('');
    await window.fetch('/api/passport');
    expect(window.fetch).toBe(fetchMock);
  });

  it('identifies id, name, and email from the paths on the tag', async () => {
    const identify = vi.fn();
    (window as any).Assist = { identify, _who: applyWho };
    const body = { currentIdentity: { userIdentifier: 'sid-1', displayName: 'Jordan Lee', email: 'jordan.lee@uwm.com' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    watchWho('/passport|currentIdentity.userIdentifier|currentIdentity.displayName|currentIdentity.email');
    const res = await window.fetch('/api/passport');
    expect(await res.json()).toEqual(body);
    await window.fetch('/api/incidents');
    await new Promise((r) => setTimeout(r, 0));
    expect(identify).toHaveBeenCalledTimes(1);
    expect(identify).toHaveBeenCalledWith('sid-1', { name: 'Jordan Lee', email: 'jordan.lee@uwm.com' });
  });
});
