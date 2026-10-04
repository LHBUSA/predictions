// maxtemp-intraday 2.2.0 (SHADOW research build): METAR present-weather / sky parsers, NBM TMP trajectory features,
// engine fail-closed contract, SHADOW state, v2.0/v2.1 untouched, shadow forward-validation lane (pure module).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContract } from '../src/engine/contracts.js';
import { MARKET_KEY_PATTERN, MarketLeakageError } from '../src/engine/leakage.js';
import { forecastIntraday, INTRADAY_TEMP_MODELS } from '../src/weather/intraday/engine.js';
import { TEMP_V22_MODEL } from '../src/weather/intraday/temp-v22.js';
import { parseMetarWeather, iemWeatherFields, parseNwsObservationsV22, parseNwsObservations } from '../src/weather/intraday/observations.js';
import { weatherState, weatherRegime, latestWeather, trajectoryFeatures, nbmTempAt, OBS_PUBLICATION_LAG_MIN } from '../src/weather/intraday/features.js';
import { tableHour22, gapGuidance22, tempCellKeys22, FEATURE_BUCKETS, tempEDistribution, tempCellKeys } from '../src/weather/intraday/models.js';
import { forecastIntradayShadow, shadowWriteDecision, shadowForecastRow, shadowPredictiveHash, shadowSourceStateHash, shadowEvaluationReport, SHADOW_TEMP_MODEL_VERSION, SHADOW_DESIGNATION_RULES } from '../src/weather/intraday/shadow.js';
import art22 from '../src/weather/artifacts/temp-intraday-v2.2.json' with { type: 'json' };
import art21 from '../src/weather/artifacts/temp-intraday-v2.1.json' with { type: 'json' };

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const NOW0 = '2026-10-03T18:30:00.000Z';
const nyHigh = read('./fixtures/kalshi/KXHIGHNY-26OCT04.json');
const contract = (suffix) => normalizeContract({ series: nyHigh.series, event: nyHigh.event, market: nyHigh.markets.find((m) => m.ticker.endsWith(suffix)) }, { now: NOW0 });
const AFTERNOON = '2026-10-04T20:05:00.000Z'; // 15:05 LST at CLINYC (window opens 05:00Z)
// synthetic NBS runs with the 3-hourly TMP path (+ TXN at 00Z next day)
const run = (runtime, path, txn) => ({ icao: 'KNYC', runtime, url: 'synthetic', observationKey: `syn-${runtime}`,
  rows: path.map(([ftime, tmp]) => ({ runtime, ftime, tmp, txn: ftime === '2026-10-05T00:00:00.000Z' ? txn : null, xnd: null, p06: null, n_x: null })) });
const run12 = run('2026-10-04T12:00:00.000Z', [['2026-10-04T18:00:00.000Z', 64], ['2026-10-04T21:00:00.000Z', 66], ['2026-10-05T00:00:00.000Z', 63], ['2026-10-05T03:00:00.000Z', 60], ['2026-10-05T06:00:00.000Z', 58]], 67);
const run06 = run('2026-10-04T06:00:00.000Z', [['2026-10-04T12:00:00.000Z', 58], ['2026-10-04T15:00:00.000Z', 62], ['2026-10-04T18:00:00.000Z', 65], ['2026-10-04T21:00:00.000Z', 67], ['2026-10-05T00:00:00.000Z', 64]], 68);
const obsSeries = (n, temp, wx = () => ({ wxcodes: [], sky: [{ cover: 'BKN', base_ft: 4000 }] })) => Array.from({ length: n }, (_, k) => {
  const v = Date.parse('2026-10-04T05:51:00.000Z') + k * 3600000;
  return { station: 'KNYC', valid_at: new Date(v).toISOString(), available_at: new Date(v + OBS_PUBLICATION_LAG_MIN * 60000).toISOString(), tmpf: temp(k), p01i: 0, trace: false, max6_f: null, ...wx(k) };
});

