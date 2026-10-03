// End-to-end cycle (dry run) on real captured payloads, with the market service and upstreams faked.
// Proves: the market never reaches the model (invariance), market and PBE values are stored separately,
// unsupported/ambiguous contracts fail closed, and designations/scoring follow fixed rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCycle, lifecycleFor } from '../workers/pbe-predictions/src/cycle.js';
import { dueDesignations, scoreRows } from '../src/engine/designations.js';
import { buildFeatureVector, assertMarketFree, MarketLeakageError } from '../src/engine/leakage.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const NOW = '2026-10-03T18:30:00.000Z';
const env = { WEATHER_SERIES: 'KXRAIN,KXHIGHNY' };
const fixtures = { KXRAIN: read('./fixtures/kalshi/KXRAIN-26OCT04.json'), KXHIGHNY: read('./fixtures/kalshi/KXHIGHNY-26OCT04.json') };

function fakeMarkets(priceShift = 0) {
  const shift = (d) => (d == null ? d : Math.min(1, Math.max(0, Number(d) + priceShift)).toFixed(4));
  return {
    requests: 0,
    async series(t) { this.requests += 1; return fixtures[t].series; },
    async openEvents(t) {
      this.requests += 1;
      const f = fixtures[t];
      return { events: [{ ...f.event, markets: f.markets.map((m) => ({ ...m, yes_bid_dollars: shift(m.yes_bid_dollars), yes_ask_dollars: shift(m.yes_ask_dollars), last_price_dollars: shift(m.last_price_dollars), volume_fp: String(Number(m.volume_fp) * (1 + priceShift * 10)) })) }] };
    },
    async marketsByTicker() { return []; },
  };
}

