// Research-only replay of crypto-threshold-diffusion-baseline@0.1.0 (src/models/crypto-v0.js) on 15-minute BTC
// up/down windows reconstructed from public 1-minute exchange candles (fetch-1m.mjs). No market prices are inputs.
//
// Reference price proxy for a contract boundary t: mean of the typical prices ((o+h+l+c)/4) of the 1-minute candle
// [t-60s, t) on Bitstamp and Coinbase (two BRTI constituents). The real settlement is CF Benchmarks' BRTI averaged
// over the 60 s before t — proprietary, so this proxy is checked against Kalshi's published expiration values.
// Forecast at T-k minutes uses only candles completed by then: S = mean close of the last completed minute,
// sigma = realized vol of the trailing 60 one-minute log returns (annualized), horizon = k - 0.5 minutes.
//   node scripts/research/crypto/replay-v0.mjs [--dir D:/Workers/scratch/crypto]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probabilityCryptoAbove, CRYPTO_MODEL } from '../../../src/models/crypto-v0.js';

const dir = (() => { const i = process.argv.indexOf('--dir'); return i > 0 ? process.argv[i + 1] : 'D:/Workers/scratch/crypto'; })();
const load = (f) => new Map(readFileSync(join(dir, f), 'utf8').trim().split('\n').slice(1).map((l) => { const [t, o, h, lo, c, v] = l.split(',').map(Number); return [t, { o, h, l: lo, c, v }]; }));
const bs = load('btcusd-1m-bitstamp.csv');
const cb = load('btcusd-1m-coinbase.csv');
const minutes = [...bs.keys()].filter((t) => cb.has(t)).sort((a, b) => a - b);
const tp = (x) => (x.o + x.h + x.l + x.c) / 4;
const ref = (t) => { const a = bs.get(t - 60); const b = cb.get(t - 60); return a && b ? (tp(a) + tp(b)) / 2 : null; };
const closeAt = (t) => { const a = bs.get(t - 60); const b = cb.get(t - 60); return a && b ? (a.c + b.c) / 2 : null; }; // price known at time t
const MIN_PER_YEAR = 365.25 * 1440;
function sigmaAnn(t, n = 60) {
  const r = [];
  for (let k = n; k >= 1; k -= 1) { const p0 = closeAt(t - 60 * k); const p1 = closeAt(t - 60 * (k - 1)); if (!p0 || !p1) return null; r.push(Math.log(p1 / p0)); }
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * MIN_PER_YEAR);
}

// 1. settlement-proxy check against Kalshi's published expiration values (one-time public read, see audit)
let kalshi = [];
try { kalshi = JSON.parse(readFileSync(join(dir, 'kalshi-settled.json'), 'utf8')); } catch { /* optional */ }
const proxyCheck = kalshi.map((m) => ({ close: m.close, kalshi: m.exp, strike: m.strike, proxy: ref(Date.parse(m.close) / 1000), proxyOpen: ref(Date.parse(m.open) / 1000), result: m.result })).filter((x) => x.proxy && x.proxyOpen);
const errs = proxyCheck.map((x) => x.proxy - x.kalshi);
const absErr = errs.map(Math.abs).sort((a, b) => a - b);
const resultAgree = proxyCheck.filter((x) => (x.proxy >= x.proxyOpen ? 'yes' : 'no') === x.result).length;

