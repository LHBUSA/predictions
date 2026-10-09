// Signal 10 raw-source collector. Writes IMMUTABLE raw Yahoo chart responses (one file per symbol per capture)
// plus a manifest with url, retrieved_at, http status, sha256. Never edits a captured file.
// Usage: node scripts/signal10/fetch-history.mjs [--cache E:/Workers/cache/signal10] [--from 2015-01-01] [--symbols A,B]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { universeTickers, loadComponents } from '../../src/signal10/universe.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', process.env.SIGNAL10_CACHE || 'E:/Workers/cache/signal10');
const FROM = arg('--from', '2015-01-01');
const UNIVERSE_FROM = arg('--universe-from', '2016-01-01');
const UA = 'Mozilla/5.0 (compatible; PropBetEdge-Signal10-Research/1.0; +https://predictions.propbetedge.ai/markets/signal-10/methodology/)';

export const yahooSymbol = (t) => t.replace(/\./g, '-');

async function main() {
  const comps = loadComponents(fs.readFileSync(path.join(CACHE, 'raw/universe/components.csv'), 'utf8'));
  const extra = ['SPY', 'QQQ'];
  const list = arg('--symbols') ? arg('--symbols').split(',') : [...universeTickers(comps, UNIVERSE_FROM), ...extra];
  const outDir = path.join(CACHE, 'raw/yahoo');
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(CACHE, 'raw/yahoo-manifest.jsonl');
  const p1 = Math.floor(Date.parse(FROM + 'T00:00:00Z') / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  let i = 0, ok = 0, miss = 0;
  const worker = async () => {
    while (i < list.length) {
      const t = list[i++];
      const ys = yahooSymbol(t);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
      let status = 0, body = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try { const r = await fetch(url, { headers: { 'user-agent': UA } }); status = r.status; body = await r.text(); if (status !== 429 && status < 500) break; }
        catch (e) { status = -1; body = String(e); }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      const retrieved_at = new Date().toISOString();
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const file = `${ys}.${retrieved_at.replace(/[:.]/g, '')}.json`;
      fs.writeFileSync(path.join(outDir, file), body, { flag: 'wx' });
      fs.appendFileSync(manifestPath, JSON.stringify({ ticker: t, yahoo_symbol: ys, url, status, retrieved_at, sha256, file, bytes: body.length }) + '\n');
      if (status === 200) ok++; else miss++;
      await new Promise((r) => setTimeout(r, 120));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(JSON.stringify({ symbols: list.length, ok, miss }));
}
main().catch((e) => { console.error(e); process.exit(1); });
