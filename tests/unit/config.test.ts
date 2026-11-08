import { describe, it, expect } from 'vitest';
import { defaults, merge, validate, fromScript } from '../../src/core/config';

describe('config', () => {
  it('works with no configuration at all', () => {
    const c = defaults();
    expect(validate(c)).toEqual([]);
    expect(c.features.analytics).toBe(true);
    expect(c.features.replay).toBe(true);
    expect(c.sampleRate).toBe(1);
  });

  it('deep merges objects; arrays replace', () => {
    const c = merge(defaults(), { funnels: [{ name: 'apply', steps: ['/a'] }] }, { features: { replay: false } });
    expect(c.funnels).toHaveLength(1);
    expect(c.features.replay).toBe(false);
    expect(c.features.analytics).toBe(true);
  });

  it('ignores prototype-pollution keys', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1}}');
    const c: any = merge(defaults(), evil);
    expect(({} as any).polluted).toBeUndefined();
    expect(c.polluted).toBeUndefined();
  });

  it('coerces invalid values', () => {
    const c = merge(defaults(), { sampleRate: 7, consent: 'maybe', funnels: 'nope', endpoint: 'http://x/' });
    const w = validate(c);
    expect(w.length).toBe(3);
    expect(c.sampleRate).toBe(1);
    expect(c.consent).toBe('auto');
    expect(c.funnels).toEqual([]);
    expect(c.endpoint).toBe('http://x');
  });

  it('reads data-* attributes', () => {
    const s = document.createElement('script');
    s.dataset.key = 'k1';
    s.dataset.sampleRate = '0.5';
    s.dataset.features = 'analytics,replay';
    const c = fromScript(s);
    expect(c).toMatchObject({ key: 'k1', sampleRate: 0.5 });
    expect(c.features).toMatchObject({ analytics: true, replay: true, heatmaps: false });
  });
});