test('parseMetarWeather: present weather + sky from the body only; RMK ignored; no sky group -> null', () => {
  const a = parseMetarWeather('KPHL 041354Z 06008KT 4SM -RA BR SCT013 BKN033 OVC045 17/14 A3023 RMK AO2 SLP237 P0001 T01670144');
  assert.deepEqual(a.wxcodes, ['-RA', 'BR']);
  assert.deepEqual(a.sky.map((l) => [l.cover, l.base_ft]), [['SCT', 1300], ['BKN', 3300], ['OVC', 4500]]);
  const b = parseMetarWeather('KPHL 041807Z 04011KT 10SM BKN007 OVC012 17/15 A3015 RMK AO2 RAE06 P0000 T01670150');
  assert.deepEqual(b.wxcodes, []); // RAE06 is a remark (rain ended), not present weather
  assert.equal(weatherRegime(weatherState(b.wxcodes, b.sky)), 'overcast');
  assert.equal(weatherState(b.wxcodes, b.sky).ceiling_ft, 700);
  assert.deepEqual(parseMetarWeather('KDEN 041753Z 00000KT 10SM CLR 20/M05 A3010').sky, [{ cover: 'CLR', base_ft: null }]);
  assert.equal(parseMetarWeather('KXXX 041753Z 00000KT 10SM 20/M05 A3010').sky, null);
  assert.deepEqual(parseMetarWeather(''), { wxcodes: null, sky: null });
  const ts = parseMetarWeather('KMIA 041753Z 09010KT 10SM VCTS FEW020CB BKN040 30/24 A3000');
  assert.equal(weatherState(ts.wxcodes, ts.sky).precip, false, 'vicinity thunder is not at-station precipitation');
  assert.equal(weatherRegime(weatherState(['-TSRA'], [{ cover: 'FEW', base_ft: 2000 }])), 'precip');
  assert.equal(weatherRegime(weatherState(['BR'], [{ cover: 'SCT', base_ft: 900 }])), 'clear');
  assert.equal(weatherState(['BR'], null).obscuration, true);
  assert.equal(weatherRegime(null), 'unknown');
});

test('iemWeatherFields mirrors the METAR parser shape (IEM decoded wxcodes / skyc / skyl)', () => {
  assert.deepEqual(iemWeatherFields('-RA BR', ['OVC', 'M', 'M', 'M'], ['500.00', 'M', 'M', 'M']), { wxcodes: ['-RA', 'BR'], sky: [{ cover: 'OVC', base_ft: 500 }] });
  assert.deepEqual(iemWeatherFields('M', ['CLR', 'M', 'M', 'M'], ['M', 'M', 'M', 'M']), { wxcodes: [], sky: [{ cover: 'CLR', base_ft: null }] });
  assert.deepEqual(iemWeatherFields('M', ['M', 'M', 'M', 'M'], ['M', 'M', 'M', 'M']), { wxcodes: [], sky: null });
});

test('parseNwsObservationsV22 adds wxcodes/sky; parseNwsObservations output is unchanged', () => {
  const body = { features: [{ properties: { timestamp: '2026-10-04T13:54:00+00:00', stationId: 'KPHL', temperature: { value: 16.7, unitCode: 'wmoUnit:degC' }, precipitationLastHour: { value: 0.25, unitCode: 'wmoUnit:mm' }, rawMessage: 'KPHL 041354Z 06008KT 4SM -RA BR SCT013 BKN033 OVC045 17/14 A3023 RMK AO2 P0001 T01670144' } }] };
  const old = parseNwsObservations(body); const v22 = parseNwsObservationsV22(body);
  assert.equal(Object.prototype.hasOwnProperty.call(old[0], 'wxcodes'), false);
  assert.deepEqual({ ...v22[0], wxcodes: undefined, sky: undefined }, { ...old[0], wxcodes: undefined, sky: undefined });
  assert.deepEqual(v22[0].wxcodes, ['-RA', 'BR']);
  assert.equal(v22[0].sky.length, 3);
});

test('trajectoryFeatures: interpolated NBM TMP path, newest covering run, residual, remaining peak, slopes, run change', () => {
  const runs = [run12, run06];
  assert.equal(nbmTempAt(runs, Date.parse('2026-10-04T19:30:00.000Z')).tmp, 65); // 64 -> 66 over 18Z..21Z
  assert.equal(nbmTempAt(runs, Date.parse('2026-10-04T13:30:00.000Z')).runtime, run06.runtime); // 12Z run starts at 18Z
  const tr = trajectoryFeatures(runs, { now: '2026-10-04T19:00:00.000Z', end: '2026-10-05T05:00:00.000Z', curValidAt: '2026-10-04T18:51:00.000Z', cur: 62 });
  assert.ok(Math.abs(tr.nbm_now - (64 + 2 * 51 / 180)) < 1e-9);
  assert.ok(Math.abs(tr.resid - (62 - tr.nbm_now)) < 1e-12);
  assert.equal(tr.rem_peak, 66); assert.equal(tr.rem_peak_lead_h, 2);
  assert.ok(Math.abs(tr.slope1 - 2 / 3) < 1e-9);
  assert.ok(tr.path_change < 0, 'the 12Z path is cooler than the 06Z path');
  assert.equal(trajectoryFeatures([], { now: '2026-10-04T19:00:00.000Z', end: '2026-10-05T05:00:00.000Z', cur: 62 }), null);
  assert.equal(trajectoryFeatures([run12], { now: '2026-10-04T13:00:00.000Z', end: '2026-10-05T05:00:00.000Z', curValidAt: '2026-10-04T12:51:00.000Z', cur: 60 }), null, 'path must cover now');
});

