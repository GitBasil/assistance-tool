import { describe, it, expect } from 'vitest';
import { Aggregator } from '../../bridge/aggregate';
const base = (o: Record<string, unknown> = {}) => ({ sid: 's1', vid: 'v1', pid: 'p1', site: 'demo', u: '/loan', dev: 'd', grp: 'c', bot: 0, at: 1_700_000_000_000, ...o }) as any;

describe('Aggregator', () => {
  it('builds page, frustration, error and form aggregates', () => {
    const a = new Aggregator();
    a.add(base({ t: 'pv' }));
    a.add(base({ t: 'c', el: '#go|button|Go', rx: 500, ry: 500, x: 10, y: 20 }));
    a.add(base({ t: 'f', k: 'rage', el: '#go|button|Go', s: 25 }));
    a.add(base({ t: 'f', k: 'dead', el: '#x', s: 15 }));
    a.add(base({ t: 'err', k: 'net', m: 'HTTP 500', fp: 'abc' }));
    a.add(base({ t: 'errn', a: [['abc', 4]] }));
    a.add(base({ t: 'frm', el: 'form', a: 'start' }));
    a.add(base({ t: 'frm', el: 'form', a: 'ok', at: 1_700_000_030_000 }));
    a.add(base({ t: 'sd', max: 55 }));
    a.add(base({ t: 'mv', g: [[1, 2, 3]], w: 1280 }));

    const o = a.overview('demo');
    expect(o).toMatchObject({ sessions: 1, pageviews: 1, errors: 4, rage: 1, dead: 1 });
    expect(a.frustration('demo')[0]).toMatchObject({ el: '#go|button|Go', score: 25, at: { sid: 's1', pid: 'p1' } });
    expect(a.forms('demo').forms[0]).toMatchObject({ start: 1, ok: 1, completion: 100 });
    const hm = a.heatmap('demo', '/loan');
    expect(hm.clicks).toHaveLength(1);
    expect(hm.moves[0]).toMatchObject({ x: 20, y: 40, n: 3 });
    expect(hm.scroll.reach.slice(0, 7)).toEqual([100, 100, 100, 100, 100, 100, 0]);
  });

  it('groups web vitals by route, rates them at p75 and splits by device', () => {
    const a = new Aggregator();
    const lcp = (u: string, v: number, dev: string, sid: string) => (a.add(base({ t: 'pv', u, dev, sid })), a.add(base({ t: 'vit', n: 'LCP', v, u, dev, sid })));
    lcp('/item?id=1', 1000, 'd', 's1');
    lcp('/item?id=2', 1200, 'd', 's2');
    lcp('/item?id=2', 5000, 'm', 's3');
    lcp('/home', 900, 'd', 's4');

    const v = a.vitals('demo');
    const item = v.pages.find((p) => p.route === '/item')!;
    expect(item.variants.map((x) => x.u).sort()).toEqual(['/item?id=1', '/item?id=2']);
    expect(item.metrics.LCP).toMatchObject({ n: 3, p75: 5000, rating: 'poor', good: 67, poor: 33, slow: { sid: 's3' } });
    expect(v.pages.find((p) => p.route === '/home')!.variants).toEqual([]);
    expect(v.summary.LCP).toMatchObject({ n: 4, rating: 'poor' });
    expect(v.devices).toEqual({ d: 3, m: 1 });

    const desktop = a.vitals('demo', 'd');
    expect(desktop.summary.LCP).toMatchObject({ n: 3, rating: 'good', good: 100 });
    expect(desktop.pages.find((p) => p.route === '/item')!.metrics.LCP.p75).toBe(1200);
  });

  it('overview groups pages by route, charts per hour for short ranges, and ignores CSS read as errors', () => {
    const a = new Aggregator();
    const now = Date.now();
    a.add(base({ t: 'pv', u: '/item?id=1', at: now }));
    a.add(base({ t: 'pv', u: '/item?id=2', at: now }));
    a.add(base({ t: 'pv', u: '/item?id=2', sid: 's2', at: now - 3_600_000 }));
    a.add(base({ t: 'err', k: 'ui', m: '.x:invalid{box-shadow:none;}', fp: 'css', u: '/item?id=1', at: now }));
    a.add(base({ t: 'err', k: 'ui', m: 'Email is required', fp: 'real', u: '/item?id=1', at: now }));

    const o = a.overview('demo', 86_400_000);
    expect(o.routes).toEqual([expect.objectContaining({ route: '/item', top: '/item?id=2', views: 3, sessions: 2, variants: 2, errors: 1 })]);
    expect(o.series.unit).toBe('hour');
    expect(o.series.points).toHaveLength(24);
    expect(o.series.points.at(-1)).toMatchObject({ sessions: 1, pv: 2 });
    expect(a.errors('demo').map((e: any) => e.fp)).toEqual(['real']);
    expect(a.overview('demo', 7 * 86_400_000).series).toMatchObject({ unit: 'day', points: expect.any(Array) });
  });

  it('links a name and email to every visit from the same person, including the id they had before', () => {
    const a = new Aggregator();
    a.add(base({ t: 'pv', vid: 'anon', sid: 's1', u: '/home' }));
    a.add(base({ t: 'who', vid: 'user-42', al: 'anon', n: 'Ada Lovelace', em: 'ada@example.com', sid: 's2' }));
    a.add(base({ t: 'pv', vid: 'user-42', sid: 's2', u: '/account' }));
    a.add(base({ t: 'c', vid: 'user-42', sid: 's2', el: '#save|button|Save' }));

    expect(a.vidsOf('demo', 'anon').sort()).toEqual(['anon', 'user-42']);
    expect(a.sessions('demo', 10, 'anon').map((s) => s.sid).sort()).toEqual(['s1', 's2']);
    expect(a.sessions('demo').find((s) => s.vid === 'anon')).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(a.people('demo', 'ada@').map((p) => p.name)).toEqual(['Ada Lovelace']);
    const person = a.person('demo', 'anon')!;
    expect(person.sessions).toHaveLength(2);
    expect(person.activity.map((e) => e.t)).toContain('c');

    a.add(base({ t: 'who', vid: 'user-42', n: '', sid: 'dash' }));
    expect(a.person('demo', 'user-42')).toMatchObject({ name: '', email: 'ada@example.com' });
  });

  it('keeps bots out of every aggregate', () => {
    const a = new Aggregator();
    a.add(base({ t: 'pv', bot: 1 }));
    a.add(base({ t: 'f', k: 'rage', el: '#x', s: 25, bot: 1 }));
    expect(a.overview('demo')).toMatchObject({ sessions: 0, pageviews: 0, bots: 1, rage: 0 });
  });

  it('survives hostile input', () => {
    const a = new Aggregator();
    for (const e of [null, {}, { t: 5 }, base({ t: 'mv', g: 'nope' }), base({ t: 'vis', a: [[{}, 'x']] }), base({ t: 'f', el: { evil: 1 } }), base({ t: 'zzz' })]) expect(() => a.add(e as any)).not.toThrow();
  });

  it('builds a per-page replay and ignores hostile pointer batches', () => {
    const a = new Aggregator();
    a.add(base({ t: 'pv', ts: 0, vw: 1000, vh: 700 }));
    a.add(base({ t: 'rp', k: 'm', ts: 500, o: 400, p: [0, 10, 20, 200, 30, 40] }));
    a.add(base({ t: 'rp', k: 's', ts: 300, x: 0, y: 120 }));
    a.add(base({ t: 'rp', k: 'z', w: 800, h: 600, dw: 800, dh: 2000 }));
    a.add(base({ t: 'c', ts: 450, x: 30, y: 40, el: '#a|button|A' }));
    a.add(base({ t: 'pv', pid: 'p2', u: '/done', ts: 0, at: 1_700_000_005_000 }));
    a.add(base({ t: 'rp', pid: 'p2', u: '/done', k: 'm', ts: 50, o: 0, p: [0, 8, 9] }));
    a.add(base({ t: 'rp', k: 'm', ts: 10, o: 0, p: Array(5000).fill(1) }));
    a.add(base({ t: 'rp', k: 'm', p: 'nope' }));

    const r = a.replay('demo', 's1')!;
    expect(r.pages.map((p) => p.pid)).toEqual(['p1', 'p2']);
    expect(r.pages[0]).toMatchObject({ u: '/loan', w: 800, h: 600, dw: 800, dh: 2000 });
    expect(r.moves.filter((m) => m.pid === 'p1').slice(0, 2)).toEqual([
      { pid: 'p1', ts: 100, x: 10, y: 20 },
      { pid: 'p1', ts: 300, x: 30, y: 40 },
    ]);
    expect(r.moves.filter((m) => m.pid === 'p1')).toHaveLength(82);
    expect(r.scrolls[0]).toMatchObject({ pid: 'p1', ts: 300, y: 120 });
    expect(r.clicks[0]).toMatchObject({ pid: 'p1', ts: 450, x: 30, y: 40 });
    expect(r.moves.find((m) => m.pid === 'p2')).toMatchObject({ ts: 50, x: 8, y: 9 });
    expect(a.session('demo', 's1')!.replayMs).toBeGreaterThan(0);
    expect(a.session('demo', 's1')!.timeline[1]).toMatchObject({ t: 'c', pid: 'p1' });
  });

  it('drops the oldest pages once a recording passes 40, keeping each new page on its own', () => {
    const a = new Aggregator();
    for (let i = 0; i < 42; i++) {
      const at = 1_700_000_000_000 + i * 1000;
      a.add(base({ t: 'pv', pid: 'p' + i, u: '/p' + i, ts: 0, at }));
      a.add(base({ t: 'kf', pid: 'p' + i, u: '/p' + i, h: 'h' + i, ts: 5000, d: 0, at }));
    }
    const r = a.replay('demo', 's1')!;
    expect(r.pages).toHaveLength(40);
    expect(r.pages[0].pid).toBe('p2');
    expect(r.pages[39]).toMatchObject({ pid: 'p41', u: '/p41' });
    expect(r.frames.find((f) => f.pid === 'p0')).toBeUndefined();
    expect(r.frames.find((f) => f.pid === 'p41')).toMatchObject({ h: 'h41', ts: 5000 });
    expect(r.frames.filter((f) => f.pid === 'p40')).toHaveLength(1);
  });
});

