// Serves design_handoff_livery/ over http so the .dc.html prototypes can load support.js.
// Usage: pnpm handoff  →  http://localhost:4599/Livery%20Prototype.dc.html
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../design_handoff_livery/', import.meta.url)));
const port = Number(process.env.PORT ?? 4599);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const file = resolve(join(root, rel === '/' ? 'Livery Prototype.dc.html' : rel));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`Handoff prototypes on http://localhost:${port}/`));
