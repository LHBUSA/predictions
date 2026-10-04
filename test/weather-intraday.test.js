// Weather intraday v2 (window-started) engine: point-in-time, calibrated bounds, input hash, leakage, v1 untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContract } from '../src/engine/contracts.js';
import { MARKET_KEY_PATTERN, MarketLeakageError } from '../src/engine/leakage.js';
import { normalizeMosRow } from '../src/weather/mos.js';
import { forecastWeather, WEATHER_MODELS } from '../src/weather/engine.js';
import { forecastIntraday, INTRADAY_MODELS, PointInTimeError, publishableIntraday } from '../src/weather/intraday/engine.js';
import { parseIemAsosCsv, parseNwsObservations } from '../src/weather/intraday/observations.js';
import { remainingPop, OBS_PUBLICATION_LAG_MIN } from '../src/weather/intraday/features.js';
import { tempFinalDistribution, rangeProbability } from '../src/weather/intraday/models.js';
import { sha256Hex } from '../src/weather/intraday/sha256.js';
import tempArt from '../src/weather/artifacts/temp-intraday-v2.0.json' with { type: 'json' };
import precipArt from '../src/weather/artifacts/precip-intraday-v2.0.json' with { type: 'json' };

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const NOW0 = '2026-10-03T18:30:00.000Z';
const nyHigh = read('./fixtures/kalshi/KXHIGHNY-26OCT04.json');
const rainFx = read('./fixtures/kalshi/KXRAIN-26OCT04.json');
const contract = (f, suffix) => normalizeContract({ series: f.series, event: f.event, market: f.markets.find((m) => m.ticker.endsWith(suffix)) }, { now: NOW0 });
const fixtureRun = (prefix, icao) => { const rows = read(`./fixtures/weather/${prefix}-${icao}.json`).data.map(normalizeMosRow); return { icao, runtime: rows[0].runtime, url: `iem:${prefix}:${icao}`, observationKey: `k:${icao}`, rows }; };
// synthetic NBM run issued 13Z on the climate day (usable 18Z): day max, 6-h PoPs
const nbmRun = (icao, pops = [0.1, 0.4, 0.3], txn = 66) => ({
  icao, runtime: '2026-10-04T13:00:00.000Z', url: 'synthetic', observationKey: 'syn',
  rows: [
    { runtime: '2026-10-04T13:00:00.000Z', ftime: '2026-10-04T18:00:00.000Z', txn: null, xnd: null, p06: pops[0] * 100, n_x: null },
    { runtime: '2026-10-04T13:00:00.000Z', ftime: '2026-10-05T00:00:00.000Z', txn, xnd: 2, p06: pops[1] * 100, n_x: null },
    { runtime: '2026-10-04T13:00:00.000Z', ftime: '2026-10-05T06:00:00.000Z', txn: null, xnd: null, p06: pops[2] * 100, n_x: null },
  ],
});
// hourly reports at :51 from the NYC window start (05:00Z = 00 LST); temp(k), p01(k) by report index
const obsSeries = (icao, n, temp, p01 = () => 0) => Array.from({ length: n }, (_, k) => {
  const v = Date.parse('2026-10-04T05:51:00.000Z') + k * 3600000;
  return { station: icao, valid_at: new Date(v).toISOString(), available_at: new Date(v + OBS_PUBLICATION_LAG_MIN * 60000).toISOString(), tmpf: temp(k), p01i: p01(k), trace: false };
});
const AFTERNOON = '2026-10-04T20:05:00.000Z'; // 15:05 LST; reports through 19:51Z usable

test('lifecycle: before window -> WINDOW_NOT_STARTED, after -> WINDOW_CLOSED; v1 still refuses in-window', async () => {
  const c = await contract(nyHigh, '-B67.5');
  const src = { obs: obsSeries('KNYC', 3, () => 60), nbm: nbmRun('KNYC') };
  assert.equal(forecastIntraday(c, src, { now: '2026-10-04T04:59:00.000Z' }).status, 'WINDOW_NOT_STARTED');
  assert.equal(forecastIntraday(c, src, { now: '2026-10-05T05:00:00.000Z' }).status, 'WINDOW_CLOSED');
  assert.equal(forecastWeather(c, { mos: fixtureRun('mos', 'KNYC'), grid: null }, { now: AFTERNOON }).status, 'WINDOW_STARTED');
});

