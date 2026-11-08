// Fixture server for the compat matrix: serves dist/ as /assist/, host libraries as /vendor/,
// fixture pages, and stands in for the bridge (/collect sink, /config). No AI routes: the
// assistant must work fully offline.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildSync } from 'esbuild';

const at = (p) => normalize(fileURLToPath(new URL(p, import.meta.url)));
const ROOT = at('../../');
const FIX = at('./fixtures/');
const DIST = at('../../dist/');
const PORT = +(process.env.COMPAT_PORT || 7900);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' };

const sentry = buildSync({
  stdin: { contents: "import * as S from '@sentry/browser'; window.Sentry = S;", resolveDir: ROOT },
  bundle: true,
  minify: true,
  format: 'iife',
  write: false,
}).outputFiles[0].text;

const VENDOR = {
  'react.js': 'node_modules/react/umd/react.production.min.js',
  'react-dom.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  'vue.js': 'node_modules/vue/dist/vue.global.prod.js',
  'zone.js': 'node_modules/zone.js/bundles/zone.umd.min.js',
};

// Strict policy a security-conscious site would ship. Our UI must work under it unchanged.
const STRICT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "require-trusted-types-for 'script'",
  'trusted-types assist',
].join('; ');

let events = [];
let bytes = 0;

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const send = (code, body = '', type = 'application/json', extra = {}) =>
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...extra }).end(body);

  if (p === '/collect' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      bytes += buf.length;
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      try {
        const j = JSON.parse(buf.toString('utf8'));
        if (Array.isArray(j.ev)) events.push(...j.ev.map((e) => ({ ...e, _u: j.u })));
      } catch {}
      send(204);
    });
    return;
  }
  if (p === '/config') return send(200, '{}');
  if (p === '/__events') return send(200, JSON.stringify(events));
  if (p === '/__bytes') return send(200, JSON.stringify({ bytes, events: events.length }));
  if (p === '/__reset') return (events = []), (bytes = 0), send(204);
  if (p === '/api/fail') return send(500, '{"error":"internal"}');
  if (p === '/api/ok') return send(200, '{"ok":true}');
  if (p === '/vendor/sentry.js') return send(200, sentry, TYPES['.js']);
  if (p.startsWith('/vendor/') && VENDOR[p.slice(8)]) return send(200, readFileSync(join(ROOT, VENDOR[p.slice(8)])), TYPES['.js']);

  const [dir, rel] = p.startsWith('/assist/') ? [DIST, p.slice(8)] : [FIX, p === '/' ? 'plain.html' : p.slice(1)];
  const file = normalize(join(dir, rel));
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) return send(404, 'not found', 'text/plain');
  const extra = /^csp/.test(rel) && rel.endsWith('.html') ? { 'content-security-policy': STRICT_CSP } : {};
  let body = readFileSync(file);
  // Baseline for the perf A/B: the same page without our script tag.
  if (url.searchParams.has('noassist') && rel.endsWith('.html')) body = body.toString('utf8').replace(/<script[^>]*\/assist\/assist\.js[^>]*><\/script>/, '');
  send(200, body, TYPES[extname(file)] || 'application/octet-stream', extra);
}).listen(PORT, '127.0.0.1', () => console.log(`[compat] http://localhost:${PORT}`));
