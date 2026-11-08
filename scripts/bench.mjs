// Performance budget check (npm run check:perf). Loads the same page with and without
// assist.js under 4x CPU throttling, runs an identical scripted session, and fails if the
// assistant exceeds its main-thread, latency, memory or upload budgets.
//   BENCH_RUNS (default 5)  BENCH_SOAK seconds (default 20)  PW_CHANNEL (default msedge)
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = +(process.env.BENCH_PORT || 7901);
const B = `http://localhost:${PORT}`;
const RUNS = +(process.env.BENCH_RUNS || 5);
const SOAK_S = +(process.env.BENCH_SOAK || 20);
const THROTTLE = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

const BUDGET = {
  startupMs: 3, // core evaluation + compile, main thread, 4x CPU
  maxTaskMs: 16, // our share of any single task
  eventP95Ms: 0.2, // one event handler invocation, p95, normal CPU
  inpDeltaMs: 10, // interaction latency added to the host page
  heapDeltaMB: 2, // retained JS heap after the soak, vs. baseline
  uploadKBPerMin: 50, // compressed bytes uploaded per active minute
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};

// ---- fixture server ----
const server = spawn(process.execPath, [fileURLToPath(new URL('../tests/e2e/server.mjs', import.meta.url))], { env: { ...process.env, COMPAT_PORT: String(PORT) }, stdio: 'ignore' });
process.on('exit', () => server.kill());
for (let i = 0; ; i++) {
  try {
    if ((await fetch(B + '/__bytes')).ok) break;
  } catch {}
  if (i > 50) throw new Error('fixture server did not start');
  await sleep(200);
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge', args: ['--disable-blink-features=AutomationControlled'] });

async function interact(page) {
  for (let i = 0; i < 60; i++) await page.mouse.move(80 + ((i * 37) % 1100), 200 + ((i * 53) % 500));
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 450);
    await sleep(120);
  }
  const adds = page.locator('.add');
  for (let i = 0; i < 8; i++) await adds.nth(10 + i * 3).click();
  await page.mouse.wheel(0, -100000);
  await page.click('#name');
  await page.keyboard.type('Jane Tester', { delay: 25 });
  await page.click('#email');
  await page.keyboard.type('jane@example.com', { delay: 25 });
  await page.click('#zip');
  await page.keyboard.type('4820', { delay: 25 });
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  await sleep(1500);
}

async function soak(page, seconds) {
  const end = Date.now() + seconds * 1000;
  for (let i = 0; Date.now() < end; i++) {
    await page.mouse.move(100 + ((i * 71) % 1000), 150 + ((i * 29) % 500));
    if (i % 10 === 0) await page.mouse.wheel(0, i % 20 ? 600 : -600);
    if (i % 25 === 0) await page.locator('.add').nth(i % 40).click({ timeout: 2000 }).catch(() => {});
    await sleep(40);
  }
}

const metric = (r, n) => r.metrics.find((m) => m.name === n)?.value ?? 0;

// Tracing adds overhead to every JS call, which would bias latency against the page that runs
// more JS; so `traced` runs only attribute main-thread time, and untraced runs measure the rest.
async function run(withAssist, traced = false) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: UA });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__lt = [];
    window.__ev = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => e.interactionId && window.__ev.push([e.interactionId, e.duration, e.processingEnd - e.processingStart]))).observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch {}
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await cdp.send('Performance.enable');
  await fetch(B + '/__reset');
  // Light categories: heavier ones (stack traces, source positions) inflate script time several-fold.
  if (traced) await browser.startTracing(page, { categories: ['devtools.timeline', 'toplevel', 'v8.execute'] });
  const t0 = Date.now();
  await page.goto(B + '/bench.html' + (withAssist ? '' : '?noassist'), { waitUntil: 'load' });
  if (withAssist) await page.waitForFunction(() => window.Assist?.version);
  await sleep(3500); // idle-time chunk loading happens here
  await interact(page);
  if (traced) {
    const trace = JSON.parse((await browser.stopTracing()).toString('utf8'));
    await ctx.close();
    return attribute(trace);
  }
  const perf = await cdp.send('Performance.getMetrics');
  const lt = await page.evaluate(() => window.__lt);
  const ev = await page.evaluate(() => window.__ev);
  await soak(page, SOAK_S);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await sleep(300);
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = metric(await cdp.send('Performance.getMetrics'), 'JSHeapUsedSize');
  const minutes = (Date.now() - t0) / 60000;
  await page.goto('about:blank');
  await sleep(800);
  const up = await (await fetch(B + '/__bytes')).json();
  await ctx.close();
  // Per interaction: longest event duration and total handler processing time.
  const inter = new Map();
  for (const [id, d, p] of ev) {
    const x = inter.get(id) || { d: 0, p: 0 };
    x.d = Math.max(x.d, d);
    x.p += p;
    inter.set(id, x);
  }
  const iv = [...inter.values()];
  return {
    scriptMs: metric(perf, 'ScriptDuration') * 1000,
    taskMs: metric(perf, 'TaskDuration') * 1000,
    longTasks: lt.length,
    inp: pct(iv.map((x) => x.d), 0.98),
    procMs: iv.length ? iv.reduce((s, x) => s + x.p, 0) / iv.length : 0,
    heapMB: heap / 1048576,
    uploadKBPerMin: up.bytes / 1024 / minutes,
  };
}