function fakeFetch(url) {
  const u = String(url);
  const ok = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  let m = /mos\.json\?station=([A-Z]{4})/.exec(u);
  if (m) { try { return ok(read(`./fixtures/weather/mos-${m[1]}.json`)); } catch { return Promise.resolve(new Response('{}', { status: 404 })); } }
  if (/api\.weather\.gov\/points\//.test(u)) return ok({ properties: { gridId: 'MFL', gridX: 105, gridY: 51, forecastGridData: 'https://api.weather.gov/gridpoints/MFL/105,51' } });
  if (/gridpoints\/MFL/.test(u)) return ok(read('./fixtures/weather/grid-MFL-105-51.json'));
  return Promise.resolve(new Response('{}', { status: 404 }));
}

const run = (priceShift) => runCycle(env, { markets: fakeMarkets(priceShift), fetchImpl: fakeFetch, now: NOW, dryRun: true });

test('cycle normalizes, observes the market and forecasts from domain data only', async () => {
  const { summary, writes } = await run(0);
  assert.equal(summary.events, 2);
  assert.equal(summary.contracts.NORMALIZED, 10); // 4 rain cities + 6 NYC buckets
  assert.equal(writes.venue.length, 10);
  assert.ok(writes.forecasts.length >= 8, `forecasts ${writes.forecasts.length}`);
  for (const f of writes.forecasts) {
    assert.ok(f.probability >= 0.01 && f.probability <= 0.99);
    assert.notEqual(f.probability, f.market_probability);
    assert.ok(Date.parse(f.market_observed_at) <= Date.parse(f.captured_at));
    assert.ok(Date.parse(f.data_cutoff_at) <= Date.parse(f.captured_at));
    assert.equal(f.model_state, 'RESEARCH');
  }
  for (const fs of writes.features) assertMarketFree(fs.features);
  const mia = writes.forecasts.find((f) => f.market_id === 'KXRAIN-26OCT04-MIA');
  assert.equal(mia.metadata.station_id, 'CLIMIA');
  assert.equal(mia.market_probability, 0.165); // mid of 16c/17c from the captured book
});

test('INVARIANCE: moving every Kalshi price/volume leaves PBE features and probabilities identical', async () => {
  const a = await run(0);
  const b = await run(0.2);
  const key = (w) => Object.fromEntries(w.forecasts.map((f) => [f.contract_id, [f.probability, f.features_sha256]]));
  assert.deepEqual(key(a.writes), key(b.writes));
  const ma = a.writes.forecasts.map((f) => f.market_probability);
  const mb = b.writes.forecasts.map((f) => f.market_probability);
  assert.notDeepEqual(ma, mb); // the benchmark did move
});

test('leakage guard refuses venue-class sources and nested market keys', () => {
  assert.throws(() => buildFeatureVector([{ name: 'mid', value: 0.4, source: { sourceClass: 'venue', provider: 'Kalshi' } }]), MarketLeakageError);
  assert.throws(() => buildFeatureVector([{ name: 'kalshi_mid', value: 0.4, source: { sourceClass: 'official', provider: 'x' } }]), MarketLeakageError);
  assert.throws(() => assertMarketFree({ inputs: [{ ctx: { order_book: [] } }] }), MarketLeakageError);
  assert.throws(() => assertMarketFree({ prior: { implied_probability: 0.3 } }), MarketLeakageError);
  assert.doesNotThrow(() => assertMarketFree({ mos_pop_union: 0.4, climatology_rate_1991_2020: 0.3 }));
});

test('fail closed: a corrupted market (strike disagrees with rules) gets no forecast', async () => {
  const markets = fakeMarkets(0);
  const orig = markets.openEvents.bind(markets);
  markets.openEvents = async (t) => { const r = await orig(t); if (t === 'KXHIGHNY') r.events[0].markets[1].floor_strike = 50; return r; };
  const { summary, writes } = await runCycle(env, { markets, fetchImpl: fakeFetch, now: NOW, dryRun: true });
  assert.equal(summary.contracts.HOLD_RESOLUTION_AMBIGUOUS, 1);
  const held = writes.contracts.find((c) => c.normalization_status === 'HOLD_RESOLUTION_AMBIGUOUS');
  assert.ok(!writes.forecasts.some((f) => f.contract_id === held.contract_id));
});

test('lifecycle uses the canonical market-history rule (window start = event start)', () => {
  const start = '2026-10-04T05:00:00.000Z';
  assert.equal(lifecycleFor(['open'], start, Date.parse(NOW)), 'UPCOMING');
  assert.equal(lifecycleFor(['open'], start, Date.parse('2026-10-04T06:00:00Z')), 'ACTIVE');
  assert.equal(lifecycleFor(['closed'], start, Date.parse('2026-10-05T06:00:00Z')), 'CLOSED');
  assert.equal(lifecycleFor(['settled'], start, Date.parse('2026-10-05T20:00:00Z')), 'SETTLED');
});

test('designations are fixed by rule and scoring compares PBE and market on the same snapshot', () => {
  const contract = { observation_start: '2026-10-04T05:00:00.000Z' };
  const forecasts = [
    { forecast_id: 'a', captured_at: '2026-10-02T18:00:00.000Z', probability: 0.3, market_probability: 0.2, contract_id: 'c' },
    { forecast_id: 'b', captured_at: '2026-10-03T03:00:00.000Z', probability: 0.4, market_probability: 0.25, contract_id: 'c' },
    { forecast_id: 'c', captured_at: '2026-10-04T00:00:00.000Z', probability: 0.6, market_probability: 0.3, contract_id: 'c' },
  ];
  const before = dueDesignations({ contract, forecasts, existing: [], now: '2026-10-03T04:00:00.000Z' });
  assert.deepEqual(before.map((d) => d.designation), ['FIRST_PUBLISHED']);
  const after = dueDesignations({ contract, forecasts, existing: [{ designation: 'FIRST_PUBLISHED' }], now: '2026-10-04T05:00:00.000Z' });
  assert.deepEqual(after.map((d) => [d.designation, d.forecast.forecast_id]), [['T_MINUS_24H', 'b'], ['FINAL_PRE_RESOLUTION', 'c']]);
  const rows = scoreRows({ designation: 'FINAL_PRE_RESOLUTION', forecast: forecasts[2], resolution: { resolution_id: 'r' }, outcome: 1 });
  const brier = rows.find((r) => r.scoring_method === 'brier');
  assert.equal(+brier.score.toFixed(4), 0.16);
  assert.equal(+brier.benchmark_score.toFixed(4), 0.49);
  assert.ok(brier.improvement > 0);
});

test('rates lane through the real cycle path (Treasury CSV via fetch) produces forecasts, not INCOMPLETE_INPUTS', async () => {
  const hi = read('./fixtures/kalshi/KX10YRDIRHM-26OCT30H.json');
  const tre = (y) => readFileSync(new URL(`./fixtures/treasury/treasury-par-${y}.csv`, import.meta.url), 'utf8');
  const markets = { requests: 0, async series() { return hi.series; }, async openEvents() { return { events: [{ ...hi.event, markets: hi.markets }] }; }, async marketsByTicker() { return []; } };
  const fetchImpl = (url) => {
    const m = /daily-treasury-rates\.csv\/(\d{4})/.exec(String(url));
    return Promise.resolve(m ? new Response(tre(m[1]), { status: 200, headers: { 'content-type': 'text/csv' } }) : new Response('{}', { status: 404 }));
  };
  const { summary, writes } = await runCycle({ RATES_SERIES: 'KX10YRDIRHM' }, { markets, fetchImpl, now: '2026-10-03T19:30:00.000Z', dryRun: true });
  assert.ok(!summary.forecast_skips.INCOMPLETE_INPUTS, JSON.stringify(summary.forecast_skips));
  assert.ok(writes.forecasts.length >= 10);
  assert.ok(writes.forecasts.every((f) => f.model_id === 'pbe-rates-path' && f.model_state === 'RESEARCH'));
});
