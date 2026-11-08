import { describe, it, expect, vi, beforeEach } from 'vitest';
import install from '../../src/chunks/snapshot';
import { Bus } from '../../src/core/bus';

let bus: Bus | null = null;
let sent: any[] = [];

async function snapshot(html: string, mask = true): Promise<string> {
  document.head.innerHTML = '<style>.a{color:red}</style>';
  document.body.innerHTML = html;
  const fetch = vi.fn(async () => new Response('', { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  delete (window as any).requestIdleCallback;
  delete (window as any).CompressionStream;
  delete (globalThis as any).CompressionStream;
  const mem = new Map<string, unknown>();
  bus = new Bus();
  const ctx: any = {
    session: { recording: true },
    bus,
    now: () => performance.now(),
    send: (e: unknown) => sent.push(e),
    store: { get: (k: string, d: unknown) => (mem.has(k) ? mem.get(k) : d), set: (k: string, v: unknown) => mem.set(k, v) },
    cfg: { endpoint: 'http://localhost:7821', key: 'k', site: 's', mask },
  };
  install(ctx);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled(), { timeout: 4000 });
  return JSON.parse((fetch.mock.calls[0] as any)[1].body).snap.html;
}

beforeEach(() => {
  bus?.emit('destroy');
  bus = null;
  sent = [];
  vi.unstubAllGlobals();
});

describe('snapshot serializer (mask on)', () => {
  it('drops scripts, inline handlers and input values', async () => {
    const html = await snapshot('<script>steal()</script><button onclick="x()">Go</button><input id="e" value="jane@example.com"><textarea>secret notes</textarea>');
    expect(html).not.toContain('steal');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('jane');
    expect(html).not.toContain('secret notes');
  });

  it('masks body text but keeps labels, headings and buttons (redacted)', async () => {
    const html = await snapshot('<h1>Your loan</h1><p>Balance owed 1234</p><label>Email for jane@example.com</label><button>Continue</button>');
    expect(html).toContain('Your loan');
    expect(html).toContain('Continue');
    expect(html).toContain('Email for [email]');
    expect(html).not.toContain('Balance');
    expect(html).toContain('•••••••');
    expect(html).not.toContain('1234');
  });

  it('neutralizes links and images, keeps styles, tags fingerprints', async () => {
    const html = await snapshot('<a href="/account?token=abc">Account</a><img src="https://cdn/x.png" alt="Photo of jane@example.com"><button id="go">Go</button>');
    expect(html).toContain('href="#"');
    expect(html).not.toContain('token=abc');
    expect(html).not.toContain('x.png');
    expect(html).toContain('[email]');
    expect(html).toContain('.a{color:red}');
    expect(html).toContain('data-assist-fp="#go|button|Go"');
    expect(html).toMatch(/<base href="[^"]+\/">/);
  });

  it('skips data-assist-ignore regions and our own UI', async () => {
    const html = await snapshot('<div data-assist-ignore><h2>Hidden heading</h2></div><div data-assist-ui><h2>Our UI</h2></div><h2>Shown</h2>');
    expect(html).not.toContain('Hidden heading');
    expect(html).not.toContain('Our UI');
    expect(html).toContain('Shown');
  });
});

describe('snapshot serializer (mask off)', () => {
  it('announces a replay frame for each new page state, and re-announces a known one without re-uploading', async () => {
    await snapshot('<p>List</p>', false);
    await vi.waitFor(() => expect(sent.filter((e) => e.t === 'kf')).toHaveLength(1), { timeout: 3000 });
    const first = sent[0].h;
    const fetch = (globalThis as any).fetch;
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><h2>Scan a found item</h2></div>');
    await vi.waitFor(() => expect(sent.filter((e) => e.t === 'kf')).toHaveLength(2), { timeout: 4000 });
    expect(sent[1].h).not.toBe(first);
    document.querySelector('[role=dialog]')!.remove();
    await vi.waitFor(() => expect(sent.filter((e) => e.t === 'kf')).toHaveLength(3), { timeout: 4000 });
    expect(sent[2].h).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the SVG clip and gradient that turn a sheen into a black bar when dropped', async () => {
    const html = await snapshot(
      '<svg class="boot-mark" viewBox="0 0 24 24"><defs><clipPath id="boot-shield-face"><path d="M0 0"/></clipPath><linearGradient id="boot-shield-sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><g clip-path="url(#boot-shield-face)"><rect x="-12" y="0" width="10" height="24" fill="currentColor" opacity="0.08" onclick="x()"/></g></svg>',
      false,
    );
    expect(html).toContain('<clipPath');
    expect(html).toContain('<linearGradient');
    expect(html).toContain('clip-path="url(#boot-shield-face)"');
    expect(html).toContain('opacity="0.08"');
    expect(html).toContain('stop-opacity="0"');
    expect(html).not.toContain('onclick');
  });

  it('keeps visibility:hidden elements, which still take up space', async () => {
    const html = await snapshot('<fieldset><legend style="visibility:hidden"><span>Location</span></legend></fieldset>', false);
    expect(html).toContain('<legend');
  });

  it('leaves out elements the visitor cannot see', async () => {
    const html = await snapshot('<p>Shown</p><div style="display:none"><p>Secret error</p></div><p hidden>Also hidden</p>', false);
    expect(html).toContain('Shown');
    expect(html).not.toContain('Secret error');
    expect(html).not.toContain('Also hidden');
  });

  it('copies text, field values and images as shown, but never passwords or scripts', async () => {
    document.body.innerHTML = '';
    const html = await snapshot(
      '<p>Balance owed 1234</p><input id="e" value="jane@example.com"><input type="password" value="hunter2"><input type="checkbox" checked><textarea>notes here</textarea><img src="https://cdn/x.png"><script>steal()</script>',
      false,
    );
    expect(html).toContain('Balance owed 1234');
    expect(html).toContain('value="jane@example.com"');
    expect(html).toContain('notes here</textarea>');
    expect(html).toContain('checked');
    expect(html).toContain('src="https://cdn/x.png"');
    expect(html).not.toContain('hunter2');
    expect(html).not.toContain('steal');
  });
});
