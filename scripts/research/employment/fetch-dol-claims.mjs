// Fetch the archived DOL/ETA "Unemployment Insurance Weekly Claims" news releases (as published, one PDF per week from 2014, one .asp HTML page per week before)
// from the oui.doleta.gov/press/<year>/ directory listings. Skips files already on disk. Writes a manifest with the
// listing URL, file URL, HTTP status, bytes, sha256 and fetch time for every file.
//   node scripts/research/employment/fetch-dol-claims.mjs <raw-dir> [fromYear=2007] [toYear=2026]
// The filename (MMDDYY.pdf / MMDDYY.asp) is NOT trusted as the release date: listings contain misfiled years. The parser reads the
// embargo line inside each release.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (compatible; research-bot)';
const BASE = 'https://oui.doleta.gov/press/';
const SPACING_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [dir, from = '2007', to = '2026'] = process.argv.slice(2);
if (!dir) { console.error('usage: fetch-dol-claims.mjs <raw-dir> [fromYear] [toYear]'); process.exit(2); }
const pdfDir = join(dir, 'files');
mkdirSync(pdfDir, { recursive: true });
const manifestPath = join(dir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { source: BASE, user_agent: UA, listings: {}, files: {} };

for (let y = Number(from); y <= Number(to); y++) {
  const listingUrl = `${BASE}${y}/`;
  const res = await fetch(listingUrl, { headers: { 'user-agent': UA } });
  const html = await res.text();
  const names = [...new Set([...html.matchAll(/href="(\d{6}\.(?:pdf|asp))"/gi)].map((m) => m[1]))].sort();
  manifest.listings[y] = { url: listingUrl, status: res.status, fetched_at: new Date().toISOString(), sha256: createHash('sha256').update(html).digest('hex'), files: names };
  await sleep(SPACING_MS);
  for (const name of names) {
    const key = `${y}/${name}`;
    const path = join(pdfDir, `${y}-${name}`);
    if (manifest.files[key]?.status === 200 && existsSync(path)) continue;
    const url = `${BASE}${y}/${name}`;
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status === 200) writeFileSync(path, buf);
    manifest.files[key] = { url, status: r.status, bytes: buf.length, sha256: r.status === 200 ? createHash('sha256').update(buf).digest('hex') : null, fetched_at: new Date().toISOString() };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    await sleep(SPACING_MS);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  console.log(y, names.length, 'files');
}