test('2.2 model helpers: hourly calibration hour, gap guidance sources, extended cell keys; base distribution unchanged', () => {
  assert.equal(tableHour22(0.4), 1); assert.equal(tableHour22(13.9), 13); assert.equal(tableHour22(30), 23);
  assert.equal(gapGuidance22('txn', { txn: 67 }), 67);
  assert.equal(gapGuidance22('proj', { rem_peak: 64, resid: -2 }), 62);
  assert.equal(gapGuidance22('proj_half', { rem_peak: 64, resid: -2 }), 63);
  assert.equal(gapGuidance22('proj', { rem_peak: null, resid: 1 }), null);
  const x = { station: 'CLINYC', h: 13, M: 64, D: 61, g: 63, wx: 'precip', sky_rank: 4, ceil: 700, resid: -1, rem_peak: 64, s3: 0, s1: 0, path_chg: -1, rem_peak_lead: 2, obsc: false };
  const k = tempCellKeys22(x, ['hour', 'hour_gap_drop', 'hour_gap_drop+wx', 'hour_gap_drop+sky+resid']);
  assert.equal(k['hour_gap_drop+wx'], `${k.hour_gap_drop}|precip`);
  assert.equal(k['hour_gap_drop+sky+resid'], `${k.hour_gap_drop}|ovc|0`);
  assert.throws(() => tempCellKeys22(x, ['hour_gap_drop+nope']), RangeError);
  for (const fn of Object.values(FEATURE_BUCKETS)) assert.equal(typeof fn({}), 'string');
  // v2.1 path: explicit default keys give the identical distribution
  const x21 = { station: 'CLINYC', h: 12, M: 64, D: 61, g: 67 };
  assert.deepEqual([...tempEDistribution(art21, x21).p], [...tempEDistribution(art21, x21, tempCellKeys(x21)).p]);
});

test('artifact 2.2.0: SHADOW regardless of gate, gate recorded separately, holdout flagged non-pristine, no market inputs', () => {
  assert.equal(art22.version, '2.2.0');
  assert.equal(art22.state, 'SHADOW');
  assert.equal(typeof art22.research_gate_passed, 'boolean');
  assert.equal(art22.holdout.pristine, false);
  assert.equal(art22.holdout.research_gate_passed, art22.research_gate_passed);
  assert.equal(TEMP_V22_MODEL.state, 'SHADOW');
  assert.equal(INTRADAY_TEMP_MODELS['2.1.0'].state, art21.state, 'v2.1 untouched');
  for (const l of art22.levels) assert.equal(MARKET_KEY_PATTERN.test(l), false, l);
  assert.ok(!/kalshi|polymarket/i.test(JSON.stringify({ ...art22, tables: null, below_obs_max: null })));
});

test('engine 2.2.0: OK on complete inputs, SHADOW model, probabilities sum to 1 over a partition, market-free features', async () => {
  const obs = obsSeries(15, (k) => 55 + k * 0.6);
  const parts = [['-T63'], ['-B63.5'], ['-B65.5'], ['-B67.5'], ['-B69.5'], ['-T70']];
  let sum = 0; let one = null;
  for (const [suffix] of parts) {
    const c = await contract(suffix);
    const f = forecastIntraday(c, { obs, nbm: [run12, run06] }, { now: AFTERNOON, tempModelVersion: '2.2.0' });
    assert.equal(f.status, 'OK', JSON.stringify(f));
    assert.deepEqual(f.model, TEMP_V22_MODEL);
    assert.equal(f.explanation.model_state, 'SHADOW');
    for (const k of Object.keys(f.features)) assert.equal(MARKET_KEY_PATTERN.test(k), false, k);
    assert.ok(Date.parse(f.dataCutoffAt) <= Date.parse(AFTERNOON));
    sum += f.rawProbability; one = f;
  }
  assert.ok(Math.abs(sum - 1) < 1e-9, `partition sums to ${sum}`);
  assert.equal(one.features.calibration_hour_lst, art22.calibration_resolution === 'hourly' ? 15 : 14);
  assert.equal(one.features.present_weather_regime, 'broken');
  assert.equal(one.features.nbm_remaining_peak_f, 66);
  // determinism: same inputs -> same inputHash; obs order irrelevant
  const c = await contract('-B65.5');
  const a = forecastIntraday(c, { obs, nbm: [run12, run06] }, { now: AFTERNOON, tempModelVersion: '2.2.0' });
  const b = forecastIntraday(c, { obs: [...obs].reverse(), nbm: [run06, run12] }, { now: AFTERNOON, tempModelVersion: '2.2.0' });
  assert.equal(a.inputHash, b.inputHash); assert.equal(a.rawProbability, b.rawProbability);
});

