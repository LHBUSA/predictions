#!/usr/bin/env node
// Employment V1 research: archive settled Kalshi KXU3 / KXPAYROLLS markets (incl. legacy U3-/PROLLS- tickers) and their
// hourly candles around the T-1D cutoff, from the PUBLIC read-only Kalshi API, for a SCORING-ONLY comparison.
// Market data never enters a model feature (test/employment-v1.test.js). Every response is saved with its sha256.
//   node scripts/research/employment/fetch-kalshi-employment.mjs <raw-kalshi-dir>
// Needs data/employment/bls-empsit-releases-v1.json (release dates -> cutoffs).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cutoffFor } from '../../../src/macro/employment/features.js';

const B = 'https://api.elections.kalshi.com/trade-api/v2';
const UA = 'Mozilla/5.0 (compatible; research-bot)';
const SPACING_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [dir] = process.argv.slice(2);
if (!dir) { console.error('usage: fetch-kalshi-employment.mjs <raw-kalshi-dir>'); process.exit(2); }
mkdirSync(join(dir, 'responses'), { recursive: true });
const manifestPath = join(dir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { source: B, user_agent: UA, responses: {} };
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

async function get(path, key) {
  const file = join(dir, 'responses', `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  if (manifest.responses[key]?.status === 200 && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${B}${path}`, { headers: { 'user-agent': UA } });
    const text = await res.text();
    await sleep(SPACING_MS);
    if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    manifest.responses[key] = { url: `${B}${path}`, status: res.status, bytes: text.length, sha256: createHash('sha256').update(text).digest('hex'), fetched_at: new Date().toISOString() };
    if (res.status === 200) writeFileSync(file, text);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    return res.status === 200 ? JSON.parse(text) : null;
  }
  throw new Error(`429 persisted for ${path}`);
}

const releases = JSON.parse(readFileSync('data/employment/bls-empsit-releases-v1.json', 'utf8')).releases;
const releaseByMonth = new Map(releases.map((r) => [r.reference_month, r]));
const summary = [];
for (const series of ['KXU3', 'KXPAYROLLS']) {
  const evs = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const j = await get(`/events?series_ticker=${series}&status=settled&limit=200${cursor ? `&cursor=${cursor}` : ''}`, `events_${series}_settled_${page}`);
    evs.push(...(j?.events || []));
    cursor = j?.cursor || '';
    if (!cursor) break;
  }
  for (const ev of evs) {
    const m = /-(\d{2})([A-Z]{3})$/.exec(ev.event_ticker);
    const month = m ? `20${m[1]}-${String(MON[m[2]]).padStart(2, '0')}` : null;
    const rel = month ? releaseByMonth.get(month) : null;
    const hist = await get(`/historical/markets?event_ticker=${ev.event_ticker}&limit=200`, `hist_markets_${ev.event_ticker}`);
    let markets = hist?.markets || []; let venue = 'historical';
    if (!markets.length) { const live = await get(`/markets?event_ticker=${ev.event_ticker}&limit=200`, `live_markets_${ev.event_ticker}`); markets = live?.markets || []; venue = 'live'; }
    let candles = 0;
    if (rel) {
      const cut = Math.floor(Date.parse(cutoffFor(rel.release_date)) / 1000);
      for (const mk of markets) {
        const path = venue === 'historical' ? `/historical/markets/${mk.ticker}/candlesticks` : `/series/${series}/markets/${mk.ticker}/candlesticks`;
        const c = await get(`${path}?start_ts=${cut - 72 * 3600}&end_ts=${cut}&period_interval=60`, `candles_${mk.ticker}_${cut}`);
        if (c) candles += 1;
      }
    }
    summary.push({ series, event: ev.event_ticker, month, release_date: rel?.release_date ?? null, venue, markets: markets.length, candles });
    console.log(JSON.stringify(summary.at(-1)));
  }
}
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