/** Main-thread time spent in our own files, from the Chromium trace. */
function attribute(trace) {
  const evs = trace.traceEvents || trace;
  const url = (e) => e.args?.data?.url || e.args?.data?.stackTrace?.[0]?.url || e.args?.fileName || '';
  const ours = (e) => url(e).startsWith(B + '/assist/');
  const boot = evs.find((e) => e.name === 'EvaluateScript' && /\/assist\/assist\.js/.test(url(e)));
  if (!boot) throw new Error('assist.js evaluation not found in trace');
  const main = evs.filter((e) => e.pid === boot.pid && e.tid === boot.tid && e.ph === 'X' && e.dur != null).sort((a, b) => a.ts - b.ts);
  const tasks = main.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
  const dispatch = main.filter((e) => e.name === 'EventDispatch');
  const top = [];
  let end = -1;
  for (const e of main) {
    if (!(e.name === 'FunctionCall' || e.name === 'EvaluateScript' || e.name === 'v8.compile' || e.name === 'v8.compileModule' || e.name === 'v8.evaluateModule') || !ours(e)) continue;
    if (e.ts < end) continue;
    top.push(e);
    end = e.ts + e.dur;
  }
  const within = (list, e) => list.find((t) => t.ts <= e.ts && t.ts + t.dur >= e.ts + e.dur);
  const perTask = new Map();
  const parts = new Map();
  for (const e of top) {
    const t = within(tasks, e) || e;
    perTask.set(t, (perTask.get(t) || 0) + e.dur);
    (parts.get(t) || parts.set(t, []).get(t)).push(`${url(e).split('/').pop()}:${e.args?.data?.lineNumber ?? ''}:${e.args?.data?.columnNumber ?? ''} ${(e.dur / 1000).toFixed(1)}ms`);
  }
  const worst = [...perTask].sort((a, b) => b[1] - a[1])[0];
  const compile = top.filter((e) => e.name === 'v8.compile' && /\/assist\/assist\.js/.test(url(e))).reduce((s, e) => s + e.dur, 0);
  const handlers = top.filter((e) => e.name === 'FunctionCall' && within(dispatch, e)).map((e) => e.dur / 1000);
  return {
    startupMs: (boot.dur + compile) / 1000,
    maxTaskMs: Math.max(0, ...perTask.values()) / 1000,
    maxTaskWhat: worst ? `${((worst[0].ts - boot.ts) / 1000).toFixed(0)}ms after load: ${parts.get(worst[0]).slice(0, 3).join(', ')}` : '',
    eventP95Ms: pct(handlers, 0.95),
    handlerCalls: handlers.length,
    totalMs: top.reduce((s, e) => s + e.dur, 0) / 1000,
  };
}

const withRuns = [];
const baseRuns = [];
for (let i = 0; i < RUNS; i++) {
  baseRuns.push(await run(false));
  withRuns.push({ ...(await run(true)), trace: await run(true, true) });
  process.stdout.write(`run ${i + 1}/${RUNS} done\n`);
}
await browser.close();

const m = (runs, f) => median(runs.map(f));
const r = {
  startupMs: m(withRuns, (x) => x.trace.startupMs),
  maxTaskMs: m(withRuns, (x) => x.trace.maxTaskMs),
  // Measured under 4x throttling; the budget is for a normal CPU (throttling scales main-thread time linearly).
  eventP95Ms: m(withRuns, (x) => x.trace.eventP95Ms) / THROTTLE,
  inpDeltaMs: m(withRuns, (x) => x.inp) - m(baseRuns, (x) => x.inp),
  heapDeltaMB: m(withRuns, (x) => x.heapMB) - m(baseRuns, (x) => x.heapMB),
  uploadKBPerMin: m(withRuns, (x) => x.uploadKBPerMin),
};
const info = {
  ourScriptMs: m(withRuns, (x) => x.trace.totalMs),
  handlerCalls: m(withRuns, (x) => x.trace.handlerCalls),
  scriptDeltaMs: m(withRuns, (x) => x.scriptMs) - m(baseRuns, (x) => x.scriptMs),
  taskDeltaMs: m(withRuns, (x) => x.taskMs) - m(baseRuns, (x) => x.taskMs),
  longTasks: `${m(baseRuns, (x) => x.longTasks)} -> ${m(withRuns, (x) => x.longTasks)}`,
  inp: `${m(baseRuns, (x) => x.inp)} -> ${m(withRuns, (x) => x.inp)} ms (p98 per interaction)`,
  handlerMsPerInteraction: `${m(baseRuns, (x) => x.procMs).toFixed(2)} -> ${m(withRuns, (x) => x.procMs).toFixed(2)}`,
  eventP95Throttled: m(withRuns, (x) => x.trace.eventP95Ms),
  heaviestTasks: withRuns.map((x) => `${x.trace.maxTaskMs.toFixed(1)}ms (${x.trace.maxTaskWhat})`).join('\n                   '),
};

console.log(`\nbench: ${RUNS} runs each, CPU ${THROTTLE}x slower, soak ${SOAK_S}s\n`);
let fail = false;
console.log('metric              measured     budget');
for (const [k, b] of Object.entries(BUDGET)) {
  const v = r[k];
  const ok = v <= b;
  fail ||= !ok;
  console.log(`${k.padEnd(18)} ${v.toFixed(2).padStart(9)}  ${String(b).padStart(9)}  ${ok ? 'ok' : 'OVER'}`);
}
console.log('\ncontext (not budgeted):');
for (const [k, v] of Object.entries(info)) console.log(`  ${k.padEnd(16)} ${typeof v === 'number' ? v.toFixed(1) : v}`);
console.log(fail ? '\nPerformance budget exceeded.' : '\nAll performance budgets met.');
server.kill();
process.exit(fail ? 1 : 0);