test('engine 2.2.0 fails closed on missing required inputs (per artifact.requires) and refuses market keys', async () => {
  const c = await contract('-B65.5');
  const obs = obsSeries(15, (k) => 55 + k * 0.6);
  const noMax6 = obs.map(({ max6_f, ...r }) => r);
  assert.equal(forecastIntraday(c, { obs: noMax6, nbm: [run12, run06] }, { now: AFTERNOON, tempModelVersion: '2.2.0' }).status, 'INCOMPLETE_OBSERVATIONS');
  const noWx = obs.map(({ wxcodes, sky, ...r }) => r);
  const fw = forecastIntraday(c, { obs: noWx, nbm: [run12, run06] }, { now: AFTERNOON, tempModelVersion: '2.2.0' });
  assert.equal(fw.status, art22.requires.observation_weather_fields ? 'INCOMPLETE_OBSERVATIONS' : 'OK');
  const noTmp = [run12, run06].map((r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, tmp: null })) }));
  const fp = forecastIntraday(c, { obs, nbm: noTmp }, { now: AFTERNOON, tempModelVersion: '2.2.0' });
  assert.equal(fp.status, art22.requires.nbm_tmp_path ? 'INCOMPLETE_GUIDANCE' : 'OK');
  assert.equal(forecastIntraday(c, { obs, nbm: [] }, { now: AFTERNOON, tempModelVersion: '2.2.0' }).status, 'INCOMPLETE_GUIDANCE');
  const leaky = obs.map((r, i) => (i === 3 ? { ...r, kalshi_yes_bid: 0.4 } : r));
  assert.throws(() => forecastIntraday(c, { obs: leaky, nbm: [run12] }, { now: AFTERNOON, tempModelVersion: '2.2.0' }), MarketLeakageError);
});

test('present weather can move 2.2 (when selected) but never v2.1: v2.1 output is identical with or without the new fields', async () => {
  const c = await contract('-B65.5');
  const dry = obsSeries(15, (k) => 55 + k * 0.6);
  const wet = obsSeries(15, (k) => 55 + k * 0.6, () => ({ wxcodes: ['-RA', 'BR'], sky: [{ cover: 'OVC', base_ft: 700 }] }));
  const strip = (o) => o.map(({ wxcodes, sky, ...r }) => r);
  const v21a = forecastIntraday(c, { obs: dry, nbm: [run12] }, { now: AFTERNOON, tempModelVersion: '2.1.0' });
  const v21b = forecastIntraday(c, { obs: strip(wet), nbm: [run12] }, { now: AFTERNOON, tempModelVersion: '2.1.0' });
  const v21c = forecastIntraday(c, { obs: wet, nbm: [run12] }, { now: AFTERNOON, tempModelVersion: '2.1.0' });
  assert.equal(v21a.inputHash, v21b.inputHash); assert.equal(v21b.inputHash, v21c.inputHash);
  assert.deepEqual(v21a.features, v21c.features);
  const w = forecastIntraday(c, { obs: wet, nbm: [run12, run06] }, { now: AFTERNOON, tempModelVersion: '2.2.0' });
  assert.equal(w.features.present_weather_regime, 'precip');
  assert.equal(latestWeather(wet).ceiling_ft, 700);
});

