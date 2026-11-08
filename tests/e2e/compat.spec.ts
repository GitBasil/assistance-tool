import { test, expect, open, insights, rage, signals, collected } from './helpers';

test.describe('plain HTML', () => {
  test('captures, detects struggle, and keeps page errors intact', async ({ page, ours }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await open(page, '/plain.html');

    await rage(page, (await page.locator('#export').boundingBox())!);
    await expect.poll(async () => (await signals(page, 'rage')).length).toBeGreaterThan(0);

    await page.click('#boom');
    await expect.poll(async () => (await insights(page)).errors.length).toBeGreaterThanOrEqual(2);
    expect(pageErrors, 'site errors must still reach the site / devtools').toContain('plain page failure');

    const errs = await collected(page, (e) => e.t === 'err');
    expect(errs.map((e) => e.k)).toEqual(expect.arrayContaining(['js', 'net']));
    const [pv] = await collected(page, (e) => e.t === 'pv');
    expect(JSON.stringify(pv)).not.toMatch(/@/);
  });

  test('never sends what the user typed', async ({ page, ours }) => {
    await open(page, '/plain.html');
    await page.fill('#email', 'jane.secret@example.com');
    await page.fill('#zip', '1234');
    await page.click('#send');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await collected(page, (e) => e.t === 'fld' || e.t === 'frm' || e.t === 'errn' || e.t === 'err');
    const raw = await (await page.request.get('/__events')).text();
    expect(raw).not.toContain('jane.secret');
    expect(raw).not.toContain('1234"');
  });
});

for (const fw of ['react', 'vue'] as const) {
  test.describe(fw, () => {
    test('recording does not disturb framework state', async ({ page, ours }) => {
      await open(page, `/${fw}.html`);
      await page.fill('#name', 'Ada');
      await expect(page.locator('#out')).toHaveText('Hello Ada');
      await page.selectOption('#plan', { label: 'Pro' });
      await expect(page.locator('#plan-out')).toHaveText(/pro/i);
      if (fw === 'react') {
        await page.click('#agree');
        await expect(page.locator('#agree-out')).toHaveText('agreed');
      }
      await page.fill('#name', 'Bob');
      await expect(page.locator('#out')).toHaveText('Hello Bob');
      await collected(page, (e) => e.t === 'pv');
    });

    test('nothing is injected inside the framework root', async ({ page, ours }) => {
      await open(page, `/${fw}.html`);
      if (fw === 'react') {
        await page.click('#inc');
        await page.click('#inc');
        await expect(page.locator('#inc')).toHaveText('Clicked 2');
        await page.evaluate(() => (window as any).Assist.highlight('#inner'));
        await page.click('#toggle');
        await expect(page.locator('#inner')).toHaveCount(0);
        await page.click('#toggle');
        await expect(page.locator('#inner')).toHaveCount(1);
      } else {
        await page.click('#add');
        await expect(page.locator('li')).toHaveCount(2);
      }
      const mount = await page.evaluate((sel) => document.querySelector(sel)!.querySelectorAll('[data-assist-ui]').length, fw === 'react' ? '#root' : '#app');
      expect(mount, 'nothing injected inside the framework root').toBe(0);
    });
  });
}

test.describe('zone.js (Angular)', () => {
  test('works inside zones without triggering app change detection', async ({ page, ours }) => {
    await open(page, '/zone.html');
    await page.waitForFunction(() => (window as any).fetch.__assist);
    await page.click('#load');
    await expect(page.locator('#status')).toHaveText('loaded');
    expect(await page.evaluate(() => (window as any).zoneTasks), 'app zone still sees its own tasks').toBeGreaterThan(0);

    const before = await page.evaluate(() => (window as any).zoneTasks);
    for (let i = 0; i < 40; i++) await page.mouse.move(100 + i * 10, 300 + (i % 2) * 40);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => (window as any).zoneTasks);
    expect(after - before, 'our listeners/timers must not run in the app zone').toBe(0);

    await page.evaluate(() => fetch('/api/fail'));
    await expect.poll(async () => (await insights(page)).errors.length).toBeGreaterThan(0);
  });
});

test.describe('web components', () => {
  test('sees inside open shadow roots, tolerates closed ones', async ({ page, ours }) => {
    await open(page, '/webcomponents.html');
    const go = page.locator('ds-search').locator('#go');
    await rage(page, (await go.boundingBox())!);
    await expect.poll(async () => (await signals(page, 'rage')).map((s) => s.el).join()).toContain('Go');

    await page.locator('ds-closed').click();
    await collected(page, (e) => e.t === 'c');
  });
});

test.describe('strict CSP + Trusted Types', () => {
  test('loads, renders and reports with zero policy violations', async ({ page, ours }) => {
    await open(page, '/csp.html');
    await rage(page, (await page.locator('#apply').boundingBox())!);
    await collected(page, (e) => e.t === 'pv');
    expect(await page.evaluate(() => (window as any).cspViolations)).toEqual([]);
  });
});

test.describe('Sentry', () => {
  test('both tools see site errors; neither sees the other', async ({ page, ours }) => {
    await open(page, '/sentry.html');
    await page.waitForFunction(() => (window as any).fetch.__assist);
    expect(await page.evaluate(() => fetch.name)).toBe('fetch');
    await page.click('#throw');
    await page.click('#reject');
    await page.click('#fail');
    await expect.poll(async () => (await insights(page)).errors.length).toBeGreaterThanOrEqual(3);
    await expect.poll(() => page.evaluate(() => (window as any).sentryEvents.length)).toBeGreaterThanOrEqual(2);
    const sentry = await page.evaluate(() => JSON.stringify((window as any).sentryEvents));
    expect(sentry).toContain('order total is NaN');
    expect(sentry, 'Sentry must not capture errors from the collector').not.toContain('/assist/');
  });
});
