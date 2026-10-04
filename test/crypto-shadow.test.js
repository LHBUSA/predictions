// BTC 15-minute nowcast SHADOW (src/crypto/btc-shadow.js): frozen v0 exactly as replayed, market-free features, no
// BRTI value ever stored, fixed designations, benchmarks within +-30 s, Kalshi-published resolution, cron isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  forecastWindow, proxyRef, closeAt, sigmaAnn, dataCutoff, kalshiObs, polymarketObs, polymarketUpToken, polymarketResult, dueDesignations,
  nearestObs, scoreRows, runBtcShadow, windowId, windowOpenFor, MODEL, WINDOW_S,
} from '../src/crypto/btc-shadow.js';
import { probabilityCryptoAbove } from '../src/models/crypto-v0.js';
import { findMarketKeys } from '../src/engine/leakage.js';

const OPEN = 1791158400; // 2026-10-05T00:00:00Z (quarter-hour)
function candles(fromS, toS, f = (t) => 60000 + 15 * Math.sin(t / 420) + (t - fromS) / 600) {
  const cb = new Map(); const bs = new Map();
  for (let t = fromS; t < toS; t += 60) {
    const p = f(t);
    cb.set(t, { o: p, h: p + 4, l: p - 4, c: p + 1 });
    bs.set(t, { o: p + 2, h: p + 5, l: p - 3, c: p + 2.5 });
  }
  return { cb, bs };
}

test('forecast = crypto-v0 exactly as replayed (K proxy at open, S last close, 60-return vol, horizon - 0.5)', () => {
  const c = candles(OPEN - 90 * 60, OPEN + 6 * 60);
  const now = OPEN + 5 * 60 + 4; // 4 s after a minute boundary: cutoff = OPEN + 5 min
  const f = forecastWindow(c, OPEN, now);
  assert.equal(f.status, 'OK');
  const cut = OPEN + 300;
  assert.equal(dataCutoff(c, now), cut);
  const K = proxyRef(c, OPEN); const S = closeAt(c, cut); const sig = sigmaAnn(c, cut);
  const expect = probabilityCryptoAbove({ currentPrice: S, annualizedVol: sig }, K, (10 - 0.5) / 1440).probability;
  assert.equal(f.p_up, expect);
  assert.equal(f.horizonMin, 9.5);
  assert.deepEqual(findMarketKeys(f.features), [], 'features are market-free');
  assert.deepEqual(Object.keys(f.features).sort(), ['btc_open_ref_usd', 'btc_spot_usd', 'exchange_gap_usd', 'horizon_min', 'rv60_annualized', 'z_distance']);
});

test('forecast refuses honestly: before open, settlement window, no open reference, stale or short history', () => {
  const c = candles(OPEN - 90 * 60, OPEN + 16 * 60);
  assert.equal(forecastWindow(c, OPEN, OPEN - 5).status, 'BEFORE_OPEN');
  assert.equal(forecastWindow(c, OPEN, OPEN + WINDOW_S - 59).status, 'SETTLEMENT_WINDOW');
  const gap = candles(OPEN - 90 * 60, OPEN + 6 * 60); gap.cb.delete(OPEN - 60);
  assert.equal(forecastWindow(gap, OPEN, OPEN + 120).status, 'NO_OPEN_REFERENCE');
  const old = candles(OPEN - 90 * 60, OPEN + 2 * 60);
  assert.equal(forecastWindow(old, OPEN, OPEN + 6 * 60).status, 'STALE_UNDERLYING');
  const short = candles(OPEN - 20 * 60, OPEN + 3 * 60);
  assert.equal(forecastWindow(short, OPEN, OPEN + 3 * 60 + 2).status, 'INSUFFICIENT_HISTORY');
});

test('Kalshi benchmark keeps identity + quote only: strike / expiration value (BRTI) never pass through', () => {
  const events = [{ markets: [
    { ticker: 'KXBTC15M-26OCT041215-15', open_time: new Date(OPEN * 1000).toISOString(), yes_bid_dollars: '0.4100', yes_ask_dollars: '0.4300', status: 'active', floor_strike: 84694.41, expiration_value: '84700.12', custom_strike: { x: 1 } },
    { ticker: 'OTHER', open_time: new Date((OPEN + 900) * 1000).toISOString(), yes_bid_dollars: '0.5', yes_ask_dollars: '0.52' },
  ] }];
  const k = kalshiObs(events, OPEN, '2026-10-04T16:05:04Z');
  assert.deepEqual(k, { venue: 'kalshi', market_id: 'KXBTC15M-26OCT041215-15', captured_at: '2026-10-04T16:05:04Z', bid: 0.41, ask: 0.43, mid: 0.42, market_status: 'active', comparability: 'SAME_CONTRACT' });
  assert.ok(!/strike|expiration|84694|84700/.test(JSON.stringify(k)));
  assert.equal(kalshiObs(events, OPEN + 1800, 'x'), null);
  // wide quote -> no mid
  assert.equal(kalshiObs([{ markets: [{ ...events[0].markets[0], yes_bid_dollars: '0.2', yes_ask_dollars: '0.5' }] }], OPEN, 'x').mid, null);
});

