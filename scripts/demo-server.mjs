// Serves demo/ on http://localhost:5173 with a few fake APIs (one always fails).
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(fileURLToPath(new URL('../demo/', import.meta.url)));
const PORT = +(process.env.DEMO_PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };
const PRODUCTS = ['Fixed 30-year mortgage', 'Fixed 15-year mortgage', 'Adjustable-rate mortgage (ARM)', 'FHA loan', 'VA loan', 'Jumbo loan', 'Refinance', 'Home equity line of credit'];

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/fail') {
    setTimeout(() => res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal"}'), 300);
    return;
  }
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    // Planted dead end: only exact product words match; synonyms like "home loan" return nothing.
    const hits = q ? PRODUCTS.filter((p) => p.toLowerCase().split(/\W+/).includes(q)) : [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hits));
    return;
  }
  if (url.pathname === '/api/apply') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  let p = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!p.startsWith(ROOT) || !existsSync(p) || statSync(p).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(readFileSync(p));
}).listen(PORT, '127.0.0.1', () => console.log(`[demo] http://localhost:${PORT}  (start the bridge too: npm run bridge)`));
