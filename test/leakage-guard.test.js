// LEAKAGE GUARD (owner 2026-10-03): PBE models are independent of BOTH venues. Changing every Kalshi and
// Polymarket price by an absurd amount (all 0c, all 99c, seeded random) cannot change a single PBE feature or
// forecast. Covers every live lane: rain v1 + v1.1, max temp v1 + v1.1, Fed SHADOW, rates path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MARKET_KEY_PATTERN, buildFeatureVector, assertMarketFree, assertModelInput, assertContractTermsOnly,
  assertModelSource, assertModelSourceTable, MarketLeakageError,
} from '../src/engine/leakage.js';
import { normalizeContract } from '../src/engine/contracts.js';
import { runAllLanes, modelSnapshot, polymarketVenue, KALSHI, NOW } from './helpers/venue-harness.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/golden/model-outputs-pre-guard.json', import.meta.url)));
const official = { sourceClass: 'official', provider: 'NWS', sourceId: 'mos:GFS:KNYC' };

test('denylist: every venue-derived key is refused at any depth', () => {
  const keys = ['kalshi_mid', 'polymarket_price', 'prediction_market_prob', 'best_bid', 'best_ask', 'bestBid', 'bestAsk', 'yes_bid', 'no_ask', 'bid', 'ask', 'bids', 'asks',
    'bid_ask_spread', 'midpoint', 'mid', 'mid_bp', 'mid_price', 'comparable_mid_bp', 'spread', 'spread_bp', 'price_spread', 'order_book', 'orderbook_depth', 'book_depth', 'depth',
    'last_trade_price', 'last_price', 'outcomePrices', 'volume_24h', 'liquidity', 'open_interest', 'venue_gap_pts', 'consensus_prob', 'token_id', 'clobTokenIds', 'condition_id',
    'gamma_market', 'clob_book', 'market_probability', 'implied_probability'];
  for (const k of keys) {
    assert.throws(() => assertMarketFree({ features: { nested: [{ [k]: 1 }] } }), MarketLeakageError, k);
    assert.throws(() => buildFeatureVector([{ name: k, value: 1, source: official }]), MarketLeakageError, k);
  }
});

test('denylist keeps every live domain feature (NBM ensemble spread, Fed target midpoint) allowed', () => {
  const names = ['mos_pop_union', 'mos_pop_max', 'mos_pop_periods', 'mos_window_alignment_offset_h', 'nbm_pop_union', 'nbm_pop_max', 'nbm_pop_periods', 'climatology_rate_1991_2020',
    'run_lead_hours', 'mos_max_temp_guidance_f', 'nbm_max_temp_guidance_f', 'nbm_max_temp_spread_f', 'guidance_error_table', 'cmt6m_change_since_last_decision', 'cmt6m_minus_target_mid',
    'previous_decision_direction', 'horizon_days', 'tenor_years', 'last_published_yield', 'last_published_date', 'period_running_extreme', 'remaining_business_days', 'ewma_daily_sigma'];
  for (const n of names) assert.equal(MARKET_KEY_PATTERN.test(n), false, n);
});

test('source guard: a feature read from a venue or the markets service is refused', () => {
  for (const source of [
    { sourceClass: 'venue', provider: 'Kalshi' },
    { sourceClass: 'official', provider: 'Kalshi trade API' },
    { sourceClass: 'research', provider: 'x', sourceId: 'polymarket:clob:tok-1' },
    { sourceClass: 'official', provider: 'x', sourceId: 'https://gamma-api.polymarket.com/markets' },
    { sourceClass: 'official', provider: 'propsports-markets /admin/kalshi' },
    { sourceClass: 'official', provider: 'x', observationKey: 'market_venue_observations:1' },
  ]) assert.throws(() => buildFeatureVector([{ name: 'pop', value: 0.4, source }]), MarketLeakageError, JSON.stringify(source));
  assert.doesNotThrow(() => assertModelSource({ provider: 'NWS National Blend of Models (NBS) via IEM', sourceId: 'mos:NBS:KNYC:2026-10-03T12:00:00.000Z' }));
  assert.throws(() => assertModelSourceTable('market_venue_observations?select=*'), MarketLeakageError);
  assert.throws(() => assertModelSourceTable('pred_venue_snapshots?select=*'), MarketLeakageError);
  assert.doesNotThrow(() => assertModelSourceTable('pred_source_observations?select=*'));
});

