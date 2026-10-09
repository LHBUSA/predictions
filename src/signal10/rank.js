// Signal 10 ranking engine (pure, deterministic, Worker-safe).
// Every feature at decision date D reads ONLY bars with date <= D. Tests assert that appending future bars never
// changes a past snapshot (test/signal10-engine.test.js "future bars do not change past ranks").
import { RANK, MODEL_VERSION } from './policy.js';

// Prepared per-symbol arrays + prefix sums so each feature is O(1) (except the 63-bar median).
export function prepareSeries(s, calIndex) {
  const n = s.bars.length;
  const d = new Array(n), adj = new Float64Array(n), c = new Float64Array(n), o = new Float64Array(n), dv = new Float64Array(n), cal = new Int32Array(n);
  const ps = new Float64Array(n + 1), lr = new Float64Array(n + 1), lr2 = new Float64Array(n + 1);
  const idx = new Map();
  for (let i = 0; i < n; i++) {
    const b = s.bars[i];
    d[i] = b.d; adj[i] = b.adj; c[i] = b.c; o[i] = b.o; dv[i] = b.c * b.v; cal[i] = calIndex.has(b.d) ? calIndex.get(b.d) : -1;
    idx.set(b.d, i);
    ps[i + 1] = ps[i] + b.adj;
    const r = i ? Math.log(b.adj / adj[i - 1]) : 0;
    lr[i + 1] = lr[i] + r; lr2[i + 1] = lr2[i] + r * r;
  }
  return { symbol: s.symbol, name: s.name, n, d, adj, c, o, dv, cal, ps, lr, lr2, idx, splits: s.splits || [], dividends: s.dividends || [] };
}

const sma = (p, i, len) => (p.ps[i + 1] - p.ps[i + 1 - len]) / len;
function vol(p, i, len) { // annualized stdev of daily log returns over bars (i-len+1..i)
  const s = p.lr[i + 1] - p.lr[i + 1 - len], s2 = p.lr2[i + 1] - p.lr2[i + 1 - len];
  const m = s / len; const v = Math.max(0, s2 / len - m * m) * len / (len - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
function median(arr) { const a = Array.from(arr).sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }

// Features for prepared series p at bar index i (the bar dated D). Returns null when ineligible, with a reason.
export function features(p, i) {
  if (i == null || i < 0) return { eligible: false, reason: 'no_bar' };
  if (i + 1 < RANK.minHistory) return { eligible: false, reason: 'insufficient_history' };
  const j = i - (RANK.minHistory - 1);
  if (p.cal[i] < 0 || p.cal[j] < 0) return { eligible: false, reason: 'off_calendar' };
  if (p.cal[i] - p.cal[j] - (RANK.minHistory - 1) > RANK.maxCalendarGap) return { eligible: false, reason: 'trading_gap' };
  if (p.c[i] < RANK.minPrice) return { eligible: false, reason: 'price_below_5' };
  const mdv = median(p.dv.subarray(i - 62, i + 1));
  if (!(mdv >= RANK.minMedianDollarVolume)) return { eligible: false, reason: 'illiquid' };
  const mom12_1 = p.adj[i - 21] / p.adj[i - 252] - 1;
  const mom6 = p.adj[i] / p.adj[i - 126] - 1;
  const v252 = vol(p, i, 252), v63 = vol(p, i, 63);
  const s50 = sma(p, i, 50), s200 = sma(p, i, 200);
  let hi10 = 0; for (let k = i - 9; k <= i; k++) hi10 = Math.max(hi10, p.adj[k]);
  return {
    eligible: true, mom12_1, mom6, riskAdjMom: v252 > 0 ? mom12_1 / v252 : 0, trend200: p.adj[i] / s200 - 1, lowVol63: -v63,
    vol63: v63, sma50: s50, sma200: s200, adj: p.adj[i], close: p.c[i], ret1: p.adj[i] / p.adj[i - 1] - 1,
    pullback10: p.adj[i] / hi10 - 1, uptrend: p.adj[i] > s50 && s50 > s200, medianDollarVolume: mdv
  };
}

// Percentile of each value among the array (average rank for ties), 0..1.
export function percentiles(values) {
  const n = values.length;
  const order = values.map((v, k) => [v, k]).sort((a, b) => a[0] - b[0]);
  const out = new Array(n);
  for (let a = 0; a < n;) {
    let b = a; while (b + 1 < n && order[b + 1][0] === order[a][0]) b++;
    const r = n > 1 ? ((a + b) / 2) / (n - 1) : 1;
    for (let k = a; k <= b; k++) out[order[k][1]] = r;
    a = b + 1;
  }
  return out;
}

// Rank the point-in-time universe at date D.
// universe: [{ ticker, symbol }] members on D (symbol = resolved price-source symbol, null if uncovered).
// prepared: Map symbol -> prepared series. Returns { date, model, eligible, excluded, ranks:[...] } sorted by rank.
export function rankUniverse(date, universe, prepared) {
  const rows = [], excluded = {};
  const seen = new Set();
  for (const u of universe) {
    if (!u.symbol) { excluded.uncovered = (excluded.uncovered || 0) + 1; continue; }
    if (seen.has(u.symbol)) continue; seen.add(u.symbol);
    const p = prepared.get(u.symbol);
    if (!p) { excluded.uncovered = (excluded.uncovered || 0) + 1; continue; }
    const f = features(p, p.idx.get(date));
    if (!f.eligible) { excluded[f.reason] = (excluded[f.reason] || 0) + 1; continue; }
    rows.push({ ticker: u.ticker, symbol: u.symbol, name: p.name, f });
  }
  const W = RANK.weights;
  const keys = Object.keys(W);
  const pct = Object.fromEntries(keys.map((k) => [k, percentiles(rows.map((r) => r.f[k]))]));
  rows.forEach((r, k) => { r.composite = keys.reduce((s, key) => s + W[key] * pct[key][k], 0); });
  const cp = percentiles(rows.map((r) => r.composite));
  rows.forEach((r, k) => { r.score = Math.round(cp[k] * 1000) / 10; });
  rows.sort((a, b) => b.composite - a.composite || (a.symbol < b.symbol ? -1 : 1));
  rows.forEach((r, k) => { r.rank = k + 1; });
  return { date, model: MODEL_VERSION, eligible: rows.length, excluded, ranks: rows };
}