test('real fixture runs, early morning: OK, market-free features, dataCutoffAt = max input availability <= now', async () => {
  const c = await contract(nyHigh, '-B63.5');
  const now = '2026-10-04T11:00:00.000Z';
  const obs = obsSeries('KNYC', 5, (k) => 55 - k * 0.5);
  const f = forecastIntraday(c, { obs, nbm: fixtureRun('nbs', 'KNYC'), mos: fixtureRun('mos', 'KNYC') }, { now });
  assert.equal(f.status, 'OK');
  assert.deepEqual(f.model, INTRADAY_MODELS.MAX_TEMP_BUCKET);
  assert.equal(f.model.id, 'pbe-weather-maxtemp-intraday');
  assert.equal(f.model.version, '2.0.0');
  for (const k of Object.keys(f.features)) assert.equal(MARKET_KEY_PATTERN.test(k), false, k);
  assert.ok(Date.parse(f.dataCutoffAt) <= Date.parse(now));
  const usedAvail = Math.max(...obs.filter((o) => Date.parse(o.available_at) <= Date.parse(now)).map((o) => Date.parse(o.available_at)));
  assert.equal(f.dataCutoffAt, new Date(Math.max(usedAvail, Date.parse('2026-10-03T17:00:00.000Z'))).toISOString());
  assert.equal(f.features.guidance_kind, 'nbm');
  assert.match(f.inputHash, /^[0-9a-f]{64}$/);
});

test('point-in-time: future / pre-window / late-published observations are never used; strict mode refuses them', async () => {
  const c = await contract(nyHigh, '-B67.5');
  const base = obsSeries('KNYC', 15, (k) => 58 + Math.min(k, 9)); // 05:51Z..19:51Z
  const nbm = nbmRun('KNYC');
  const ref = forecastIntraday(c, { obs: base, nbm }, { now: AFTERNOON });
  const future = { station: 'KNYC', valid_at: '2026-10-04T20:51:00.000Z', available_at: '2026-10-04T21:01:00.000Z', tmpf: 90, p01i: 0, trace: false };
  const publishedLate = { station: 'KNYC', valid_at: '2026-10-04T19:59:00.000Z', available_at: '2026-10-04T20:30:00.000Z', tmpf: 91, p01i: 0, trace: false };
  const before = { station: 'KNYC', valid_at: '2026-10-04T04:51:00.000Z', available_at: '2026-10-04T05:01:00.000Z', tmpf: 95, p01i: 0, trace: false };
  const f = forecastIntraday(c, { obs: [...base, future, publishedLate, before], nbm }, { now: AFTERNOON });
  assert.equal(f.rawProbability, ref.rawProbability);
  assert.equal(f.features.obs_max_so_far_f, ref.features.obs_max_so_far_f);
  assert.equal(f.inputHash, ref.inputHash);
  assert.equal(f.explanation.observations_excluded, 3);
  assert.throws(() => forecastIntraday(c, { obs: [...base, future], nbm }, { now: AFTERNOON, strict: true }), PointInTimeError);
  assert.throws(() => forecastIntraday(c, { obs: [...base, before], nbm }, { now: AFTERNOON, strict: true }), PointInTimeError);
  // guidance not yet published (13Z run usable only from 18Z) -> no guidance
  assert.equal(forecastIntraday(c, { obs: base.slice(0, 10), nbm }, { now: '2026-10-04T17:30:00.000Z' }).status, 'INCOMPLETE_GUIDANCE');
});

test('observed max inside a bucket raises that bucket; buckets below the observed max get ~0 from the calibrated table', async () => {
  const b67 = await contract(nyHigh, '-B67.5');
  const nbm = nbmRun('KNYC', undefined, 66);
  const cool = forecastIntraday(b67, { obs: obsSeries('KNYC', 15, () => 60), nbm }, { now: AFTERNOON });
  const inBucket = forecastIntraday(b67, { obs: obsSeries('KNYC', 15, (k) => (k === 13 ? 67.1 : 62)), nbm }, { now: AFTERNOON });
  assert.equal(cool.status, 'OK'); assert.equal(inBucket.status, 'OK');
  assert.ok(inBucket.rawProbability > cool.rawProbability + 0.2, `${inBucket.rawProbability} vs ${cool.rawProbability}`);
  // impossible bucket: high < 63 after 70 F was already observed
  const lt63 = await contract(nyHigh, '-T63');
  const hot = obsSeries('KNYC', 15, (k) => (k >= 12 ? 70 : 64));
  const f = forecastIntraday(lt63, { obs: hot, nbm }, { now: AFTERNOON });
  assert.equal(f.status, 'OK');
  assert.ok(f.rawProbability < 0.005, `P(<63 | max 70 observed) = ${f.rawProbability}`);
  assert.ok(f.rawProbability > 0, 'calibrated, not a hard-coded zero');
  // equals the artifact table computation (no hidden cap)
  const x = { station: 'CLINYC', h: 14, M: 70, D: 70, g: 66 };
  assert.equal(f.rawProbability, rangeProbability(tempFinalDistribution(tempArt, x), -Infinity, 62));
  assert.ok(tempArt.below_obs_max && tempArt.below_obs_max.global.n > 100000, 'disagreement sample recorded');
  assert.equal(f.probability, 0.01); // publication precision floor only
  assert.ok(f.explanation.prob_below_observed_max > 0 && f.explanation.prob_below_observed_max < 0.05);
});

