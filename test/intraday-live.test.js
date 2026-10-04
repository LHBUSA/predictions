// PHASE A (owner 2026-10-04): live intraday writes are keyed on PREDICTIVE state, not on wall-clock-drifting inputs.
// Reproduces the Philadelphia acceptance HOLD (same observations + same guidance + later clock -> rain 99% must write 0)
// and the full matrix: irrelevant 5-min ob -> 0, predictive change -> 1, new guidance on a time-using branch -> 1,
// local-hour boundary on a time-using branch -> exactly 1, repeat -> 0. Temperature v2.1 semantics unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContract } from '../src/engine/contracts.js';
import { normalizeMosRow } from '../src/weather/mos.js';
import { intradayForStation, predictiveState, engineObservations, RAIN_MODEL_ID } from '../workers/pbe-predictions/src/intraday-live.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const NOW0 = '2026-10-03T18:30:00.000Z';
const rainFx = read('./fixtures/kalshi/KXRAIN-26OCT04.json');
const highFx = read('./fixtures/kalshi/KXHIGHNY-26OCT04.json');
const nbm = (runtime = '2026-10-04T13:00:00.000Z', pops = [0.1, 0.4, 0.3]) => ({ icao: 'KNYC', runtime, url: 'synthetic', observationKey: 'syn', rows: [
  { runtime, ftime: '2026-10-04T18:00:00.000Z', txn: null, xnd: null, p06: pops[0] * 100, n_x: null },
  { runtime, ftime: '2026-10-05T00:00:00.000Z', txn: 66, xnd: 2, p06: pops[1] * 100, n_x: null },
  { runtime, ftime: '2026-10-05T06:00:00.000Z', txn: null, xnd: null, p06: pops[2] * 100, n_x: null }] });
const mos = () => { const rows = read('./fixtures/weather/mos-KNYC.json').data.map(normalizeMosRow); return { icao: 'KNYC', runtime: rows[0].runtime, url: 'iem', rows }; };
// stored source-observation rows (hot-lane shape): hourly METARs at :51 from the window start, optional 5-min readings
const metar = (k, { p = 0, t = 60 } = {}) => ({ observed_at: new Date(Date.parse('2026-10-04T05:51:00.000Z') + k * 3600000).toISOString(), available_at: new Date(Date.parse('2026-10-04T06:01:00.000Z') + k * 3600000).toISOString(), data: { metar: true, temp_f: t, precip_hour_in: p, max6_f: null } });
const fivemin = (iso) => ({ observed_at: iso, available_at: iso, data: { metar: false, temp_f: 61, precip_hour_in: null } });

async function harness(contracts, obsRows) {
  const forecasts = []; const feats = [];
  const store = {
    selectIn: async (t, q, col, ids) => (t === 'pred_contracts' ? contracts.filter((c) => ids.includes(c.contract_id)) : t === 'pred_forecasts' ? [...forecasts].sort((a, b) => b.captured_at.localeCompare(a.captured_at)) : t === 'pred_feature_snapshots' ? feats.filter((f) => ids.includes(f.snapshot_id)) : []),
    select: async () => obsRows.rows,
    insertFeatureRows: async (r) => feats.push(...r), insertForecastRows: async (r) => forecasts.push(...r),
  };
  const st = { icao: 'KNYC', cli: 'CLINYC', start: contracts[0].observation_start, end: contracts[0].observation_end, contracts };
  return { forecasts, run: (now, src) => intradayForStation(store, st, { now, sources: src }) };
}

test('PHILADELPHIA HOLD reproduced: same observations + same guidance + later wall clock -> rain (measured, 99%) writes 0', async () => {
  const rain = await normalizeContract({ series: rainFx.series, event: rainFx.event, market: rainFx.markets.find((m) => m.ticker.endsWith('-NYC')) }, { now: NOW0 });
  const obsRows = { rows: Array.from({ length: 13 }, (_, k) => metar(k, { p: k === 3 ? 0.04 : 0 })) }; // measurable rain mid-morning
  const h = await harness([rain], obsRows);
  const src = { nbm: nbm(), mos: mos() };
  const a = await h.run('2026-10-04T18:33:33.000Z', src);
  assert.equal(a.written, 1);
  assert.equal(h.forecasts[0].explanation.branch, 'measured_bound');
  const b = await h.run('2026-10-04T18:48:33.000Z', src); // the exact failing replay shape
  assert.deepEqual([b.written, b.unchanged], [0, 1]);
  const c2 = await h.run('2026-10-04T21:48:33.000Z', src); // even hours later: bound branch is time-independent
  assert.equal(c2.written, 0);
});

