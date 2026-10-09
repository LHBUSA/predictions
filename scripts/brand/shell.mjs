// Emits the network shell (one implementation: workers/pbe-predictions/src/network.js) for the static pages.
//   node scripts/brand/shell.mjs                     -> JSON { header: { <current>: html }, footer: html } on stdout
//   node scripts/brand/shell.mjs --index             -> rewrites index.html (current: overview) between the network markers
//   node scripts/brand/shell.mjs --file <path> <key> -> rewrites any static page's network markers (e.g. crypto/index.html crypto)
import { readFileSync, writeFileSync } from 'node:fs';
import { siteHeader, siteFooter } from '../../workers/pbe-predictions/src/network.js';

const KEYS = ['overview', 'desk', 'record', 'calendar', 'models', 'methodology', 'crypto', 'markets', 'insights'];

function rewrite(file, current) {
  let html = readFileSync(file, 'utf8');
  const swap = (name, body) => {
    const re = new RegExp(`<!-- network:${name} -->[\\s\\S]*?<!-- /network:${name} -->`);
    if (!re.test(html)) throw new Error(`${file} is missing <!-- network:${name} --> markers`);
    html = html.replace(re, `<!-- network:${name} -->\n${body}\n<!-- /network:${name} -->`);
  };
  // page-owned status indicators that page scripts update (keep their ids)
  const LIVE = { crypto: { id: 'crypto-live', text: 'Connecting' } };
  swap('header', siteHeader(current, { live: LIVE[current] || null }));
  swap('footer', siteFooter());
  writeFileSync(file, html);
  console.log(`${file} shell updated (${current})`);
}

const i = process.argv.indexOf('--file');
if (process.argv.includes('--index')) rewrite('index.html', 'overview');
else if (i > 0) rewrite(process.argv[i + 1], process.argv[i + 2] || null);
else process.stdout.write(JSON.stringify({ header: { ...Object.fromEntries(KEYS.map((k) => [k, siteHeader(k)])), none: siteHeader(null) }, footer: siteFooter() }));
