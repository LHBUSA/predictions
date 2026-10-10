// Indicative spot reference prices from Gold-API.com (issue #78): validation, bounded collection, freshness states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from './helpers/s10-fakes.js';
import { GOLDAPI, parseGoldApi, collectSpot, spotView, spotMarketOpen, spotDue, latestRows, MAX_JUMP } from '../src/market-tape/goldapi.js';
import { SPOT } from '../src/market-tape/metals.js';
import { metalsPayload } from '../workers/pbe-predictions/src/arena-api.js';

const XAU = SPOT.find((x) => x.code === 'XAU');
const body = (code, price, updatedAt, extra = {}) => ({ currency: 'USD', currencySymbol: '$', exchangeRate: 1, name: code, price, symbol: code, updatedAt, ...extra });
const fakeProvider = (prices, calls = []) => async (url) => {
  calls.push(String(url));
  const code = String(url).split('/').at(-1);
  return prices[code] === undefined ? new Response('nope', { status: 503 }) : new Response(JSON.stringify(body(code, prices[code], '2026-10-12T15:00:00Z')), { status: 200 });
};

test('rights record + provider: commercial display permitted by Terms §9; indicative, never the LBMA benchmark', () => {
  assert.deepEqual(GOLDAPI.rights, { public: true, paid: true });
  assert.match(GOLDAPI.rights_note, /§9/);
  assert.equal(GOLDAPI.endpoint('XPT'), 'https://api.gold-api.com/price/XPT');
  assert.equal(GOLDAPI.basis, 'INDICATIVE_SPOT_REFERENCE');
});

test('parse: real response shape accepted; wrong symbol, currency, price or timestamp rejected', () => {
  const now = '2026-10-10T22:41:10Z';
  const ok = parseGoldApi(XAU, body('XAU', 4195.600098, '2026-10-10T22:41:05Z'), now);
  assert.equal(ok.ok, true); assert.equal(ok.quote.price, 4195.600098); assert.equal(ok.quote.provider_updated_at, '2026-10-10T22:41:05.000Z');
  assert.match(parseGoldApi(XAU, body('XAG', 60, '2026-10-10T22:41:05Z'), now).why, /symbol_mismatch/);
  assert.match(parseGoldApi(XAU, body('XAU', 4195, '2026-10-10T22:41:05Z', { currency: 'EUR' }), now).why, /currency/);
  assert.equal(parseGoldApi(XAU, body('XAU', 0, '2026-10-10T22:41:05Z'), now).why, 'bad_price');
  assert.equal(parseGoldApi(XAU, body('XAU', 4195, 'garbage'), now).why, 'bad_timestamp');
  assert.equal(parseGoldApi(XAU, body('XAU', 4195, '2026-10-11T22:41:05Z'), now).why, 'timestamp_in_future');
});

test('collector: 3 bounded calls per tick; writes on change or hourly heartbeat; a >20% jump is held, never stored', async () => {
  const store = new FakeStore(); const calls = [];
  const r1 = await collectSpot({ store, nowIso: '2026-10-12T15:02:00Z', fetchImpl: fakeProvider({ XAU: 4195.6, XAG: 60.95, XPT: 1695 }, calls) });
  assert.equal(calls.length, 3); assert.deepEqual(Object.keys(r1), ['XAU', 'XAG', 'XPT']);
  assert.equal(store.rows('pred_source_observations').length, 3);
  const row = store.rows('pred_source_observations')[0];
  assert.equal(row.provider, 'gold-api'); assert.equal(row.source_class, 'licensed'); assert.equal(row.units, 'USD/ozt');
  assert.equal(row.observed_at, '2026-10-12T15:00:00.000Z', 'provider update time'); assert.equal(row.captured_at, '2026-10-12T15:02:00Z');
  // unchanged price 5 min later: nothing written; changed price: written; 61 min later unchanged: heartbeat written
  await collectSpot({ store, nowIso: '2026-10-12T15:07:00Z', fetchImpl: fakeProvider({ XAU: 4195.6, XAG: 60.95, XPT: 1695 }) });
  assert.equal(store.rows('pred_source_observations').length, 3);
  await collectSpot({ store, nowIso: '2026-10-12T15:12:00Z', fetchImpl: fakeProvider({ XAU: 4199.1, XAG: 60.95, XPT: 1695 }) });
  assert.equal(store.rows('pred_source_observations').length, 4);
  await collectSpot({ store, nowIso: '2026-10-12T16:04:00Z', fetchImpl: fakeProvider({ XAU: 4199.1, XAG: 60.95, XPT: 1695 }) });
  assert.equal(store.rows('pred_source_observations').length, 6, 'XAG + XPT heartbeat after 62 min; XAU changed 52 min ago -> not yet');
  // implausible jump
  const r = await collectSpot({ store, nowIso: '2026-10-12T16:09:00Z', fetchImpl: fakeProvider({ XAU: 4199.1 * (1 + MAX_JUMP + 0.05), XAG: 60.95, XPT: 1695 }) });
  assert.equal(r.XAU.held, 'jump_over_20pct');
  // provider failure: nothing stored, reason reported
  const f = await collectSpot({ store, nowIso: '2026-10-12T16:14:00Z', fetchImpl: fakeProvider({}) });
  assert.equal(f.XPT.skipped, 'http_503');
});

