// Weather engine on real captured inputs (Kalshi contract + NWS GFS MOS + NWS gridpoint, 2026-10-03).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContract } from '../src/engine/contracts.js';
import { forecastWeather, climatologyFor, gradeQuality } from '../src/weather/engine.js';
import { normalizeMosRow, windowPrecipFeatures, latestRunAtOrBefore, runAvailableAt } from '../src/weather/mos.js';
import { gridWindowEvidence } from '../src/weather/nws.js';
import { residualTable, bucketProbability, integerRange } from '../src/weather/temp-model.js';
import { officialOutcome, cliDay, parseCliNumber } from '../src/weather/cli.js';
import tempArtifact from '../src/weather/artifacts/temp-v1.json' with { type: 'json' };
import precipArtifact from '../src/weather/artifacts/precip-v1.json' with { type: 'json' };

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const mos = (icao) => { const j = read(`./fixtures/weather/mos-${icao}.json`); const rows = j.data.map(normalizeMosRow); return { icao, runtime: rows[0].runtime, url: `iem:${icao}`, observationKey: `k:${icao}`, rows }; };
const grid = { url: 'https://api.weather.gov/gridpoints/MFL/105,51', body: read('./fixtures/weather/grid-MFL-105-51.json') };
const rain = read('./fixtures/kalshi/KXRAIN-26OCT04.json');
const nyHigh = read('./fixtures/kalshi/KXHIGHNY-26OCT04.json');
const NOW = '2026-10-03T18:30:00.000Z'; // 12Z MOS published (>= 17Z), before the Oct 4 windows open
const contract = (f, suffix) => normalizeContract({ series: f.series, event: f.event, market: f.markets.find((m) => m.ticker.endsWith(suffix)) }, { now: NOW });

test('Miami rain forecast: bounded, whole-percent, market-free, evidence and provenance present', async () => {
  const c = await contract(rain, '-MIA');
  const f = forecastWeather(c, { mos: mos('KMIA'), grid }, { now: NOW });
  assert.equal(f.status, 'OK');
  assert.ok(f.probability >= 0.02 && f.probability <= 0.98);
  assert.equal(Math.round(f.probability * 100), f.probability * 100); // no fake precision
  assert.deepEqual(Object.keys(f.features).sort(), ['climatology_rate_1991_2020', 'mos_pop_max', 'mos_pop_periods', 'mos_pop_union', 'mos_window_alignment_offset_h', 'run_lead_hours']);
  assert.equal(JSON.stringify(f.features).match(/kalshi|market|bid|ask|volume|price/i), null);
  assert.ok(f.evidence.some((e) => /Historical seasonal rate/.test(e.label)));
  assert.ok(f.evidence.some((e) => /NWS guidance/.test(e.label)));
  assert.ok(f.evidence.some((e) => /Official NWS forecast/.test(e.label)));
  assert.ok(f.provenance.some((p) => /GFS MOS/.test(p.source) && p.station === 'KMIA'));
  assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(f.confidence));
  assert.ok(Date.parse(f.dataCutoffAt) <= Date.parse(NOW));
});

test('wrong-station guidance is refused: O Hare (KORD) MOS cannot model a Miami or Midway contract', async () => {
  const mia = await contract(rain, '-MIA');
  assert.equal(forecastWeather(mia, { mos: mos('KORD'), grid: null }, { now: NOW }).status, 'STATION_MISMATCH');
  const chiHigh = read('./fixtures/kalshi/KXHIGHCHI-26OCT04.json');
  const mdw = await normalizeContract({ series: chiHigh.series, event: chiHigh.event, market: chiHigh.markets[0] }, { now: NOW });
  assert.equal(forecastWeather(mdw, { mos: mos('KORD'), grid: null }, { now: NOW }).status, 'STATION_MISMATCH');
  assert.equal(forecastWeather(mdw, { mos: mos('KMDW'), grid: null }, { now: NOW }).status, 'OK');
  assert.equal(forecastWeather({ ...mia, station_id: 'CLIXYZ' }, { mos: mos('KMIA'), grid: null }, { now: NOW }).status, 'STATION_MISMATCH');
});

test('no forecast once the climate-day window has started (v1 publishes pre-window only)', async () => {
  const c = await contract(rain, '-MIA');
  assert.equal(forecastWeather(c, { mos: mos('KMIA'), grid }, { now: '2026-10-04T05:00:00.000Z' }).status, 'WINDOW_STARTED');
});

