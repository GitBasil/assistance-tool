import { describe, it, expect, beforeEach } from 'vitest';
import { Frustration, type Signal } from '../../src/core/frustration';

let t = 0;
let out: Signal[] = [];
let f: Frustration;
const kinds = () => out.map((s) => s.k);

beforeEach(() => {
  t = 100_000;
  out = [];
  f = new Frustration((s) => out.push(s), () => t);
});

describe('rage clicks', () => {
  it('fires on 3 clicks within 1s and 30px', () => {
    f.click(100, 100, 'btn');
    t += 150;
    f.click(104, 102, 'btn');
    t += 150;
    f.click(98, 101, 'btn');
    expect(kinds()).toEqual(['rage']);
  });

  it('does not fire for slow clicks', () => {
    for (let i = 0; i < 4; i++) {
      f.click(100, 100, 'btn');
      t += 600;
    }
    expect(kinds()).toEqual([]);
  });

  it('does not fire for clicks far apart', () => {
    f.click(100, 100, 'a');
    t += 100;
    f.click(300, 100, 'b');
    t += 100;
    f.click(500, 100, 'c');
    expect(kinds()).toEqual([]);
  });

  it('ignores multi-click controls (steppers, carousels, text selection)', () => {
    for (let i = 0; i < 5; i++) {
      f.click(100, 100, 'stepper', true);
      t += 100;
    }
    expect(kinds()).toEqual([]);
  });

  it('5+ clicks weigh more', () => {
    for (let i = 0; i < 5; i++) {
      f.click(100, 100, 'x');
      t += 50;
    }
    expect(out[0].s).toBeGreaterThanOrEqual(25);
  });
});

describe('error-linked signals', () => {
  it('error within 1s of a click becomes errclick on that element', () => {
    f.click(10, 10, 'save');
    t += 300;
    f.error('e1');
    expect(out.at(-1)).toMatchObject({ k: 'errclick', el: 'save' });
  });

  it('error long after a click does not blame the click', () => {
    f.click(10, 10, 'save');
    t += 3000;
    f.error('e1');
    expect(kinds()).toEqual([]);
  });

  it('signals within 5s after an error carry the error fingerprint', () => {
    f.error('boom');
    t += 2000;
    f.signal('dead', 'x');
    expect(out.at(-1)!.err).toBe('boom');
  });
});

describe('form signals', () => {
  it('validation loop: invalid, edit, invalid again', () => {
    f.invalid('dob');
    f.input('dob', 'ins');
    f.invalid('dob');
    expect(kinds()).toEqual(['valloop']);
  });

  it('repeated invalid without editing is not a loop', () => {
    f.invalid('dob');
    f.invalid('dob');
    expect(kinds()).toEqual([]);
  });

  it('valid resets the loop', () => {
    f.invalid('dob');
    f.valid('dob');
    f.input('dob', 'ins');
    f.invalid('dob');
    expect(kinds()).toEqual([]);
  });

  it('thrash: clearing a field three times', () => {
    f.input('name', 'clear');
    f.input('name', 'clear');
    f.input('name', 'clear');
    expect(kinds()).toEqual(['thrash']);
  });

  it('clearing a search box again and again is not thrash', () => {
    for (let i = 0; i < 6; i++) f.input('q', 'clear', true);
    expect(kinds()).toEqual([]);
  });

  it('clears spread over minutes are not thrash', () => {
    for (let i = 0; i < 3; i++) {
      f.input('name', 'clear');
      t += 40_000;
    }
    expect(kinds()).toEqual([]);
  });

  it('holding Backspace is one deletion, however many characters go', () => {
    for (let i = 0; i < 20; i++) {
      f.input('name', 'del');
      t += 30;
    }
    expect(kinds()).toEqual([]);
  });

  it('many separate deletions while barely typing is thrash', () => {
    for (let i = 0; i < 6; i++) {
      f.input('name', 'ins');
      t += 600;
      f.input('name', 'del');
      t += 600;
    }
    expect(kinds()).toEqual(['thrash']);
  });

  it('disabled control: one stray click is nothing, a second within 8s is a signal', () => {
    f.disabled('save');
    expect(kinds()).toEqual([]);
    t += 3000;
    f.disabled('save');
    expect(kinds()).toEqual(['disabled']);
  });

  it('disabled clicks far apart or on different controls do not add up', () => {
    f.disabled('a');
    t += 9000;
    f.disabled('a');
    f.disabled('b');
    expect(kinds()).toEqual([]);
  });

  it('normal typing with a few corrections is not thrash', () => {
    for (let i = 0; i < 30; i++) f.input('name', 'ins');
    for (let i = 0; i < 6; i++) f.input('name', 'del');
    expect(kinds()).toEqual([]);
  });

  it('repeated paste', () => {
    f.input('code', 'paste');
    t += 2000;
    f.input('code', 'paste');
    expect(kinds()).toEqual(['paste']);
  });

  it('resubmit after invalid submit', () => {
    f.submitInvalid('form');
    t += 4000;
    f.submitInvalid('form');
    expect(kinds()).toEqual(['resubmit']);
  });
});