test('rain: measurable ASOS rain inside the window uses the calibrated per-station bound (sample size recorded)', async () => {
  const c = await contract(rainFx, '-NYC');
  const nbm = nbmRun('KNYC', [0.1, 0.2, 0.1]);
  const wet = forecastIntraday(c, { obs: obsSeries('KNYC', 15, () => 60, (k) => (k === 8 ? 0.05 : 0)), nbm }, { now: AFTERNOON });
  assert.equal(wet.status, 'OK');
  assert.equal(wet.explanation.branch, 'measured_bound');
  const s = precipArt.measured_bound.by_station.CLINYC;
  assert.ok(s && s.n >= 100, 'station sample recorded');
  assert.equal(wet.rawProbability, s.bound);
  assert.equal(wet.explanation.bound.n, s.n);
  assert.notEqual(wet.rawProbability, 0.98);
  assert.ok(wet.rawProbability > 0.99 && wet.rawProbability < 1);
  assert.ok(wet.evidence.some((e) => /Historical agreement/.test(e.label) && e.detail.includes(`/${s.n}`)));
  // measurable only in the first report (accumulation can predate the window) -> NOT the bound
  const straddle = forecastIntraday(c, { obs: obsSeries('KNYC', 15, () => 60, (k) => (k === 0 ? 0.03 : 0)), nbm }, { now: AFTERNOON });
  assert.equal(straddle.explanation.branch, 'logistic');
  assert.equal(straddle.features.measurable_precip_first_report_only, true);
  // dry so far: logistic; higher remaining PoP -> higher probability
  const dryLow = forecastIntraday(c, { obs: obsSeries('KNYC', 15, () => 60), nbm }, { now: AFTERNOON });
  const dryHigh = forecastIntraday(c, { obs: obsSeries('KNYC', 15, () => 60), nbm: nbmRun('KNYC', [0.1, 0.8, 0.7]) }, { now: AFTERNOON });
  assert.equal(dryLow.explanation.branch, 'logistic');
  assert.ok(dryHigh.rawProbability > dryLow.rawProbability + 0.2);
  assert.ok(dryLow.rawProbability < wet.rawProbability);
});

