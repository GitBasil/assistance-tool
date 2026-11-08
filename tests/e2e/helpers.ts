import { test as base, expect, type Page } from '@playwright/test';

/** Page errors / console errors that come from our script. Must stay empty on every host. */
export const test = base.extend<{ ours: string[] }>({
  ours: async ({ page }, use) => {
    const ours: string[] = [];
    page.on('pageerror', (e) => /\/assist\//.test(e.stack || '') && ours.push('pageerror: ' + e.message));
    page.on('console', (m) => m.type() === 'error' && /\/assist\//.test(m.location().url || '') && ours.push('console: ' + m.text()));
    await use(ours);
    expect(ours, 'errors thrown by the assistant').toEqual([]);
  },
});
export { expect };

export async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForFunction(() => (window as any).Assist?.version, null, { timeout: 15_000 });
}

export const insights = (page: Page) => page.evaluate(() => (window as any).Assist.getSessionInsights());

/** Locate an element inside our overlay and check it is visible and hit-testable (truly on top). */
export async function overlay(page: Page, sel: string) {
  return page.evaluate((sel) => {
    for (const h of document.querySelectorAll('[data-assist-ui]')) {
      const t = h.shadowRoot?.querySelector(sel) as HTMLElement | null;
      if (!t) continue;
      const r = t.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
      return { visible: r.width > 0 && r.height > 0, onTop: hit === h, text: t.textContent || '', x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return null;
  }, sel);
}

export async function showTip(page: Page, target: string, text: string) {
  await page.evaluate(([t, x]) => (window as any).Assist.tip(t, x), [target, text]);
  await expect.poll(async () => (await overlay(page, '.tip'))?.text || '').toContain(text);
  const o = (await overlay(page, '.tip'))!;
  expect(o.visible, 'tip visible').toBe(true);
  expect(o.onTop, 'tip above every site layer').toBe(true);
  return o;
}

/** Fast repeated clicks at the element centre (Playwright's click() is too slow to look like rage). */
export async function rage(page: Page, box: { x: number; y: number; width: number; height: number }, n = 4) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  for (let i = 0; i < n; i++) await page.mouse.click(x, y);
}

export async function signals(page: Page, kind: string) {
  return ((await insights(page)).signals as { k: string; el?: string }[]).filter((s) => s.k === kind);
}

export async function collected(page: Page, pred: (e: any) => boolean, timeout = 12_000) {
  let hits: any[] = [];
  await expect
    .poll(
      async () => {
        const all = await (await page.request.get('/__events')).json();
        hits = all.filter(pred);
        return hits.length;
      },
      { timeout },
    )
    .toBeGreaterThan(0);
  return hits;
}