describe('movement signals', () => {
  it('cursor thrash: many direction reversals quickly', () => {
    let x = 0;
    for (let i = 0; i < 12; i++) {
      x += i % 2 ? -60 : 60;
      t += 80;
      f.move(x);
    }
    expect(kinds()).toContain('cursor');
  });

  it('smooth movement is not thrash', () => {
    for (let i = 0; i < 40; i++) {
      t += 50;
      f.move(i * 20);
    }
    expect(kinds()).toEqual([]);
  });

  it('keyboard mode disables mouse-only signals', () => {
    f.kb = true;
    expect(f.signal('cursor')).toBeNull();
    expect(f.signal('hover', 'x')).toBeNull();
    expect(f.signal('rage', 'x')).not.toBeNull();
  });

  it('tab cycling through the same control', () => {
    f.tab('a');
    f.tab('b');
    f.tab('a');
    f.tab('b');
    f.tab('a');
    expect(kinds()).toEqual(['tabcycle']);
  });
});

describe('score', () => {
  it('decays with a ~60s half-life', () => {
    f.signal('rage', 'x');
    const s0 = f.score();
    t += 60_000;
    expect(Math.abs(f.score() - s0 / 2)).toBeLessThanOrEqual(1);
    t += 600_000;
    expect(f.score()).toBe(0);
  });

  it('caps at 100', () => {
    for (let i = 0; i < 20; i++) {
      f.signal('rage', 'el' + i);
    }
    expect(f.score()).toBe(100);
  });

  it('per-element score and hotspots', () => {
    f.signal('rage', 'a');
    f.signal('dead', 'b');
    expect(f.score('a')).toBeGreaterThan(f.score('b'));
    expect(f.hotspots()[0][0]).toBe('a');
  });

  it('context signals alone are recorded but score nothing', () => {
    f.signal('hover', 'row');
    t += 30_000;
    f.signal('uturn');
    t += 30_000;
    f.signal('refresh');
    expect(out.map((s) => s.s)).toEqual([0, 0, 0]);
    expect(f.score()).toBe(0);
  });

  it('context signals do not vouch for each other until three groups show up together', () => {
    f.signal('uturn');
    t += 1000;
    f.signal('loop'); // same group
    t += 1000;
    f.signal('hover', 'row'); // second group
    expect(f.score()).toBe(0);
    t += 1000;
    f.signal('paste', 'code'); // third group: the whole cluster counts
    expect(out.at(-1)!.s).toBe(8);
    expect(Math.abs(f.score() - (10 + 15 + 5 + 8))).toBeLessThanOrEqual(2); // a little decay over 3s
  });

  it('direct evidence vouches for context in the window', () => {
    f.signal('hover', 'row');
    t += 5000;
    f.signal('dead', 'btn');
    expect(f.score()).toBe(20);
  });

  it('a strong signal vindicates earlier context, but not stale context', () => {
    f.signal('uturn');
    t += 25_000;
    f.signal('dead', 'x');
    expect(f.score()).toBe(15);
    t += 1000;
    f.signal('hover', 'y');
    expect(out.at(-1)!.s).toBe(5);
  });

  it('cooldown suppresses duplicate signals for 5s', () => {
    expect(f.signal('dead', 'x')).not.toBeNull();
    t += 1000;
    expect(f.signal('dead', 'x')).toBeNull();
    t += 5000;
    expect(f.signal('dead', 'x')).not.toBeNull();
  });
});
