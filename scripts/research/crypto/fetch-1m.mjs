// Research-only: download BTC/USD 1-minute OHLC from public exchange endpoints for an offline replay of the
// crypto-v0 baseline against 15-minute up/down windows. Output goes OUTSIDE the repo (default D:/Workers/scratch/crypto).
// Polite pacing, no auth, stops on the first HTTP error (never retries around a 429).
//   node scripts/research/crypto/fetch-1m.mjs --source bitstamp|coinbase --days 28 [--out D:/Workers/scratch/crypto]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const source = arg('--source', 'bitstamp');
const days = Number(arg('--days', '28'));
const out = arg('--out', 'D:/Workers/scratch/crypto');
const end = Math.floor(Date.now() / 60000) * 60; // seconds, minute-aligned
const start = end - days * 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = new Map();

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'PropBetEdge-Predictions-research/0.1' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status} (stopping; no retry)`);
  return r.json();
}

if (source === 'bitstamp') {
  for (let s = start; s < end; s += 1000 * 60) {
    const j = await get(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=1000&start=${s}`);
    for (const c of j.data.ohlc) { const t = Number(c.timestamp); if (t >= start && t < end) rows.set(t, [t, +c.open, +c.high, +c.low, +c.close, +c.volume]); }
    await sleep(350);
  }
} else if (source === 'coinbase') {
  for (let s = start; s < end; s += 300 * 60) {
    const e = Math.min(end, s + 300 * 60);
    const j = await get(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`);
    for (const [t, low, high, open, close, volume] of j) if (t >= start && t < end) rows.set(t, [t, open, high, low, close, volume]);
    await sleep(350);
  }
} else throw new Error(`unknown source ${source}`);

mkdirSync(out, { recursive: true });
const sorted = [...rows.values()].sort((a, b) => a[0] - b[0]);
const file = join(out, `btcusd-1m-${source}.csv`);
writeFileSync(file, `t,open,high,low,close,volume\n${sorted.map((r) => r.join(',')).join('\n')}\n`);
console.log(`${source}: ${sorted.length} minutes (${new Date(sorted[0][0] * 1000).toISOString()} .. ${new Date(sorted.at(-1)[0] * 1000).toISOString()}) -> ${file}; expected ${days * 1440}`);