test('inputHash: stable for identical inputs (any order), changes when a new ob arrives', async () => {
  const c = await contract(nyHigh, '-B67.5');
  const obs = obsSeries('KNYC', 14, (k) => 58 + k * 0.4);
  const nbm = nbmRun('KNYC');
  const a = forecastIntraday(c, { obs, nbm }, { now: AFTERNOON });
  const b = forecastIntraday(c, { obs: [...obs].reverse(), nbm }, { now: AFTERNOON });
  assert.equal(a.inputHash, b.inputHash);
  const more = [...obs, ...obsSeries('KNYC', 15, () => 63).slice(14)];
  const c2 = forecastIntraday(c, { obs: more, nbm }, { now: AFTERNOON });
  assert.notEqual(c2.inputHash, a.inputHash);
  const rc = await contract(rainFx, '-NYC');
  const r1 = forecastIntraday(rc, { obs, nbm }, { now: AFTERNOON });
  const r2 = forecastIntraday(rc, { obs: more, nbm }, { now: AFTERNOON });
  assert.equal(r1.inputHash, forecastIntraday(rc, { obs, nbm }, { now: AFTERNOON }).inputHash);
  assert.notEqual(r1.inputHash, r2.inputHash);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('leakage: a priced contract or a market key on an input row is refused; features pass the market-key pattern', async () => {
  const c = await contract(nyHigh, '-B67.5');
  const obs = obsSeries('KNYC', 15, () => 60);
  assert.throws(() => forecastIntraday({ ...c, yes_bid: 0.4 }, { obs, nbm: nbmRun('KNYC') }, { now: AFTERNOON }), MarketLeakageError);
  assert.throws(() => forecastIntraday(c, { obs: obs.map((o) => ({ ...o, kalshi_last_price: 0.5 })), nbm: nbmRun('KNYC') }, { now: AFTERNOON }), MarketLeakageError);
  const rc = await contract(rainFx, '-NYC');
  for (const f of [forecastIntraday(c, { obs, nbm: nbmRun('KNYC') }, { now: AFTERNOON }), forecastIntraday(rc, { obs, nbm: nbmRun('KNYC') }, { now: AFTERNOON })]) {
    assert.equal(f.status, 'OK');
    for (const k of Object.keys(f.features)) assert.equal(MARKET_KEY_PATTERN.test(k), false, k);
    assert.equal(JSON.stringify(f.features).match(/kalshi|polymarket|bid|ask|volume|price/i), null);
  }
});

test('station discipline and missing inputs', async () => {
  const c = await contract(nyHigh, '-B67.5');
  const obs = obsSeries('KNYC', 15, () => 60);
  assert.equal(forecastIntraday(c, { obs: obsSeries('KLGA', 15, () => 60), nbm: nbmRun('KNYC') }, { now: AFTERNOON }).status, 'STATION_MISMATCH');
  assert.equal(forecastIntraday(c, { obs, nbm: nbmRun('KORD') }, { now: AFTERNOON }).status, 'STATION_MISMATCH');
  assert.equal(forecastIntraday({ ...c, station_id: 'CLIXYZ' }, { obs, nbm: nbmRun('KNYC') }, { now: AFTERNOON }).status, 'STATION_MISMATCH');
  assert.equal(forecastIntraday(c, { obs: [], nbm: nbmRun('KNYC') }, { now: AFTERNOON }).status, 'NO_OBSERVATIONS');
  assert.equal(forecastIntraday(c, { obs }, { now: AFTERNOON }).status, 'INCOMPLETE_GUIDANCE');
  // GFS-MOS-only guidance is unvalidated for intraday (no training cases): fails closed unless explicitly allowed
  const early = '2026-10-04T11:00:00.000Z';
  assert.equal(forecastIntraday(c, { obs, mos: fixtureRun('mos', 'KNYC') }, { now: early }).status, 'INCOMPLETE_GUIDANCE');
  const g = forecastIntraday(c, { obs, mos: fixtureRun('mos', 'KNYC') }, { now: early, allowGfsFallback: true });
  assert.equal(g.status, 'OK'); assert.equal(g.features.guidance_kind, 'gfs');
});

test('parsers: NWS API (degC, mm) and IEM ASOS CSV (trace, missing) -> obs rows', () => {
  const body = { features: [
    { properties: { station: 'https://api.weather.gov/stations/KPHL', timestamp: '2026-10-04T13:54:00+00:00', temperature: { unitCode: 'wmoUnit:degC', value: 22.8 }, precipitationLastHour: { unitCode: 'wmoUnit:mm', value: 2.5 } } },
    { properties: { stationId: 'KPHL', timestamp: '2026-10-04T12:54:00+00:00', temperature: { unitCode: 'wmoUnit:degC', value: null }, precipitationLastHour: { unitCode: 'wmoUnit:mm', value: null } } },
  ] };
  const rows = parseNwsObservations(body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].valid_at, '2026-10-04T12:54:00.000Z'); // sorted by valid time
  assert.deepEqual([rows[1].station, rows[1].tmpf, rows[1].p01i, rows[1].available_at], ['KPHL', 73.04, 0.1, '2026-10-04T14:04:00.000Z']);
  assert.equal(rows[0].tmpf, null); assert.equal(rows[0].p01i, null);
  const seen = parseNwsObservations(body, { firstSeenAt: '2026-10-04T15:00:00.000Z' });
  assert.equal(seen[1].available_at, '2026-10-04T15:00:00.000Z');
  const csv = 'station,valid,tmpf,p01i\nPHL,2025-07-01 13:54,88.00,0.00\nPHL,2025-07-01 14:54,86.00,T\nPHL,2025-07-01 15:54,M,0.12\n';
  const iem = parseIemAsosCsv(csv);
  assert.deepEqual(iem.map((r) => [r.station, r.valid_at, r.tmpf, r.p01i, r.trace]), [
    ['KPHL', '2025-07-01T13:54:00.000Z', 88, 0, false], ['KPHL', '2025-07-01T14:54:00.000Z', 86, 0, true], ['KPHL', '2025-07-01T15:54:00.000Z', null, 0.12, false]]);
  assert.equal(iem[0].available_at, '2025-07-01T14:04:00.000Z');
});

test('remaining PoP: hour slots from 6-h periods, constant hazard; uncovered -> null', () => {
  const run = nbmRun('KNYC', [0.5, 0.5, 0.5]);
  const full = remainingPop([run], '2026-10-04T18:00:00.000Z', '2026-10-05T00:00:00.000Z');
  assert.ok(Math.abs(full.pop - 0.5) < 1e-9);
  const half = remainingPop([run], '2026-10-04T21:00:00.000Z', '2026-10-05T00:00:00.000Z');
  assert.ok(Math.abs(half.pop - (1 - Math.sqrt(0.5))) < 1e-9);
  assert.equal(remainingPop([run], '2026-10-05T05:00:00.000Z', '2026-10-05T07:00:00.000Z'), null);
});

test('artifacts: separate generation, state exported from validation, bound samples recorded; v1.x untouched', () => {
  for (const a of [tempArt, precipArt]) {
    assert.equal(a.version, '2.0.0'); assert.equal(a.generation, 'intraday-v2');
    assert.ok(['RESEARCH', 'SHADOW'].includes(a.state));
    assert.equal(a.state, Object.values(a.holdout.gate).every(Boolean) ? 'RESEARCH' : 'SHADOW');
    assert.equal(a.observation_rule.publication_lag_min, OBS_PUBLICATION_LAG_MIN);
  }
  assert.equal(INTRADAY_MODELS.PRECIP_ANY.state, precipArt.state);
  assert.equal(INTRADAY_MODELS.MAX_TEMP_BUCKET.state, tempArt.state);
  assert.ok(precipArt.measured_bound.pooled.n > 1000);
  for (const s of Object.values(precipArt.measured_bound.by_station)) assert.ok(Number.isInteger(s.n) && Number.isInteger(s.yes) && s.bound < 1);
  assert.ok(tempArt.rounding_conversion_risk.n > 1000);
  assert.deepEqual([WEATHER_MODELS.PRECIP_ANY.version, WEATHER_MODELS.MAX_TEMP_BUCKET.version], ['1.0.0', '1.0.0']);
  assert.equal(publishableIntraday(0.0004), 0.01); assert.equal(publishableIntraday(0.9996), 0.99); assert.equal(publishableIntraday(0.374), 0.37);
});

// ---------------- maxtemp-intraday 2.1.0 (METAR 6-hour maximum groups) ----------------
import { parseMetarSixHour } from '../src/weather/intraday/observations.js';
import { INTRADAY_TEMP_MODELS } from '../src/weather/intraday/engine.js';
import temp21 from '../src/weather/artifacts/temp-intraday-v2.1.json' with { type: 'json' };

const withMax6 = (rows, byValid = {}) => rows.map((r) => ({ ...r, max6_f: byValid[r.valid_at] ?? null }));

test('2.1.0: METAR 1snTTT/2snTTT decoding', () => {
  assert.deepEqual(parseMetarSixHour('KPHL 041154Z 00000KT 10SM 18/12 A3029 RMK AO2 SLP257 T01780122 10178 20161 53005'), { max6_f: 64.04, min6_f: 60.98 });
  assert.deepEqual(parseMetarSixHour('KMSP 041154Z RMK AO2 11006 21022'), { max6_f: 30.92, min6_f: 28.04 });
  assert.deepEqual(parseMetarSixHour('KPHL 041254Z 10SM 18/12 RMK AO2 T01780122'), { max6_f: null, min6_f: null });
  assert.deepEqual(parseMetarSixHour('KPHL 041254Z 10178 10SM'), { max6_f: null, min6_f: null }); // only after RMK
});

test('2.1.0: a 6-h max counts only when its whole period is inside the window; it raises the observed max', async () => {
  const c = await contract(nyHigh, '-B63.5');
  const nbm = nbmRun('KNYC', undefined, 66);
  const base = obsSeries('KNYC', 15, (k) => (k < 6 ? 62.96 : 61)); // hourly max 62.96
  const opts = { now: AFTERNOON, tempModelVersion: '2.1.0' };
  const none = forecastIntraday(c, { obs: withMax6(base), nbm }, opts);
  // 05:51Z report: its 6-h period starts 23:51Z, before the 05:00Z window start -> ignored
  const outside = forecastIntraday(c, { obs: withMax6(base, { '2026-10-04T05:51:00.000Z': 66.92 }), nbm }, opts);
  // 11:51Z report: period 05:51-11:51Z inside the window -> counted
  const inside = forecastIntraday(c, { obs: withMax6(base, { '2026-10-04T11:51:00.000Z': 64.04 }), nbm }, opts);
  assert.equal(none.status, 'OK');
  assert.deepEqual(none.model, INTRADAY_TEMP_MODELS['2.1.0']);
  assert.equal(outside.features.obs_max_so_far_int_f, 63); assert.equal(outside.rawProbability, none.rawProbability);
  assert.equal(inside.features.obs_max_so_far_int_f, 64); assert.equal(inside.features.obs_max6_so_far_f, 64.04);
  assert.notEqual(inside.inputHash, none.inputHash);
  const lt64 = await contract(nyHigh, '-T63'); // high < 63... (cap 63): impossible once 64 is in hand
  assert.ok(forecastIntraday(lt64, { obs: withMax6(base, { '2026-10-04T11:51:00.000Z': 64.04 }), nbm }, opts).rawProbability < 0.005);
  // a 6-h max published after now is not used
  const late = withMax6(obsSeries('KNYC', 16, () => 61), { '2026-10-04T20:51:00.000Z': 70 });
  assert.equal(forecastIntraday(c, { obs: late, nbm }, opts).features.obs_max6_so_far_f, null);
});

test('2.1.0 requires max6_f on rows; 2.0.0 (default) ignores it and is unchanged', async () => {
  const c = await contract(nyHigh, '-B63.5');
  const nbm = nbmRun('KNYC', undefined, 66);
  const base = obsSeries('KNYC', 15, () => 61);
  assert.equal(forecastIntraday(c, { obs: base, nbm }, { now: AFTERNOON, tempModelVersion: '2.1.0' }).status, 'INCOMPLETE_OBSERVATIONS');
  const v20a = forecastIntraday(c, { obs: base, nbm }, { now: AFTERNOON });
  const v20b = forecastIntraday(c, { obs: withMax6(base, { '2026-10-04T11:51:00.000Z': 70 }), nbm }, { now: AFTERNOON });
  assert.equal(v20a.model.version, '2.0.0');
  assert.equal(v20a.rawProbability, v20b.rawProbability); assert.equal(v20a.inputHash, v20b.inputHash);
  assert.throws(() => forecastIntraday(c, { obs: base, nbm }, { now: AFTERNOON, tempModelVersion: '9.9.9' }), RangeError);
});

test('2.1.0 artifact: separate file, gate includes v2.0, state from validation', () => {
  assert.equal(temp21.version, '2.1.0');
  assert.deepEqual(Object.keys(temp21.holdout.gate).sort(), ['climatology_remaining', 'intraday_v20', 'persistence', 'prewindow_v11']);
  assert.equal(temp21.state, Object.values(temp21.holdout.gate).every(Boolean) ? 'RESEARCH' : 'SHADOW');
  assert.equal(INTRADAY_TEMP_MODELS['2.1.0'].state, temp21.state);
  assert.equal(tempArt.version, '2.0.0'); // v2.0 artifact untouched
});

test('NWS parser: 5-minute readings dropped (METARs only); 6-h max read from rawMessage', () => {
  const body = { features: [
    { properties: { stationId: 'KPHL', timestamp: '2026-10-04T11:50:00+00:00', temperature: { unitCode: 'wmoUnit:degC', value: 18 } } },
    { properties: { stationId: 'KPHL', timestamp: '2026-10-04T11:54:00+00:00', rawMessage: 'KPHL 041154Z 00000KT 10SM 17/12 A3029 RMK AO2 SLP257 T01720122 10178 20161', temperature: { unitCode: 'wmoUnit:degC', value: 17.2 }, precipitationLastHour: { unitCode: 'wmoUnit:mm', value: null } } },
  ] };
  const rows = parseNwsObservations(body);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].tmpf, rows[0].max6_f], [62.96, 64.04]);
  assert.equal(parseNwsObservations(body, { metarOnly: false }).length, 2);
});