test('market hours + schedule: Sun 18:00 ET to Fri 17:00 ET with the daily 17:00-18:00 ET break; collection on :02, :07, ...', () => {
  assert.equal(spotMarketOpen('2026-10-10T18:00:00Z'), false, 'Saturday');
  assert.equal(spotMarketOpen('2026-10-11T21:30:00Z'), false, 'Sunday 17:30 ET');
  assert.equal(spotMarketOpen('2026-10-11T22:05:00Z'), true, 'Sunday 18:05 ET');
  assert.equal(spotMarketOpen('2026-10-12T21:30:00Z'), false, 'Monday 17:30 ET break');
  assert.equal(spotMarketOpen('2026-10-12T15:00:00Z'), true, 'Monday 11:00 ET');
  assert.equal(spotMarketOpen('2026-10-16T21:05:00Z'), false, 'Friday 17:05 ET');
  assert.equal(spotDue('2026-10-12T15:02:00Z'), true); assert.equal(spotDue('2026-10-12T15:03:00Z'), false);
});

test('display states: indicative, stale, market closed (last price), unavailable, off, awaiting; 24h change from our own rows', () => {
  const rows = [{ captured_at: '2026-10-12T15:02:00Z', observed_at: '2026-10-12T15:00:00Z', value: 4200 }, { captured_at: '2026-10-11T15:00:00Z', observed_at: '2026-10-11T15:00:00Z', value: 4000 }];
  const v = spotView(rows, '2026-10-12T15:05:00Z');
  assert.equal(v.state, 'INDICATIVE'); assert.equal(v.value, 4200); assert.ok(Math.abs(v.change_24h - 0.05) < 1e-12);
  assert.equal(spotView(rows, '2026-10-12T15:30:00Z').state, 'STALE');
  assert.equal(spotView(rows, '2026-10-12T22:00:00Z').state, 'UNAVAILABLE', '7 h without a capture while open');
  assert.equal(spotView(rows, '2026-10-12T22:00:00Z').value, null);
  const sat = spotView([{ captured_at: '2026-10-09T20:57:00Z', observed_at: '2026-10-09T20:57:00Z', value: 4195.6 }], '2026-10-10T22:00:00Z');
  assert.equal(sat.state, 'MARKET_CLOSED'); assert.equal(sat.value, 4195.6, 'weekend shows the last indicative price, labelled');
  assert.equal(spotView([], '2026-10-12T15:00:00Z').state, 'AWAITING_FIRST_OBSERVATION');
  assert.equal(spotView(rows, '2026-10-12T15:05:00Z', { on: false }).value, null);
});

test('API: spot read from stored observations only (no provider call per visitor); kill switch hides values; ETF block separate', async () => {
  const store = new FakeStore();
  await collectSpot({ store, nowIso: '2026-10-12T15:02:00Z', fetchImpl: fakeProvider({ XAU: 4195.6, XAG: 60.95, XPT: 1695 }) });
  const realFetch = globalThis.fetch; let upstream = 0; globalThis.fetch = async () => { upstream++; throw new Error('no upstream from the API'); };
  try {
    const p = await metalsPayload({ env: { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' }, store, member: false, now: '2026-10-12T15:05:00Z' });
    assert.equal(upstream, 0);
    assert.deepEqual(p.spot.map((x) => [x.code, x.quote.state, x.quote.value]), [['XAU', 'INDICATIVE', 4195.6], ['XAG', 'INDICATIVE', 60.95], ['XPT', 'INDICATIVE', 1695]]);
    assert.equal(p.spot_attribution.name, 'Gold-API.com'); assert.match(p.spot_note, /Not the LBMA benchmark/);
    assert.ok(p.etfs.every((e) => e.kind === 'ETF' && e.quote.unit === 'USD/share'), 'ETF share prices are a separate product');
    const off = await metalsPayload({ env: { METALS_SPOT_DISPLAY: 'off' }, store, member: false, now: '2026-10-12T15:05:00Z' });
    assert.ok(off.spot.every((x) => x.quote.value === null && x.quote.state === 'OFF'));
  } finally { globalThis.fetch = realFetch; }
  const rows = await latestRows(store, '2026-10-12T15:05:00Z');
  assert.deepEqual(Object.keys(rows).sort(), ['XAG', 'XAU', 'XPT']);
});
