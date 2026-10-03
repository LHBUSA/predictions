// Rates lane on REAL inputs: Kalshi KX10YRDIR{H,L}M-26OCT30 contracts + official Treasury par curve CSVs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContract } from '../src/engine/contracts.js';
import { forecastRates, parseTreasuryCsv, businessDaysAfter, ratesOfficialOutcome } from '../src/rates/engine.js';
import { simulateExtremes, crossProbability } from '../src/rates/rates-model.js';
import { dueDesignations } from '../src/engine/designations.js';
import { EngineStore } from '../src/engine/store.js';
import ratesArtifact from '../src/rates/artifacts/rates-path-v1.json' with { type: 'json' };

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const hi = JSON.parse(read('./fixtures/kalshi/KX10YRDIRHM-26OCT30H.json'));
const lo = JSON.parse(read('./fixtures/kalshi/KX10YRDIRLM-26OCT30L.json'));
const rows = [...parseTreasuryCsv(read('./fixtures/treasury/treasury-par-2025.csv')), ...parseTreasuryCsv(read('./fixtures/treasury/treasury-par-2026.csv'))].sort((a, b) => a.date.localeCompare(b.date));
const NOW = '2026-10-03T19:30:00.000Z';
const norm = (f, m) => normalizeContract({ series: f.series, event: f.event, market: m }, { now: NOW });

test('treasury CSV parses the official tenors; 10Y Oct 1-2 2026 = 5.24 / 5.28', () => {
  const r1 = rows.find((r) => r.date === '2026-10-01'); const r2 = rows.find((r) => r.date === '2026-10-02');
  assert.equal(r1[10], 5.24); assert.equal(r2[10], 5.28); assert.equal(r2[30], 5.63);
  assert.equal(businessDaysAfter('2026-10-02', '2026-10-30'), 19); // Oct 12 (Columbus Day) excluded
});

test('every Oct 10Y high/low contract normalizes to an exact any-business-day path rule', async () => {
  for (const m of [...hi.markets, ...lo.markets]) {
    const c = await norm(m.ticker.includes('DIRH') ? hi : lo, m);
    assert.equal(c.normalization_status, 'NORMALIZED', m.ticker);
    assert.equal(c.category, 'RATES');
    assert.equal(c.detail.period_start, '2026-10-01');
    assert.equal(c.detail.period_end, '2026-10-30');
    assert.equal(c.detail.scoring_reference, m.close_time);
    assert.match(c.resolution_authority, /Treasury/);
  }
});

test('fail closed: strike mismatch, direction mismatch, intraday clause removed', async () => {
  const m = hi.markets[0];
  assert.equal((await norm(hi, { ...m, floor_strike: 5.1 })).status_reason, 'STRIKE_FIELDS_DISAGREE_WITH_RULES');
  assert.equal((await norm(hi, { ...m, rules_primary: m.rules_primary.replace('above', 'below') })).status_reason, 'SERIES_DIRECTION_DISAGREES_WITH_RULES');
  assert.equal((await norm(hi, { ...m, rules_secondary: 'Resolves on Treasury data.' })).status_reason, 'RATES_SECONDARY_RULES_CHANGED');
});

test('path already decided -> no forecast (10Y printed 5.24 on Oct 1, so "below 5.29" is decided)', async () => {
  const m = lo.markets.find((x) => x.ticker.endsWith('-T5.29'));
  const c = await norm(lo, m);
  assert.equal(forecastRates(c, { treasury: { rows } }, { now: NOW }).status, 'DETERMINED_BY_PATH');
  assert.deepEqual(ratesOfficialOutcome(c, rows).outcome, 'YES');
});

test('open contracts get bounded, monotone, market-free probabilities', async () => {
  const highs = [];
  for (const m of hi.markets) {
    const c = await norm(hi, m);
    const f = forecastRates(c, { treasury: { rows, urls: ['x'] } }, { now: NOW });
    if (f.status !== 'OK') continue;
    assert.ok(f.probability >= 0.01 && f.probability <= 0.99);
    assert.equal(JSON.stringify(f.features).match(/kalshi|market|bid|ask|volume/i), null);
    assert.equal(f.features.last_published_date, '2026-10-02');
    highs.push([c.threshold_low, f.rawProbability]);
  }
  assert.ok(highs.length >= 10);
  highs.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < highs.length; i += 1) assert.ok(highs[i][1] <= highs[i - 1][1] + 1e-12, 'higher threshold cannot be more likely');
});

test('simulation is deterministic and respects publication rounding', () => {
  const a = simulateExtremes({ y0: 5.28, sigma: 0.05, steps: 5, paths: 500, seed: 7 });
  const b = simulateExtremes({ y0: 5.28, sigma: 0.05, steps: 5, paths: 500, seed: 7 });
  assert.deepEqual([...a.maxs], [...b.maxs]);
  assert.ok([...a.maxs].every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9));
  assert.ok(crossProbability(a, { direction: 'high', level: 9 }) < 0.01);
  assert.equal(ratesArtifact.holdout_2018_2026.candidate.n, ratesArtifact.holdout_2018_2026.baseline.n);
  assert.ok(ratesArtifact.holdout_2018_2026.candidate.log_loss < ratesArtifact.holdout_2018_2026.baseline.log_loss);
});

test('early venue settlement fixes FINAL at the settlement; nothing after it is designated', () => {
  const contract = { observation_start: '2026-10-01T13:00:00.000Z', detail: { scoring_reference: '2026-10-30T19:30:00Z' } };
  const forecasts = [
    { forecast_id: 'a', captured_at: '2026-10-03T19:00:00.000Z' },
    { forecast_id: 'b', captured_at: '2026-10-07T19:00:00.000Z' },
    { forecast_id: 'c', captured_at: '2026-10-09T19:00:00.000Z' },
  ];
  const d = dueDesignations({ contract, forecasts, existing: [], now: '2026-10-09T22:00:00.000Z', resolvedAt: '2026-10-08T21:00:00.000Z' });
  assert.deepEqual(d.map((x) => [x.designation, x.forecast.forecast_id]), [['FIRST_PUBLISHED', 'a'], ['T_MINUS_24H', 'b'], ['FINAL_PRE_RESOLUTION', 'b']]);
});

test('store pages past the PostgREST 1000-row cap', async () => {
  const total = 2345;
  const fetchImpl = async (url) => {
    const u = new URL(url); const off = Number(u.searchParams.get('offset')); const lim = Math.min(1000, Number(u.searchParams.get('limit')));
    const n = Math.max(0, Math.min(lim, total - off));
    return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: off + i }))), { status: 200 });
  };
  const store = new EngineStore({ url: 'https://x.supabase.co', serviceKey: 'k', fetchImpl });
  const all = await store.select('pred_forecasts', { select: 'id' });
  assert.equal(all.length, total);
  assert.equal(new Set(all.map((r) => r.id)).size, total);
  assert.equal((await store.select('pred_forecasts', { select: 'id' }, { limit: 1500 })).length, 1500);
});