test('Polymarket benchmark: Up token from Gamma, quote from the CLOB book (Gamma quotes lag); labelled different index', () => {
  const ev = { slug: 's', markets: [{ conditionId: '0xabc', outcomes: '["Up", "Down"]', clobTokenIds: '["111", "222"]', bestBid: 0.47, bestAsk: 0.48, active: true }] };
  const up = polymarketUpToken(ev);
  assert.deepEqual(up, { token: '111', market_id: '0xabc', closed: false, active: true });
  assert.equal(polymarketUpToken({ markets: [{ ...ev.markets[0], outcomes: '["Down", "Up"]' }] }).token, '222');
  const book = { bids: [{ price: '0.01' }, { price: '0.70' }, { price: '0.69' }], asks: [{ price: '0.99' }, { price: '0.71' }] };
  assert.deepEqual(polymarketObs(up, book, 't'), { venue: 'polymarket', market_id: '0xabc', captured_at: 't', bid: 0.7, ask: 0.71, mid: 0.705, market_status: 'active', comparability: 'SAME_WINDOW_DIFFERENT_INDEX' });
  assert.equal(polymarketObs(up, null, 't'), null);
  assert.equal(polymarketResult({ markets: [{ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' }] }), 'down');
  assert.equal(polymarketResult({ markets: [{ closed: false }] }), null);
});

test('designations (crypto-designation/1): fixed rules, written once, never a forecast before open', () => {
  const at = (s) => new Date((OPEN + s) * 1000).toISOString();
  const fs = [-30, 4, 64, 304, 544, 604, 784, 844].map((s, i) => ({ forecast_id: i + 1, captured_at: at(s), p_up: 0.5 }));
  const d = Object.fromEntries(dueDesignations({ openAt: at(0), closeAt: at(900), forecasts: fs }).map((x) => [x.designation, x.forecast.forecast_id]));
  // close - 600 = +300 -> latest <= 300 is +64 (id 3); close - 300 = +600 -> +544 (id 5); close - 60 = +840 -> +784 (id 7)
  assert.deepEqual(d, { FIRST_PUBLISHED: 2, T_MINUS_10: 3, T_MINUS_5: 5, T_MINUS_1: 7, FINAL_PRE_RESOLUTION: 7 });
  const again = dueDesignations({ openAt: at(0), closeAt: at(900), forecasts: fs, existing: [{ designation: 'FIRST_PUBLISHED' }, { designation: 'T_MINUS_10' }] });
  assert.deepEqual(again.map((x) => x.designation), ['T_MINUS_5', 'T_MINUS_1', 'FINAL_PRE_RESOLUTION']);
});

test('benchmark = venue observation within +-30 s, else none (no interpolation); scores per venue', () => {
  const obs = [{ obs_id: 1, venue: 'kalshi', captured_at: '2026-10-04T16:05:40Z', mid: 0.4 }, { obs_id: 2, venue: 'kalshi', captured_at: '2026-10-04T16:05:05Z', mid: 0.42 }, { obs_id: 3, venue: 'polymarket', captured_at: '2026-10-04T16:06:00Z', mid: 0.5 }];
  assert.equal(nearestObs(obs, 'kalshi', '2026-10-04T16:05:04Z').obs_id, 2);
  assert.equal(nearestObs(obs, 'polymarket', '2026-10-04T16:05:04Z'), null);
  const rows = scoreRows({ designation: { designation_id: 9, window_id: 'w', designation: 'T_MINUS_5' }, forecast: { p_up: 0.7 }, outcome: 1, kalshi: { mid: 0.6 }, polymarket: null });
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0].pbe_score - 0.09) < 1e-12 && Math.abs(rows[0].kalshi_score - 0.16) < 1e-12);
  assert.equal(rows[0].polymarket_score, null);
});

function fakeStore() {
  const t = { pred_crypto_windows: [], pred_crypto_forecasts: [], pred_crypto_venue_obs: [], pred_crypto_designations: [], pred_crypto_resolutions: [], pred_crypto_scores: [] };
  let id = 0;
  const keyOf = (row, cols) => cols.split(',').map((c) => row[c]).join('|');
  return {
    t,
    async write(table, rows, { conflictColumn, returnRepresentation } = {}) {
      const list = Array.isArray(rows) ? rows : [rows];
      const out = [];
      for (const r of list) {
        if (table === 'pred_crypto_forecasts') assert.deepEqual(findMarketKeys(r.features), []);
        if (conflictColumn && t[table].some((x) => keyOf(x, conflictColumn) === keyOf(r, conflictColumn))) continue;
        const row = { ...r };
        if (table === 'pred_crypto_forecasts') row.forecast_id = ++id;
        if (table === 'pred_crypto_venue_obs') row.obs_id = ++id;
        if (table === 'pred_crypto_designations') row.designation_id = ++id;
        t[table].push(row); out.push(row);
      }
      return returnRepresentation ? out : null;
    },
    async select(table, q) { return t[table].filter((r) => !q.close_at || Date.parse(r.close_at) <= Date.parse(q.close_at.slice(4))); },
    async selectIn(table, q, col, ids) { return t[table].filter((r) => ids.includes(r[col])); },
  };
}

test('runBtcShadow: full window — forecasts, both venues, Kalshi resolution, 5 designations, scores; no BRTI stored', async () => {
  const store = fakeStore();
  const c = candles(OPEN - 120 * 60, OPEN + 40 * 60);
  const iso = (s) => new Date(s * 1000).toISOString();
  const fetchImpl = async (url) => {
    const u = String(url);
    const nowS = Number(new URL(u).searchParams.get('end') ? Date.parse(new URL(u).searchParams.get('end')) / 1000 : 0);
    if (u.includes('api.coinbase.com')) return { ok: false, status: 429, json: async () => ({}) }; // primary down -> Exchange fallback
    if (u.includes('coinbase')) return { ok: true, json: async () => [...c.cb].filter(([t]) => t < nowS).map(([t, x]) => [t, x.l, x.h, x.o, x.c, 1]) };
    if (u.includes('bitstamp')) return { ok: true, json: async () => ({ data: { ohlc: [...c.bs].filter(([t]) => t < fetchImpl.nowS - (fetchImpl.nowS % 60)).map(([t, x]) => ({ timestamp: String(t), open: x.o, high: x.h, low: x.l, close: x.c, volume: 1 })) } }) };
    if (u.includes('gamma-api')) return { ok: true, json: async () => [{ slug: 's', markets: [{ conditionId: '0xpm', outcomes: '["Up","Down"]', clobTokenIds: '["7","8"]', active: true, closed: fetchImpl.nowS >= OPEN + 900, outcomePrices: '["1","0"]' }] }] };
    if (u.includes('clob.polymarket.com/book?token_id=7')) return { ok: true, json: async () => ({ bids: [{ price: '0.55' }], asks: [{ price: '0.57' }] }) };
    throw new Error(u);
  };
  const ticker = 'KXBTC15M-26OCT041215-15';
  const mkt = {
    openEvents: async () => ({ events: [{ markets: [{ ticker, open_time: iso(OPEN), yes_bid_dollars: '0.5000', yes_ask_dollars: '0.5200', status: 'active', floor_strike: 99999.99, expiration_value: '99999.98' }] }] }),
    marketsByTicker: async (ts) => ts.map((x) => ({ ticker: x, result: 'yes', settlement_ts: iso(OPEN + 904), expiration_value: '99999.98' })),
  };
  for (let s = OPEN + 4; s <= OPEN + 900 + 64; s += 60) { fetchImpl.nowS = s; await runBtcShadow({ store, mkt, fetchImpl, now: iso(s) }); }
  const T = store.t;
  const W = windowId(OPEN);
  assert.deepEqual(T.pred_crypto_windows.map((w) => w.window_id), [W, windowId(OPEN + 900)], 'the next window opens at the last tick');
  assert.equal(T.pred_crypto_windows[0].kalshi_market_ticker, ticker);
  assert.equal(T.pred_crypto_forecasts.filter((f) => f.window_id === W).length, 14, 'one forecast per minute from open until the averaging window');
  assert.ok(T.pred_crypto_forecasts.every((f) => f.model_state === 'SHADOW' && f.model_id === MODEL.id));
  assert.deepEqual(T.pred_crypto_designations.filter((d) => d.window_id === W).map((d) => d.designation).sort(), ['FINAL_PRE_RESOLUTION', 'FIRST_PUBLISHED', 'T_MINUS_1', 'T_MINUS_10', 'T_MINUS_5']);
  assert.ok(T.pred_crypto_designations.every((d) => d.kalshi_obs_id && d.polymarket_obs_id));
  assert.equal(T.pred_crypto_resolutions.length, 1);
  assert.equal(T.pred_crypto_resolutions[0].venue_result, 'yes');
  assert.equal(T.pred_crypto_resolutions[0].polymarket_result, 'up');
  assert.equal(T.pred_crypto_scores.length, 10);
  const all = JSON.stringify(T);
  { const hit = all.match(/99999\.9[89]|floor_strike|expiration_value|brti/i); assert.equal(hit, null, `no BRTI-derived value anywhere in the ledger: ${hit && all.slice(hit.index - 80, hit.index + 40)}`); }
});

test('cron isolation: the 1-minute cron never runs the engine cycle; off unless CRYPTO_SHADOW=true; config pinned', () => {
  const src = readFileSync(new URL('../workers/pbe-predictions/src/index.js', import.meta.url), 'utf8');
  const sched = src.slice(src.indexOf('async scheduled('), src.indexOf('async fetch('));
  const shadow = sched.slice(0, sched.indexOf("if (env.ENGINE_ENABLED !== 'true') return;"));
  assert.match(shadow, /event\.cron === BTC_SHADOW_CRON/);
  assert.match(shadow, /CRYPTO_SHADOW !== 'true'\) return;/);
  assert.match(shadow, /return;\s*\}\s*$/);
  assert.ok(!/runCycle/.test(shadow));
  const cfg = readFileSync(new URL('../workers/pbe-predictions/wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(cfg, /"crons": \["\*\/15 \* \* \* \*", "\* \* \* \* \*"\]/);
  assert.equal(windowOpenFor(OPEN + 899), OPEN);
});

test('Coinbase Advanced Trade candles parse to the same bars as the Exchange endpoint', async () => {
  const { parseCoinbase, parseCoinbaseAdvanced } = await import('../src/crypto/btc-shadow.js');
  const ex = parseCoinbase([[1791128580, 85326.29, 85339.64, 85339.63, 85334.75, 1.4]]);
  const adv = parseCoinbaseAdvanced({ candles: [{ start: '1791128580', low: '85326.29', high: '85339.64', open: '85339.63', close: '85334.75', volume: '1.4' }] });
  assert.deepEqual(adv.get(1791128580), ex.get(1791128580));
});

test('venue settlements (sql/010, audit only): Kalshi result without BRTI values; Polymarket only once UMA-resolved; source timestamps passed through, never derived', async () => {
  const { kalshiSettlement, polymarketSettlement, captureVenueSettlements } = await import('../src/crypto/btc-shadow.js');
  const k = kalshiSettlement({ ticker: 'KXBTC15M-X', result: 'no', settlement_ts: '2026-10-04T16:00:07.197596Z', expiration_value: '85269.12', settlement_value_dollars: '0', floor_strike: 85300.1 });
  assert.deepEqual(k, { market_id: 'KXBTC15M-X', result: 'no', direction: 'DOWN', source_settled_at: '2026-10-04T16:00:07.197596Z', source: 'kalshi markets (via propsports-markets)', ref: { settlement_ts: '2026-10-04T16:00:07.197596Z', status: null } });
  assert.ok(!/85269|85300|expiration|strike/.test(JSON.stringify(k)));
  const ev = (over) => ({ slug: 's', markets: [{ conditionId: '0xpm', closed: true, umaResolutionStatus: 'resolved', outcomes: '["Up", "Down"]', outcomePrices: '["0", "1"]', umaEndDate: '2026-10-04T16:01:28Z', closedTime: '2026-10-04 16:01:28+00', ...over }] });
  assert.equal(polymarketSettlement(ev({ umaResolutionStatus: 'proposed' })), null);
  assert.equal(polymarketSettlement(ev({ closed: false })), null);
  const p = polymarketSettlement(ev({}));
  assert.deepEqual([p.result, p.direction, p.source_settled_at, p.ref.closedTime], ['down', 'DOWN', '2026-10-04T16:01:28Z', '2026-10-04 16:01:28+00']);
  assert.equal(polymarketSettlement(ev({ umaEndDate: undefined })).source_settled_at, null, 'no source timestamp -> null, never invented');

  const store = fakeStore();
  store.t.pred_crypto_venue_settlements = [];
  store.t.pred_crypto_windows.push({ window_id: 'W1', open_at: '2026-10-04T15:45:00Z', close_at: '2026-10-04T16:00:00Z', polymarket_slug: 's', kalshi_market_ticker: 'KXBTC15M-X' });
  store.t.pred_crypto_resolutions.push({ window_id: 'W1', venue_result: 'no' });
  const before = JSON.stringify([store.t.pred_crypto_resolutions, store.t.pred_crypto_scores]);
  const mkt = { marketsByTicker: async (ts) => ts.map((t) => ({ ticker: t, result: 'no', settlement_ts: '2026-10-04T16:00:07Z' })) };
  let pmCalls = 0;
  const fetchImpl = async () => { pmCalls += 1; return { ok: true, json: async () => [ev(pmCalls === 1 ? { umaResolutionStatus: 'proposed' } : {})] }; };
  const r1 = await captureVenueSettlements({ store, mkt, fetchImpl, now: '2026-10-04T16:00:33Z' });
  assert.deepEqual(r1, { kalshi: 1, polymarket: 0, pending: 1 });
  const r2 = await captureVenueSettlements({ store, mkt, fetchImpl, now: '2026-10-04T16:20:33Z' });
  assert.deepEqual(r2, { kalshi: 0, polymarket: 1, pending: 0 });
  const rows = store.t.pred_crypto_venue_settlements;
  assert.deepEqual(rows.map((x) => [x.venue, x.result, x.observed_at, x.source_settled_at]), [['kalshi', 'no', '2026-10-04T16:00:33Z', '2026-10-04T16:00:07Z'], ['polymarket', 'down', '2026-10-04T16:20:33Z', '2026-10-04T16:01:28Z']]);
  assert.deepEqual((await captureVenueSettlements({ store, mkt, fetchImpl, now: '2026-10-04T16:30:00Z' })), { kalshi: 0, polymarket: 0, pending: 0 }, 'one row per window + venue');
  assert.equal(JSON.stringify([store.t.pred_crypto_resolutions, store.t.pred_crypto_scores]), before, 'frozen resolution + scores untouched');
});

test('completeness: expected minute ticks vs forecasts written, gap minutes, venue quote misses', async () => {
  const { windowCompleteness } = await import('../src/crypto/btc-shadow.js');
  const w = { window_id: 'W', open_at: '2026-10-04T15:45:00Z', close_at: '2026-10-04T16:00:00Z' };
  const fc = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((m) => ({ captured_at: `2026-10-04T15:${String(45 + m).padStart(2, '0')}:33Z` }));
  const obs = [{ venue: 'kalshi', mid: 0.5, captured_at: '2026-10-04T15:46:33Z' }, { venue: 'polymarket', mid: null, captured_at: '2026-10-04T15:46:33Z' }];
  const c = windowCompleteness(w, fc, obs);
  assert.deepEqual([c.expected_ticks, c.forecasts_written, c.forecast_gaps, c.kalshi_quote_misses, c.polymarket_quote_misses], [14, 13, 1, 13, 14]);
  assert.deepEqual(c.gap_minutes, ['15:45']);
});

test('exchange-read failure skips the forecast but still captures venue quotes for an existing window', async () => {
  const store = fakeStore();
  const iso = (x) => new Date(x * 1000).toISOString();
  store.t.pred_crypto_windows.push({ window_id: windowId(OPEN), open_at: iso(OPEN), close_at: iso(OPEN + 900) });
  const sel = store.select.bind(store);
  store.select = async (tb, q, o) => (q.window_id ? store.t[tb].filter((r) => r.window_id === q.window_id.slice(3)) : sel(tb, q, o));
  const fetchImpl = async (u) => {
    if (String(u).includes('coinbase') || String(u).includes('bitstamp')) return { ok: false, status: 429, json: async () => ({}) };
    if (String(u).includes('gamma-api')) return { ok: true, json: async () => [{ markets: [{ conditionId: '0xpm', outcomes: '["Up","Down"]', clobTokenIds: '["7","8"]', active: true }] }] };
    return { ok: true, json: async () => ({ bids: [{ price: '0.5' }], asks: [{ price: '0.52' }] }) };
  };
  const mkt = { openEvents: async () => ({ events: [{ markets: [{ ticker: 'K', open_time: iso(OPEN), yes_bid_dollars: '0.4', yes_ask_dollars: '0.42' }] }] }), marketsByTicker: async () => [] };
  const out = await runBtcShadow({ store, mkt, fetchImpl, now: iso(OPEN + 64) });
  assert.equal(out.forecast.status, 'SOURCE_ERROR');
  assert.equal(store.t.pred_crypto_forecasts.length, 0);
  assert.deepEqual(store.t.pred_crypto_venue_obs.map((o) => [o.venue, o.mid]), [['kalshi', 0.41], ['polymarket', 0.51]]);
});