test('guidance not yet published at the cutoff is never used', async () => {
  const c = await contract(rain, '-MIA');
  assert.equal(forecastWeather(c, { mos: mos('KMIA'), grid }, { now: '2026-10-03T16:00:00.000Z' }).status, 'NO_PUBLISHED_GUIDANCE');
  assert.equal(runAvailableAt('2026-10-03T12:00:00.000Z'), '2026-10-03T17:00:00.000Z');
  assert.equal(latestRunAtOrBefore(['2026-10-03T06:00:00.000Z', '2026-10-03T12:00:00.000Z'], '2026-10-03T16:59:00.000Z'), '2026-10-03T06:00:00.000Z');
});

test('MOS window selection: four 6-h periods covering the EST climate day', async () => {
  const c = await contract(rain, '-NYC');
  const f = windowPrecipFeatures(mos('KNYC').rows, { start: c.observation_start, end: c.observation_end });
  assert.equal(f.periods.length, 4);
  assert.equal(f.periods[0].end, '2026-10-04T12:00:00.000Z');
  assert.equal(f.periods[3].end, '2026-10-05T06:00:00.000Z');
  assert.equal(f.alignment_offset_h, 1);
  assert.ok(f.pop_union >= f.pop_max);
});

test('KXHIGHNY buckets: Central Park guidance, probabilities over the 6 buckets ~ 1', async () => {
  let total = 0;
  for (const m of nyHigh.markets) {
    const c = await normalizeContract({ series: nyHigh.series, event: nyHigh.event, market: m }, { now: NOW });
    const f = forecastWeather(c, { mos: mos('KNYC'), grid: null }, { now: NOW });
    assert.equal(f.status, 'OK');
    assert.equal(c.location.icao, 'KNYC');
    total += f.rawProbability;
  }
  assert.ok(total > 0.95 && total < 1.08, `bucket sum ${total}`);
});

test('temperature integer semantics', () => {
  assert.deepEqual(integerRange({ comparator: 'less', high: 63 }), [-Infinity, 62]);
  assert.deepEqual(integerRange({ comparator: 'greater', low: 70 }), [71, Infinity]);
  assert.deepEqual(integerRange({ comparator: 'between', low: 63, high: 64 }), [63, 64]);
  const t = residualTable(tempArtifact, 'CLINYC', 20);
  const pIn = bucketProbability(tempArtifact, t, 66, { comparator: 'between', low: 65, high: 67 });
  const pFar = bucketProbability(tempArtifact, t, 66, { comparator: 'greater', low: 80 });
  assert.ok(pIn > pFar);
  assert.equal(pFar, 0.01);
});

test('official outcomes follow the contract (trace = NO, missing = NO, integer buckets)', async () => {
  const c = await contract(rain, '-NYC');
  const rows = [{ valid: '2026-10-04', station: 'KNYC', product: 'P', high: 66, low: 55, precip: 'T' }];
  assert.equal(officialOutcome(c, cliDay(rows, '2026-10-04')).outcome, 'NO');
  rows[0].precip = 0.01; assert.equal(officialOutcome(c, cliDay(rows, '2026-10-04')).outcome, 'YES');
  rows[0].precip = 'M'; assert.equal(officialOutcome(c, cliDay(rows, '2026-10-04')).outcome, 'NO');
  const b = await contract(nyHigh, '-B63.5');
  rows[0].high = 64; assert.equal(officialOutcome(b, cliDay(rows, '2026-10-04')).outcome, 'YES');
  rows[0].high = 65; assert.equal(officialOutcome(b, cliDay(rows, '2026-10-04')).outcome, 'NO');
  assert.equal(parseCliNumber('T').kind, 'trace');
});

test('gridpoint evidence and climatology lookups', async () => {
  const c = await contract(rain, '-MIA');
  const g = gridWindowEvidence(grid.body, { start: c.observation_start, end: c.observation_end });
  assert.ok(g.pop_max_pct >= 0 && g.pop_max_pct <= 100);
  assert.ok(g.max_temp_f > 70 && g.max_temp_f < 100);
  const clim = climatologyFor('CLIMIA', '2026-10-04');
  assert.ok(clim.precip_rate_1991_2020 > 0.2 && clim.precip_rate_1991_2020 < 0.8);
  assert.equal(gradeQuality({ complete: false }), 'LOW');
});

test('artifacts carry holdout evidence that the model beats raw guidance and climatology', () => {
  const o = precipArtifact.holdout.overall;
  assert.ok(o.p_model.brier < o.p_union.brier && o.p_model.brier < o.p_clim.brier);
  assert.equal(tempArtifact.holdout.selected, 'empirical');
  assert.ok(tempArtifact.holdout.methods.empirical.log_loss_exact_integer < tempArtifact.holdout.methods.normal_bias.log_loss_exact_integer);
});