// 2. windows + forecasts
const CHECKS = [{ k: 14, d: 'FIRST_PUBLISHED (T-14)' }, { k: 10, d: 'T_MINUS_10' }, { k: 5, d: 'T_MINUS_5' }, { k: 1, d: 'T_MINUS_1' }];
const rows = [];
for (const t of minutes) {
  if (t % 900 !== 0) continue;
  const open = t; const close = t + 900;
  const K = ref(open); const R = ref(close);
  if (!K || !R) continue;
  const up = R >= K ? 1 : 0;
  for (const { k, d } of CHECKS) {
    const at = close - k * 60;
    const S = closeAt(at); const sig = sigmaAnn(at);
    if (!S || !sig) continue;
    const p = probabilityCryptoAbove({ currentPrice: S, annualizedVol: sig }, K, (k - 0.5) / 1440).probability;
    const sig1m = sig / Math.sqrt(MIN_PER_YEAR);
    const ret5 = closeAt(at - 300) ? Math.log(S / closeAt(at - 300)) : null;
    const vol15 = sigmaAnn(at, 15);
    rows.push({ open, k, d, p, up, S, K, sig, z: Math.log(S / K) / (sig1m * Math.sqrt(k - 0.5)), mom5: ret5 === null ? null : ret5 / (sig1m * Math.sqrt(5)), volRatio: vol15 ? vol15 / sig : null, hour: new Date(at * 1000).getUTCHours() });
  }
}
writeFileSync(join(dir, 'replay-v0-forecasts.csv'), `open,k,p,up,S,K,sig,z,mom5,volRatio,hour\n${rows.map((r) => [r.open, r.k, r.p.toFixed(6), r.up, r.S.toFixed(2), r.K.toFixed(2), r.sig.toFixed(5), r.z.toFixed(5), r.mom5?.toFixed(5) ?? '', r.volRatio?.toFixed(5) ?? '', r.hour].join(',')).join('\n')}\n`);

const clip = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const brier = (a) => a.reduce((s, r) => s + (r.pp - r.up) ** 2, 0) / a.length;
const ll = (a) => -a.reduce((s, r) => s + (r.up ? Math.log(clip(r.pp)) : Math.log(1 - clip(r.pp))), 0) / a.length;
const tStart = rows[0].open; const tEnd = rows.at(-1).open;
const split = tStart + (tEnd - tStart) * 0.75; // chronological: first 75 % = train (climatology), last 25 % = holdout
const train = rows.filter((r) => r.open < split); const hold = rows.filter((r) => r.open >= split);
const clim = train.filter((r) => r.k === 14).reduce((s, r) => s + r.up, 0) / train.filter((r) => r.k === 14).length;
const report = { model: `${CRYPTO_MODEL.id}@${CRYPTO_MODEL.version}`, windows: rows.filter((r) => r.k === 14).length, period: [new Date(tStart * 1000).toISOString(), new Date(tEnd * 1000).toISOString()], holdout_from: new Date(split * 1000).toISOString(), climatology_up_rate_train: +clim.toFixed(4),
  proxy_check: { n: proxyCheck.length, median_abs_err_usd: absErr.length ? +absErr[absErr.length >> 1].toFixed(2) : null, p95_abs_err_usd: absErr.length ? +absErr[Math.floor(absErr.length * 0.95)].toFixed(2) : null, max_abs_err_usd: absErr.length ? +absErr.at(-1).toFixed(2) : null, mean_err_usd: errs.length ? +(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2) : null, result_agreement: proxyCheck.length ? `${resultAgree}/${proxyCheck.length}` : null },
  by_checkpoint: {}, calibration_holdout_T5: [] };
for (const { k, d } of CHECKS) {
  for (const [name, set] of [['all', rows], ['holdout', hold]]) {
    const a = set.filter((r) => r.k === k);
    const m = a.map((r) => ({ ...r, pp: r.p })); const h = a.map((r) => ({ ...r, pp: 0.5 })); const c = a.map((r) => ({ ...r, pp: clim }));
    (report.by_checkpoint[d] ||= {})[name] = { n: a.length, brier_v0: +brier(m).toFixed(4), logloss_v0: +ll(m).toFixed(4), brier_50: +brier(h).toFixed(4), logloss_50: +ll(h).toFixed(4), brier_clim: +brier(c).toFixed(4), logloss_clim: +ll(c).toFixed(4) };
  }
}
const h5 = hold.filter((r) => r.k === 5);
for (let b = 0; b < 10; b += 1) {
  const a = h5.filter((r) => r.p >= b / 10 && (b === 9 ? r.p <= 1 : r.p < (b + 1) / 10));
  if (a.length) report.calibration_holdout_T5.push({ bin: `${b * 10}-${b * 10 + 10}%`, n: a.length, mean_p: +(a.reduce((s, r) => s + r.p, 0) / a.length).toFixed(3), observed: +(a.reduce((s, r) => s + r.up, 0) / a.length).toFixed(3) });
}
writeFileSync(join(dir, 'replay-v0-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
