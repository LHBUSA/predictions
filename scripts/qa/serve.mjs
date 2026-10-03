// Deterministic local QA server for predictions.propbetedge.ai (Node only — no Python, no global tools).
// Serves the repo root like Vercel's static output and applies the SAME rewrites, read from vercel.json, so a
// locally rendered page fetches exactly what production would. Pre-publication story previews are proxied to the
// Worker's admin route with the admin token taken from PBE_ADMIN_TOKEN or PBE_ADMIN_TOKEN_FILE (never logged).
//
//   node scripts/qa/serve.mjs [--port 8787]        # stays up until Ctrl+C / SIGTERM / GET /__shutdown (exit 0)
//   import { startServer } from './serve.mjs'      # used by article-qa.mjs (ephemeral port)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/vnd.microsoft.icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
// Paths Vercel never serves (.vercelignore) are not served locally either, so QA cannot pass on a file prod lacks.
const IGNORED = readFileSync(join(ROOT, '.vercelignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

function compile(source) {
  const keys = [];
  const re = source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)\*/g, (_, k) => { keys.push(k); return '(.*)'; }).replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp(`^${re}$`), keys };
}
const REWRITES = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).rewrites.map((r) => ({ ...r, ...compile(r.source) }));
const REDIRECTS = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).redirects || [];

function adminToken() {
  if (process.env.PBE_ADMIN_TOKEN) return process.env.PBE_ADMIN_TOKEN.trim();
  const f = process.env.PBE_ADMIN_TOKEN_FILE;
  return f && existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}

async function proxy(res, target, headers = {}) {
  const r = await fetch(target, { headers, redirect: 'manual' });
  const out = { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'x-qa-proxied': '1' };
  if (r.headers.get('location')) out.location = r.headers.get('location');
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function serveFile(res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (IGNORED.some((ig) => rel === ig || rel.startsWith(`${ig}/`))) { res.writeHead(404); return res.end('not deployed'); }
  let p = normalize(join(ROOT, rel));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try { if ((await stat(p)).isDirectory()) p = join(p, 'index.html'); } catch { /* fall through to 404 */ }
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[extname(p).toLowerCase()] || 'application/octet-stream' });
    return res.end(body);
  } catch { res.writeHead(404); return res.end('not found'); }
}

export function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://local');
        if (url.pathname === '/__health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, root: ROOT, rewrites: REWRITES.length })); }
        if (url.pathname === '/__shutdown') { res.writeHead(200); res.end('bye'); return server.close(() => process.exit(0)); }
        if (url.pathname.startsWith('/__preview/')) {
          const token = adminToken();
          if (!token) { res.writeHead(500); return res.end('PBE_ADMIN_TOKEN or PBE_ADMIN_TOKEN_FILE is required for previews'); }
          const worker = REWRITES.find((r) => r.source === '/api/:path*').destination.replace(/\/v1\/:path\*$/, '');
          return proxy(res, `${worker}/admin/${url.pathname.slice('/__preview/'.length)}${url.search}`, { authorization: `Bearer ${token}` });
        }
        const redirect = REDIRECTS.find((r) => r.source === url.pathname);
        if (redirect) { res.writeHead(redirect.permanent ? 308 : 307, { location: redirect.destination }); return res.end(); }
        // Vercel order: filesystem first, then rewrites.
        const rel = url.pathname.replace(/^\/+/, '');
        const local = normalize(join(ROOT, decodeURIComponent(rel)));
        const exists = await stat(url.pathname.endsWith('/') ? join(local, 'index.html') : local).then((s) => s.isFile() || s.isDirectory(), () => false);
        if (exists && !IGNORED.some((ig) => rel === ig || rel.startsWith(`${ig}/`))) return serveFile(res, url.pathname);
        for (const r of REWRITES) {
          const m = url.pathname.match(r.re);
          if (!m) continue;
          let dest = r.destination;
          r.keys.forEach((k, i) => { dest = dest.replace(new RegExp(`:${k}\\*?`), m[i + 1]); });
          return proxy(res, `${dest}${url.search}`);
        }
        return serveFile(res, url.pathname);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`qa proxy error: ${e.message}`);
      }
    });
    server.once('error', rejectStart);
    server.listen(port, host, () => resolveStart({ server, origin: `http://${host}:${server.address().port}` }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const { server, origin } = await startServer({ port: i > 0 ? Number(process.argv[i + 1]) : 8787 }).catch((e) => { console.error(`QA server failed to start: ${e.message}`); process.exit(2); });
  const health = await fetch(`${origin}/__health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) { console.error('QA server started but /__health failed'); process.exit(2); }
  console.log(`${origin} (root ${health.root}, ${health.rewrites} rewrites from vercel.json)`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