test('contract boundary: every captured contract is terms only; a priced contract never reaches a model', async () => {
  for (const f of Object.values(KALSHI)) {
    for (const m of f.markets) {
      const c = await normalizeContract({ series: f.series, event: f.event, market: m }, { now: NOW });
      assert.doesNotThrow(() => assertContractTermsOnly(c), m.ticker);
      for (const leak of [{ yes_bid_dollars: '0.40' }, { detail: { ...c.detail, polymarket_midpoint: 0.4 } }, { market_probability: 0.4 }, { last_price_dollars: '0.4' }]) {
        assert.throws(() => assertContractTermsOnly({ ...c, ...leak }), MarketLeakageError, `${m.ticker} ${Object.keys(leak)}`);
      }
    }
  }
  assert.throws(() => assertModelInput({ pop_union: 0.4, kalshi_mid: 0.3 }), MarketLeakageError);
});

test('static: no model engine imports the markets layer or names a venue', () => {
  for (const f of ['src/weather/engine.js', 'src/weather/precip-model.js', 'src/weather/temp-model.js', 'src/weather/mos.js', 'src/macro/engine.js', 'src/macro/fed-model.js', 'src/rates/engine.js', 'src/rates/rates-model.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/from '[^']*(vendor\/propsports-markets|kalshi|polymarket|markets)[^']*'/i.test(src), `${f} imports a markets module`);
    assert.ok(!/polymarket|clob|gamma-api|yes_bid|yes_ask|last_price|order_?book/i.test(src), `${f} names a venue field`);
  }
});

test('GOLDEN: outputs after the guard are byte-identical to main before the guard (164 forecasts, all six model tiers)', async () => {
  for (const [lane, nbm] of [['with_nbm', true], ['without_nbm', false]]) {
    const now = modelSnapshot(await runAllLanes({ nbm }));
    assert.equal(now.length, golden.lanes[lane].length, lane);
    assert.equal(JSON.stringify(now), JSON.stringify(golden.lanes[lane]), lane);
  }
  const models = new Set([...golden.lanes.with_nbm, ...golden.lanes.without_nbm].map((f) => f.model));
  assert.deepEqual([...models].sort(), ['pbe-fed-decision@1.0.0', 'pbe-rates-path@1.0.0', 'pbe-weather-maxtemp@1.0.0', 'pbe-weather-maxtemp@1.1.0', 'pbe-weather-precip@1.0.0', 'pbe-weather-precip@1.1.0']);
});

// seeded PRNG so "random" is reproducible
function mulberry32(seed) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dollars = (x) => x.toFixed(4);
const sizeOrPrice = (k, priceFn, sizeFn) => (/volume|open_interest|liquidity/i.test(k) ? sizeFn() : priceFn());

test('INVARIANT: absurd Kalshi AND Polymarket prices (all 0c, all 99c, seeded random) change no PBE feature or forecast', async () => {
  for (const nbm of [true, false]) {
    const base = await runAllLanes({ nbm });
    assert.equal(base.summary.errors.length, 0);
    const baseFeatures = JSON.stringify(base.writes.features);
    const baseForecasts = JSON.stringify(modelSnapshot(base));
    const rnd = mulberry32(20261003);
    const scenarios = {
      all_0c: { price: (v, k) => sizeOrPrice(k, () => dollars(0), () => '0.00'), polymarket: polymarketVenue(0) },
      all_99c: { price: (v, k) => sizeOrPrice(k, () => dollars(0.99), () => '99999999.00'), polymarket: polymarketVenue(0.99) },
      random: { price: (v, k) => sizeOrPrice(k, () => dollars(rnd()), () => (rnd() * 1e7).toFixed(2)), polymarket: polymarketVenue(0.37) },
    };
    const marketSides = [JSON.stringify(base.writes.forecasts.map((f) => f.market_probability))];
    for (const [name, s] of Object.entries(scenarios)) {
      const r = await runAllLanes({ nbm, ...s });
      assert.equal(r.summary.errors.length, 0, `${name}: ${JSON.stringify(r.summary.errors)}`);
      assert.equal(JSON.stringify(r.writes.features), baseFeatures, `${name} (nbm=${nbm}): feature vectors byte-identical`);
      assert.equal(JSON.stringify(modelSnapshot(r)), baseForecasts, `${name} (nbm=${nbm}): forecasts byte-identical`);
      assert.deepEqual(r.fetchUrls, base.fetchUrls, `${name}: identical model input reads`);
      assert.ok(!r.fetchUrls.some((u) => /polymarket|clob|gamma-api|kalshi/i.test(u)), `${name}: no model input read touches a venue`);
      assert.equal(r.markets.polymarketRequests, 0, `${name}: the Polymarket service was never read`);
      for (const fs of r.writes.features) assertMarketFree(fs.features);
      marketSides.push(JSON.stringify(r.writes.forecasts.map((f) => f.market_probability)));
    }
    assert.equal(new Set(marketSides).size, marketSides.length, 'the benchmark (market side) did move in every scenario');
  }
});