test('shadow lane: SHADOW rows, predictive-state dedupe (no clock-only rows), never public, no market fields', async () => {
  const c = { ...(await contract('-B65.5')), contract_id: 'C-NY-64', event_id: 'E-NY', market_id: 'M-NY' };
  const obs = obsSeries(15, (k) => 55 + k * 0.6);
  assert.equal(SHADOW_TEMP_MODEL_VERSION, '2.2.0');
  const r1 = forecastIntradayShadow(c, { obs, nbm: [run12, run06] }, { now: AFTERNOON });
  assert.equal(r1.status, 'OK'); assert.equal(r1.model.state, 'SHADOW');
  const d1 = shadowWriteDecision(null, r1); assert.equal(d1.write, true); assert.equal(d1.reason, 'FIRST_ROW');
  const row = shadowForecastRow(c, r1, { now: AFTERNOON, sourceStateHash: shadowSourceStateHash(r1, c.contract_id, obs) });
  assert.equal(row.record_type, 'shadow'); assert.equal(row.model_state, 'SHADOW'); assert.equal(row.public, false);
  assert.equal(row.designation_rules, SHADOW_DESIGNATION_RULES);
  assert.equal(row.market_probability, null); assert.equal(row.market_snapshot_key, null);
  assert.equal(row.explanation.predictive_input_hash, shadowPredictiveHash(r1));
  // 4 minutes later, nothing new: same predictive state -> no row (clock alone never writes)
  const r2 = forecastIntradayShadow(c, { obs, nbm: [run12, run06] }, { now: '2026-10-04T20:09:00.000Z' });
  assert.deepEqual(shadowWriteDecision(row, r2).write, false);
  // the record id is content-addressed: a retried cycle cannot duplicate it
  assert.equal(shadowForecastRow(c, r2, { now: '2026-10-04T20:09:00.000Z' }).record_id, row.record_id);
  // a materially new observation (new max) changes the predictive state -> write
  const hot = [...obs, { ...obs[14], valid_at: '2026-10-04T20:00:00.000Z', available_at: '2026-10-04T20:10:00.000Z', tmpf: 75 }];
  const r3 = forecastIntradayShadow(c, { obs: hot, nbm: [run12, run06] }, { now: '2026-10-04T20:11:00.000Z' });
  assert.equal(shadowWriteDecision(row, r3).write, true);
  assert.equal(forecastIntradayShadow({ ...c, event_type: 'PRECIP_ANY' }, { obs }, { now: AFTERNOON }).status, 'UNSUPPORTED_EVENT_TYPE');
});

test('shadow evaluation report: fixed hourly grid, both models required, readiness thresholds, date-clustered CI', () => {
  const rows = []; const outcomes = {};
  for (let d = 0; d < 35; d += 1) {
    const date = new Date(Date.parse('2026-10-05T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
    for (let s = 0; s < 10; s += 1) {
      const station = `CLIS${s}`; const start = `${date}T05:00:00.000Z`; outcomes[`${station}|${date}`] = 70;
      const base = { contract_id: `${station}-${date}`, station_id: station, climate_date: date, observation_start: start, comparator: 'between', threshold_low: 70, threshold_high: 71 };
      rows.push({ ...base, model_version: '2.1.0', captured_at: `${date}T06:00:00.000Z`, raw_probability: 0.5 });
      rows.push({ ...base, model_version: '2.2.0', captured_at: `${date}T06:30:00.000Z`, raw_probability: 0.7 });
    }
  }
  const rep = shadowEvaluationReport(rows, outcomes, { boot: 200 });
  assert.equal(rep.ready, true); assert.equal(rep.resolved_days, 35); assert.equal(rep.stations, 10);
  assert.equal(rep.n_points, 35 * 10 * 22, 'hour 1 has no 2.2 row yet (captured 06:30) -> skipped');
  assert.ok(rep.metrics.brier.base_minus_candidate > 0); assert.equal(rep.forward_gate_passed, true);
  const few = shadowEvaluationReport(rows.filter((r) => r.climate_date < '2026-10-10'), outcomes, { boot: 50 });
  assert.equal(few.ready, false); assert.equal(few.forward_gate_passed, false);
});

test('opt-in registration: only a SHADOW 2.2.x artifact; the production engine module never imports the 2.2 artifact', async () => {
  const { registerIntradayTempArtifact } = await import('../src/weather/intraday/engine.js');
  assert.throws(() => registerIntradayTempArtifact({ ...art22, state: 'RESEARCH' }), RangeError);
  assert.throws(() => registerIntradayTempArtifact(art21), RangeError);
  const src = readFileSync(new URL('../src/weather/intraday/engine.js', import.meta.url), 'utf8');
  assert.equal(src.includes('temp-intraday-v2.2.json'), false, 'v2.1 production bundle must not carry the SHADOW artifact');
  const live = readFileSync(new URL('../workers/pbe-predictions/src/intraday-live.js', import.meta.url), 'utf8');
  assert.equal(/temp-v22|shadow\.js/.test(live), false, 'shadow lane is not wired (design only)');
});
