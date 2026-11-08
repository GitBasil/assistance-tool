// Quick size breakdown of the core bundle (per input module).
import * as esbuild from 'esbuild';
import { gzipSync } from 'node:zlib';

const r = await esbuild.build({
  entryPoints: ['src/core/index.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  define: { __CHUNKS__: '{}', __VERSION__: '"0"' },
  mangleProps: /^_[a-z]/,
  write: false,
  metafile: true,
});
const b = r.outputFiles[0].contents;
console.log('core min', b.length, 'gz', gzipSync(b, { level: 9 }).length);
const ins = Object.values(r.metafile.outputs)[0].inputs;
for (const [k, v] of Object.entries(ins).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput))
  console.log(String(v.bytesInOutput).padStart(6), k);
