// Indicative spot reference prices from Gold-API.com (issue #78): validation, bounded collection, freshness states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from './helpers/s10-fakes.js';
import { GOLDAPI, parseGoldApi, collectSpot, spotView, spotMarketOpen, spotDue, latestRows, MAX_JUMP } from '../src/market-tape/goldapi.js';
import { SPOT } from '../src/market-tape/metals.js';
import { metalsPayload } from '../workers/pbe-predictions/src/arena-api.js';

const XAU = SPOT.find((x) => x.code === 'XAU');
const body = (code, price, updatedAt, extra = {}) => ({ currency: 'USD', currencySymbol: '$', exchangeRate: 1, name: code, price, symbol: code, updatedAt, ...extra });
const fakeProvider = (prices, calls = [], updatedAt = '2026-10-12T15:00:00Z') => async (url) => {
  calls.push(String(url));
  const code = String(url).split('/').at(-1);
  return prices[code] === undefined ? new Response('nope', { status: 503 }) : new Response(JSON.stringify(body(code, prices[code], updatedAt)), { status: 200 });
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

test('collector: 3 bounded calls per tick; change or heartbeat (10 min open / 60 min closed); a >20% jump is held until confirmed', async () => {
  const store = new FakeStore(); const calls = [];
  const disp = () => store.rows('pred_source_observations').filter((r) => r.provider === 'gold-api');
  const held = () => store.rows('pred_source_observations').filter((r) => r.provider === 'gold-api-held');
  const r1 = await collectSpot({ store, nowIso: '2026-10-12T15:02:00Z', fetchImpl: fakeProvider({ XAU: 4195.6, XAG: 60.95, XPT: 1695 }, calls) });
  assert.equal(calls.length, 3); assert.deepEqual(Object.keys(r1), ['XAU', 'XAG', 'XPT']);
  assert.equal(disp().length, 3);
  const row = disp()[0];
  assert.equal(row.source_class, 'licensed'); assert.equal(row.units, 'USD/ozt');
  assert.equal(row.observed_at, '2026-10-12T15:00:00.000Z', 'provider update time'); assert.equal(row.captured_at, '2026-10-12T15:02:00Z');
  // market open (Monday): unchanged 5 min later -> nothing; unchanged 10+ min later -> heartbeat (so a healthy feed never reads STALE)
  await collectSpot({ store, nowIso: '2026-10-12T15:07:00Z', fetchImpl: fakeProvider({ XAU: 4195.6, XAG: 60.95, XPT: 1695 }) });
  assert.equal(disp().length, 3);
  await collectSpot({ store, nowIso: '2026-10-12T15:12:00Z', fetchImpl: fakeProvider({ XAU: 4195.6, XAG: 60.95, XPT: 1695 }) });
  assert.equal(disp().length, 6);
  // market closed (Saturday): unchanged price only hourly
  const sat = new FakeStore();
  await collectSpot({ store: sat, nowIso: '2026-10-10T18:02:00Z', fetchImpl: fakeProvider({ XAU: 4195.6, XAG: 60.95, XPT: 1695 }, [], '2026-10-10T18:01:00Z') });
  await collectSpot({ store: sat, nowIso: '2026-10-10T18:32:00Z', fetchImpl: fakeProvider({ XAU: 4195.6, XAG: 60.95, XPT: 1695 }, [], '2026-10-10T18:31:00Z') });
  assert.equal(sat.rows('pred_source_observations').length, 3);
  // implausible jump: held (audit row only, never displayed); a confirming second reading within 15 min is accepted
  const r = await collectSpot({ store, nowIso: '2026-10-12T15:17:00Z', fetchImpl: fakeProvider({ XAU: 4195.6 * 1.3, XAG: 60.95, XPT: 1695 }) });
  assert.equal(r.XAU.held, 'jump_over_20pct'); assert.equal(held().length, 1); assert.equal(disp().filter((x) => x.source_id === 'goldapi:XAU').at(-1).value, 4195.6);
  const r2 = await collectSpot({ store, nowIso: '2026-10-12T15:22:00Z', fetchImpl: fakeProvider({ XAU: 4195.6 * 1.3 * 1.005, XAG: 60.95, XPT: 1695 }) });
  assert.ok(r2.XAU.written, 'confirmed new level accepted');
  // a lone spike that is not confirmed stays held
  const r3 = await collectSpot({ store, nowIso: '2026-10-12T15:27:00Z', fetchImpl: fakeProvider({ XAU: 1, XAG: 60.95, XPT: 1695 }) });
  assert.equal(r3.XAU.held, 'jump_over_20pct');
  // provider failure: nothing stored, reason reported
  const f = await collectSpot({ store, nowIso: '2026-10-12T15:32:00Z', fetchImpl: fakeProvider({}) });
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

test('display states: indicative, stale, market closed (last price), unavailable, off; 24h change from our own rows', () => {
  const rows = [{ captured_at: '2026-10-12T15:02:00Z', observed_at: '2026-10-12T15:00:00Z', value: 4200 }, { captured_at: '2026-10-11T15:00:00Z', observed_at: '2026-10-11T15:00:00Z', value: 4000 }];
  const v = spotView(rows, '2026-10-12T15:05:00Z');
  assert.equal(v.state, 'INDICATIVE'); assert.equal(v.value, 4200); assert.ok(Math.abs(v.change_24h - 0.05) < 1e-12); assert.equal(v.provider_updated_at, '2026-10-12T15:00:00Z');
  assert.equal(spotView(rows, '2026-10-12T15:30:00Z').state, 'STALE');
  assert.equal(spotView(rows, '2026-10-12T22:00:00Z').state, 'UNAVAILABLE', '7 h without a capture while open');
  assert.equal(spotView(rows, '2026-10-12T22:00:00Z').value, null);
  const sat = spotView([{ captured_at: '2026-10-09T20:57:00Z', observed_at: '2026-10-09T20:57:00Z', value: 4195.6 }], '2026-10-10T22:00:00Z');
  assert.equal(sat.state, 'MARKET_CLOSED'); assert.equal(sat.value, 4195.6, 'weekend shows the last indicative price, labelled');
  assert.equal(sat.provider_updated_at, null, 'no fresh-looking provider time while the market is closed');
  assert.equal(spotView([], '2026-10-12T15:00:00Z').state, 'UNAVAILABLE');
  assert.equal(spotView(rows, '2026-10-12T15:05:00Z', { on: false }).value, null);
});

test('display read is bounded: two one-row selects per metal, no jsonb columns', async () => {
  const store = new FakeStore(); const sel = []; const orig = store.select.bind(store);
  store.select = (t, q, o) => { sel.push([t, q.select, o?.limit]); return orig(t, q, o); };
  await collectSpot({ store, nowIso: '2026-10-11T15:02:00Z', fetchImpl: fakeProvider({ XAU: 4000, XAG: 60, XPT: 1600 }, [], '2026-10-11T15:00:00Z') });
  await collectSpot({ store, nowIso: '2026-10-12T15:02:00Z', fetchImpl: fakeProvider({ XAU: 4200, XAG: 61, XPT: 1650 }) });
  sel.length = 0;
  const rows = await latestRows(store, '2026-10-12T15:05:00Z');
  assert.equal(sel.length, 6); assert.ok(sel.every(([t, cols, lim]) => t === 'pred_source_observations' && lim === 1 && !/data/.test(cols)));
  assert.equal(rows.XAU[0].value, 4200); assert.equal(rows.XAU[1].value, 4000);
  assert.ok(Math.abs(spotView(rows.XAU, '2026-10-12T15:05:00Z').change_24h - 0.05) < 1e-12);
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

test('ETF share prices: NEXT_DAY for the latest completed session (one session of slack), STALE when older (#78 item 3)', async () => {
  const store = new FakeStore();
  const row = (sym, d, v) => ({ source_id: `iex:TOPS:${d}:${sym}`, provider: 'iex', observed_at: `${d}T19:59:59Z`, captured_at: `${d}T23:00:00Z`, value: v, data: { session_date: d } });
  store.rows('pred_source_observations').push(row('GLD', '2026-10-09', 384.59), row('SLV', '2026-10-02', 50));
  const env = { MARKET_TAPE_QUOTES: 'on', MARKET_TAPE_PROVIDER: 'iex-hist' };
  const p = await metalsPayload({ env, store, member: false, now: '2026-10-10T22:00:00Z' });
  const by = Object.fromEntries(p.etfs.map((e) => [e.symbol, e.quote]));
  assert.equal(by.GLD.state, 'NEXT_DAY'); assert.equal(by.GLD.value, 384.59);
  assert.equal(by.SLV.state, 'STALE', 'a week-old session is never shown as next-day'); assert.equal(by.SLV.value, 50);
  assert.equal(by.PPLT.state, 'AWAITING_FIRST_OBSERVATION'); assert.equal(by.PPLT.value, null);
});
