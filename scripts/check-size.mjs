// Fails the build when any shipped file exceeds its gzip budget.
// Chunk budgets count the chunk plus shared files it imports that are not already loaded.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const KB = 1024;
const BUDGET = {
  assist: 12 * KB,
  analytics: 5.5 * KB, // includes the on-page error-message scanner (kept out of the 12 KB core)
  vitals: 3 * KB,
  worker: 3 * KB,
  snapshot: 4.5 * KB, // includes DOM-settle / per-route re-capture and the unmasked field-value path
  replay: 3 * KB,
  netwrap: 2 * KB,
  heatmap: 6 * KB,
};
/** Chunks loaded before a given chunk (their shared imports are already cached). */
const BEFORE = {
  analytics: [],
  heatmap: ['analytics'],
  snapshot: ['analytics'],
  vitals: [],
  netwrap: [],
};

const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(files.map((f) => [f, readFileSync(join(dist, f), 'utf8')]));
const gz = (f) => gzipSync(Buffer.from(src[f]), { level: 9 }).length;
const imports = (f) => [...src[f].matchAll(/(?:from|import)\s*"\.\/(shared-[A-Z0-9]+\.js)"/g)].map((m) => m[1]);
function closure(f, seen = new Set()) {
  for (const d of imports(f)) if (!seen.has(d)) (seen.add(d), closure(d, seen));
  return seen;
}
// dist/ also keeps the previous builds' chunks for already-open pages; measure only the current ones.
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')).chunks;
const entry = (name) => (name === 'assist' ? 'assist.js' : manifest[name]);

let fail = false;
console.log('file'.padEnd(30), 'own gz'.padStart(8), 'download gz'.padStart(12), '  budget');
for (const [name, budget] of Object.entries(BUDGET)) {
  const f = entry(name);
  if (!f) continue;
  const already = new Set();
  for (const b of BEFORE[name] || []) {
    const bf = entry(b);
    if (bf) closure(bf).forEach((x) => already.add(x));
  }
  const need = [...closure(f)].filter((x) => !already.has(x));
  const total = gz(f) + need.reduce((s, x) => s + gz(x), 0);
  const over = total > budget;
  if (over) fail = true;
  console.log(f.padEnd(30), String(gz(f)).padStart(8), String(total).padStart(12), `  ${(total / KB).toFixed(1)} / ${budget / KB} KB ${over ? 'OVER' : 'ok'}`);
}
if (fail) {
  console.error('\nSize budget exceeded.');
  process.exit(1);
}
console.log('\nAll size budgets met.');