test('irrelevant 5-min reading -> source fact only, 0 forecast rows; predictive change (first measurable rain) -> 1', async () => {
  const rain = await normalizeContract({ series: rainFx.series, event: rainFx.event, market: rainFx.markets.find((m) => m.ticker.endsWith('-NYC')) }, { now: NOW0 });
  const obsRows = { rows: Array.from({ length: 13 }, (_, k) => metar(k)) };
  const h = await harness([rain], obsRows);
  const src = { nbm: nbm(), mos: mos() };
  assert.equal((await h.run('2026-10-04T18:20:00.000Z', src)).written, 1);
  obsRows.rows.push(fivemin('2026-10-04T18:25:00.000Z'));
  assert.equal((await h.run('2026-10-04T18:30:00.000Z', src)).written, 0, '5-min whole-°C reading changes nothing the model uses');
  obsRows.rows.push({ ...metar(13, { p: 0.06 }), available_at: '2026-10-04T18:59:00.000Z' });
  const r = await h.run('2026-10-04T19:02:00.000Z', src); // usable at valid + 10 min (19:01Z)
  assert.equal(r.written, 1, 'measurable rain reported -> predictive state changed');
  assert.equal(h.forecasts.at(-1).explanation.predictive_state.features.measurable_precip_observed, true);
});

test('time-using branch: new guidance run -> 1; local-hour boundary -> exactly 1; repeat same boundary/input -> 0', async () => {
  const rain = await normalizeContract({ series: rainFx.series, event: rainFx.event, market: rainFx.markets.find((m) => m.ticker.endsWith('-NYC')) }, { now: NOW0 });
  const obsRows = { rows: Array.from({ length: 13 }, (_, k) => metar(k)) };
  const h = await harness([rain], obsRows);
  const src1 = { nbm: nbm(), mos: mos() };
  assert.equal((await h.run('2026-10-04T18:10:00.000Z', src1)).written, 1);
  assert.equal(h.forecasts[0].explanation.branch, 'logistic');
  assert.equal((await h.run('2026-10-04T18:40:00.000Z', src1)).written, 0, 'same LST hour, same sources');
  const src2 = { nbm: nbm('2026-10-04T14:00:00.000Z', [0.2, 0.6, 0.3]), mos: mos() };
  assert.equal((await h.run('2026-10-04T19:05:00.000Z', src2)).written, 1, 'new guidance run used by the model');
  assert.equal((await h.run('2026-10-04T19:06:00.000Z', src2)).written, 0);
  assert.equal((await h.run('2026-10-04T20:01:00.000Z', src2)).written, 1, 'documented boundary: next local standard hour');
  assert.equal((await h.run('2026-10-04T20:30:00.000Z', src2)).written, 0, 'repeat same boundary/input');
  const buckets = h.forecasts.map((f) => f.explanation.predictive_state.lst_hour_bucket);
  assert.equal(new Set(buckets).size, buckets.length, 'one row per legitimate state');
});

test('temperature v2.1 keeps its existing inputHash dedupe (no predictive state); raw rows never carry clock fields', async () => {
  assert.equal(predictiveState('pbe-weather-maxtemp-intraday', { obs_max_so_far_f: 64 }, [], null), null);
  const s = predictiveState(RAIN_MODEL_ID, { obs_count: 25, hours_into_window_lst: 13.8, hours_remaining: 10.2, remaining_pop: 0.31, measurable_precip_observed: false }, [{ role: 'model input', run: 'r1' }], 'logistic');
  assert.deepEqual(Object.keys(s.features), ['measurable_precip_observed']);
  assert.equal(s.lst_hour_bucket, 13);
  const high = await normalizeContract({ series: highFx.series, event: highFx.event, market: highFx.markets.find((m) => m.ticker.endsWith('-B67.5')) }, { now: NOW0 });
  const obsRows = { rows: Array.from({ length: 13 }, (_, k) => ({ ...metar(k, { t: 58 + k * 0.3 }), data: { ...metar(k, { t: 58 + k * 0.3 }).data, max6_f: null } })) };
  const h = await harness([high], obsRows);
  const src = { nbm: nbm(), mos: mos() };
  const a = await h.run('2026-10-04T18:20:00.000Z', src);
  const b = await h.run('2026-10-04T18:20:00.000Z', src);
  assert.equal(b.written, 0, 'identical inputs');
  if (a.written) assert.equal(h.forecasts[0].explanation.predictive_input_hash, h.forecasts[0].explanation.input_hash, 'temp predictive hash = its inputHash');
  assert.equal(engineObservations(obsRows.rows, 'KNYC').length, 13);
});