describe('frustration evidence', () => {
  const T = 1_700_000_000_000;
  const f = (k: string, at: number, o: Record<string, unknown> = {}) => base({ t: 'f', k, el: '(page)', s: 10, at, ...o });

  it('everyday behaviour on its own scores nothing and lists nothing', () => {
    const a = new Aggregator();
    a.add(base({ t: 'pv' }));
    // same-group signals together (navigation) do not vouch for each other
    a.add(f('uturn', T));
    a.add(f('loop', T + 1000));
    a.add(f('refresh', T + 2000));
    // different groups, but a minute apart
    for (let i = 0; i < 4; i++) a.add(f(['hover', 'uturn'][i % 2], T + 60_000 * (i + 1), { el: 'row' }));
    expect(a.frustration('demo')).toEqual([]);
    expect(a.sessions('demo')[0].frus).toBe(0);
  });

  it('context signals count when a different kind of evidence is close by, in either order', () => {
    const a = new Aggregator();
    a.add(base({ t: 'pv' }));
    // two groups together: still ordinary
    a.add(f('hover', T, { el: 'row' }));
    a.add(f('uturn', T + 5000));
    expect(a.sessions('demo')[0].frus).toBe(0);
    // direct evidence arrives after a context signal
    a.add(f('refresh', T + 120_000));
    a.add(f('dead', T + 130_000, { el: 'btn' }));
    expect(a.sessions('demo')[0].frus).toBe(20 + 10);
    // three groups of context signals
    a.add(f('hover', T + 300_000, { el: 'row' }));
    a.add(f('uturn', T + 305_000));
    a.add(f('paste', T + 310_000, { el: 'code' }));
    const rows = a.frustration('demo');
    expect(rows.find((r) => r.el === 'row')).toMatchObject({ score: 5, n: 1 });
    expect(rows.find((r) => r.el === '(page)')!.kinds).toMatchObject({ refresh: 1, uturn: 1 });
    expect(a.sessions('demo')[0].frus).toBe(30 + 5 + 10 + 8);
  });

  it('keeps hints in the session timeline, flagged', () => {
    const a = new Aggregator();
    a.add(base({ t: 'pv' }));
    a.add(f('hover', T, { el: 'row' }));
    expect(a.session('demo', 's1')!.timeline.find((x: any) => x.t === 'f')).toMatchObject({ k: 'hover', hint: 1 });
  });
});
