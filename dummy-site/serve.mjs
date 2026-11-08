// Serves dummy-site/ for Footsteps embed testing.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(fileURLToPath(new URL('./', import.meta.url)));
const PORT = +(process.env.DUMMY_PORT || 5180);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let path = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!path.startsWith(ROOT) || !existsSync(path) || statSync(path).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  const type = TYPES[extname(path)] || 'application/octet-stream';
  let body = readFileSync(path);
  // Embed CSS in HTML so recordings stay self-contained on phones (no localhost <link>).
  if (extname(path) === '.html') {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');
    body = Buffer.from(
      body
        .toString('utf8')
        .replace(/<link\s+rel="stylesheet"\s+href="\/styles\.css"\s*\/?>/i, `<style>\n${css}\n</style>`),
    );
  }
  res
    .writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
    })
    .end(body);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[dummy-site] http://localhost:${PORT}`);
  console.log(`[dummy-site] dashboard https://ultrainnovate.com/dashboard`);
});
