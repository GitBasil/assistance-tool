// Builds dist/: assist.js (core IIFE) + content-hashed ESM chunks + worker + manifest.
import * as esbuild from 'esbuild';
import { readFileSync, readdirSync, rmSync, mkdirSync, statSync, utimesSync, writeFileSync, watch } from 'node:fs';
import { basename, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1');
const out = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const watchMode = process.argv.includes('--watch');

export const CHUNKS = {
  analytics: 'src/chunks/analytics/index.ts',
  vitals: 'src/chunks/vitals/index.ts',
  snapshot: 'src/chunks/snapshot/index.ts',
  replay: 'src/chunks/replay/index.ts',
  heatmap: 'src/chunks/heatmap/index.ts',
  netwrap: 'src/chunks/netwrap/index.ts',
};

const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: 'es2020',
  legalComments: 'none',
  drop: ['debugger'],
  pure: ['console.log', 'console.debug'],
  mangleProps: /^_[a-z]/,
  logLevel: 'warning',
  absWorkingDir: root,
  metafile: true,
};

async function build() {
  const t0 = Date.now();
  // Pages that are already open keep their old assist.js (cached for 5 minutes, or until reload),
  // which imports the old content-hashed chunks. Keep those from the last day so a rebuild
  // doesn't silently stop recording on open tabs.
  const keep = [];
  try {
    for (const f of readdirSync(out)) {
      if (!/-[A-Z0-9]{8}\.js(\.map)?$/.test(f)) continue;
      const p = join(out, f);
      if (Date.now() - statSync(p).mtimeMs < 24 * 3600_000) keep.push([f, readFileSync(p), statSync(p).mtime]);
    }
  } catch {}
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [f, buf, mtime] of keep) {
    const p = join(out, f);
    writeFileSync(p, buf);
    utimesSync(p, mtime, mtime);
  }
  let mangleCache = {};

  const w = await esbuild.build({
    ...common,
    mangleCache,
    entryPoints: { worker: 'src/worker/worker.ts' },
    entryNames: '[name]-[hash]',
    format: 'iife',
    outdir: out,
  });
  mangleCache = w.mangleCache;

  const c = await esbuild.build({
    ...common,
    mangleCache,
    entryPoints: CHUNKS,
    entryNames: '[name]-[hash]',
    chunkNames: 'shared-[hash]',
    format: 'esm',
    splitting: true,
    outdir: out,
  });
  mangleCache = c.mangleCache;

  const manifest = {};
  for (const [file, meta] of Object.entries({ ...w.metafile.outputs, ...c.metafile.outputs })) {
    if (!meta.entryPoint || file.endsWith('.map')) continue;
    const name = Object.entries({ worker: 'src/worker/worker.ts', ...CHUNKS }).find(
      ([, src]) => src === meta.entryPoint,
    )?.[0];
    if (name) manifest[name] = basename(file);
  }

  await esbuild.build({
    ...common,
    mangleCache,
    entryPoints: { assist: 'src/core/index.ts' },
    format: 'iife',
    outdir: out,
    // Chromium explicit compile hint: compile the core eagerly on the streaming
    // (background) thread instead of lazily on the main thread.
    banner: { js: '//# allFunctionsCalledOnLoad' },
    define: {
      __CHUNKS__: JSON.stringify(manifest),
      __VERSION__: JSON.stringify(pkg.version),
    },
  });

  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version: pkg.version, chunks: manifest }, null, 2));
  console.log(`built dist/ in ${Date.now() - t0}ms`, manifest);
}

await build().catch((e) => {
  console.error(e.message || e);
  if (!watchMode) process.exit(1);
});

if (watchMode) {
  let timer;
  watch(join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e.message || e)), 150);
  });
  console.log('watching src/ ...');
}
