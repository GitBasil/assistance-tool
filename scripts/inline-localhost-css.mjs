#!/usr/bin/env node
// Rewrite stored snapshots/frames that still <link> http://localhost:5180/styles.css
// into self-contained <style> blocks so phone replays don't depend on the Mac.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = process.argv[2] || join(process.cwd(), 'data');
const cssPath = process.argv[3] || join(process.cwd(), 'dummy-site/styles.css');
const css = readFileSync(cssPath, 'utf8');
const style = `<style>\n${css}\n</style>`;
const re = /<link[^>]*href="https?:\/\/localhost:5180\/styles\.css"[^>]*>/gi;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let n = 0;
for (const p of walk(root)) {
  if (!p.includes('/snaps/') && !p.includes('/frames/') && !p.includes('\\snaps\\') && !p.includes('\\frames\\')) continue;
  if (p.endsWith('.json.gz')) {
    const j = JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
    if (typeof j.html !== 'string' || !re.test(j.html)) continue;
    re.lastIndex = 0;
    j.html = j.html.replace(re, style);
    writeFileSync(p, gzipSync(JSON.stringify(j)));
    n++;
    console.log('patched', p);
  } else if (p.endsWith('.json')) {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof j.html !== 'string' || !re.test(j.html)) continue;
    re.lastIndex = 0;
    j.html = j.html.replace(re, style);
    writeFileSync(p, JSON.stringify(j));
    n++;
    console.log('patched', p);
  }
}
console.log(`INLINE_DONE ${n}`);
