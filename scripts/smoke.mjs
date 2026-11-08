// End-to-end smoke run against the demo (needs `npm run bridge` and `npm run demo`).
// Drives the planted UX problems, screenshots the assistant, and checks the bridge saw it all.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEMO = process.env.DEMO_URL || 'http://localhost:5173';
const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:7821';
const OUT = fileURLToPath(new URL('../.cache/smoke/', import.meta.url));
mkdirSync(OUT, { recursive: true });

// Hide navigator.webdriver so the session isn't flagged as a bot (bots are excluded from aggregates).
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', headless: !process.env.HEADED, args: ['--disable-blink-features=AutomationControlled'] });
const probe = await browser.newPage();
const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace(/Headless/g, '');
await probe.close();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, userAgent });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && !/500|Failed to load resource/.test(m.text()) && problems.push('console: ' + m.text()));

const ready = () => page.waitForFunction(() => window.Assist && window.Assist.version, null, { timeout: 30000 });
const insights = () => page.evaluate(() => window.Assist.getSessionInsights());
const uiText = () => page.evaluate(() => [...document.querySelectorAll('[data-assist-ui]')].map((h) => h.shadowRoot?.textContent || '').join(' | '));
const shot = (n) => page.screenshot({ path: OUT + n + '.png' });
const sleep = (ms) => page.waitForTimeout(ms);
const results = {};

// 1. Home: first-visit tutorial should start
await page.goto(DEMO + '/');
await ready();
await sleep(2500);
results.tourText = (await uiText()).slice(0, 200);
await shot('1-home-tour');

// 2. Loan: hidden date rule -> validation loop -> inline hint
await page.goto(DEMO + '/loan.html');
await ready();
await page.fill('#name', 'Test Person');
await page.fill('#email', 'test@example.com');
for (const v of ['1990-01-01', '1/1/1990', '01-01-1990']) {
  await page.fill('#dob', v);
  await page.click('#next');
  await sleep(700);
}
await sleep(2000);
results.loan = await insights();
results.loanUi = (await uiText()).slice(0, 300);
await shot('2-loan-validation');

// 3. Search: dead end + fake link (dead clicks) + rage on Filters
await page.goto(DEMO + '/search.html');
await ready();
await page.fill('#q', 'home loan');
await page.press('#q', 'Enter');
await sleep(600);
await page.click('#browse-all');
await sleep(1300);
for (let i = 0; i < 5; i++) await page.click('#filters', { delay: 10 });
await sleep(2500);
results.search = await insights();
results.searchUi = (await uiText()).slice(0, 300);
await shot('3-search-dead-rage');

// 4. Settings: failing save + dead export button
await page.goto(DEMO + '/settings.html');
await ready();
await page.click('#save');
await sleep(1500);
await page.click('#export');
await sleep(2500);
results.settings = await insights();
results.settingsUi = (await uiText()).slice(0, 300);
await shot('4-settings-error');

// 5. Help center opens from the launcher
const opened = await page.evaluate(() => {
  const host = [...document.querySelectorAll('[data-assist-ui]')].find((h) => h.shadowRoot?.querySelector('.launcher'));
  const b = host?.shadowRoot.querySelector('.launcher');
  b?.click();
  return !!b;
});
await sleep(800);
results.panel = opened ? (await uiText()).slice(0, 200) : 'no launcher';
await shot('5-help-center');

// flush + check the bridge
await page.goto('about:blank');
await sleep(1500);
const ov = await fetch(BRIDGE + '/api/overview?site=localhost:5173').then((r) => r.json());
const fr = await fetch(BRIDGE + '/api/frustration?site=localhost:5173').then((r) => r.json());
const er = await fetch(BRIDGE + '/api/errors?site=localhost:5173').then((r) => r.json());

// dashboard views
const dash = await ctx.newPage();
dash.on('pageerror', (e) => problems.push('dashboard pageerror: ' + e.message));
for (const v of ['overview', 'heatmap?u=%2Floan.html&mode=clicks', 'frustration', 'errors', 'forms', 'sessions']) {
  await dash.goto(`${BRIDGE}/dashboard#${v}`);
  await dash.waitForTimeout(v.startsWith('heatmap') ? 2500 : 900);
  await dash.screenshot({ path: OUT + 'dash-' + v.split('?')[0] + '.png', fullPage: false });
}
await browser.close();

const sum = (s) => ({ score: Math.round(s.score), level: s.level, signals: s.signals.map((x) => x.k).join(','), errors: s.errors.length, sent: s.stats.sent });
console.log('tour  :', results.tourText);
console.log('loan  :', sum(results.loan), '\n   ui :', results.loanUi);
console.log('search:', sum(results.search), '\n   ui :', results.searchUi);
console.log('settings:', sum(results.settings), '\n   ui :', results.settingsUi);
console.log('panel :', results.panel);
console.log('bridge:', { sessions: ov.sessions, pageviews: ov.pageviews, errors: ov.errors, rage: ov.rage, dead: ov.dead, events: ov.ingest.events, rejected: ov.ingest.rejected });
console.log('hotspots:', fr.slice(0, 6).map((f) => `${f.el.split('|')[0]} ${JSON.stringify(f.kinds)}`));
console.log('errors:', er.slice(0, 5).map((e) => `${e.k}: ${e.m}`));
console.log('problems:', problems.length ? problems : 'none');
console.log('screenshots:', OUT);
