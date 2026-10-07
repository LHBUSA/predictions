// Phase 2: maxtemp-intraday 2.2.0 PRIVATE SHADOW lane wired after v2.1 (workers/pbe-predictions/src/intraday-shadow-live.js).
// v2.1 writes must be byte-identical with the lane on or off; shadow rows go only to pred_forecasts_shadow; market data
// never enters; missing METAR wx text or NBM TMP path fails closed; frozen predictive-state dedupe (no clock-only rows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContract } from '../src/engine/contracts.js';
import { normalizeMosRow } from '../src/weather/mos.js';
import { MarketLeakageError } from '../src/engine/leakage.js';
import { intradayForStation, engineObservations } from '../workers/pbe-predictions/src/intraday-live.js';
import { engineObservationsV22, shadowTableRow, priorNbmRun } from '../workers/pbe-predictions/src/intraday-shadow-live.js';
import { forecastIntradayShadow } from '../src/weather/intraday/shadow.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const NOW0 = '2026-10-03T18:30:00.000Z';
const highFx = read('./fixtures/kalshi/KXHIGHNY-26OCT04.json');
const mos = () => { const rows = read('./fixtures/weather/mos-KNYC.json').data.map(normalizeMosRow); return { icao: 'KNYC', runtime: rows[0].runtime, url: 'iem', rows }; };
const run = (runtime, path, txn) => ({ icao: 'KNYC', model: 'NBS', runtime, url: 'synthetic', observationKey: `syn-${runtime}`,
  rows: path.map(([ftime, tmp]) => ({ runtime, ftime, tmp, txn: ftime === '2026-10-05T00:00:00.000Z' ? txn : null, xnd: null, p06: null, q06: null, n_x: null, dpt: null })) });
const run12 = run('2026-10-04T12:00:00.000Z', [['2026-10-04T12:00:00.000Z', 60], ['2026-10-04T15:00:00.000Z', 62], ['2026-10-04T18:00:00.000Z', 64], ['2026-10-04T21:00:00.000Z', 66], ['2026-10-05T00:00:00.000Z', 63], ['2026-10-05T03:00:00.000Z', 60], ['2026-10-05T06:00:00.000Z', 58]], 67);
const run06 = run('2026-10-04T06:00:00.000Z', [['2026-10-04T06:00:00.000Z', 57], ['2026-10-04T09:00:00.000Z', 56], ['2026-10-04T12:00:00.000Z', 58], ['2026-10-04T15:00:00.000Z', 62], ['2026-10-04T18:00:00.000Z', 65], ['2026-10-04T21:00:00.000Z', 67], ['2026-10-05T00:00:00.000Z', 64], ['2026-10-05T06:00:00.000Z', 59]], 68);
const iemFetch = (runs) => async (url) => { const rt = new URL(url).searchParams.get('runtime'); const r = runs.find((x) => x.runtime.replace(/:00\.000Z$/, 'Z') === rt); return { ok: true, json: async () => ({ data: r ? r.rows.map((x) => ({ ...x, runtime_utc: x.runtime, ftime_utc: x.ftime })) : [] }) }; };
// stored hot-lane rows: hourly METARs at :51 with raw text (temp group + sky), as runHotLane stores them
const C = (t) => `${String(Math.round((t - 32) * 5 / 9 * 10)).padStart(4, '0')}`;
const metarRow = (k, { t = 58 + k * 0.4, sky = 'BKN040', raw = true } = {}) => {
  const v = new Date(Date.parse('2026-10-04T05:51:00.000Z') + k * 3600000);
  const ddhhmm = `${String(v.getUTCDate()).padStart(2, '0')}${String(v.getUTCHours()).padStart(2, '0')}51Z`;
  return { observed_at: v.toISOString(), available_at: new Date(v.getTime() + 10 * 60000).toISOString(),
    data: { metar: true, temp_f: +t.toFixed(1), precip_hour_in: 0, max6_f: null, raw_message: raw ? `KNYC ${ddhhmm} 00000KT 10SM ${sky} 15/10 A3010 RMK AO2 T0${C(t)}0100` : null } };
};

async function harness(contracts, obsRows, venues = []) {
  const forecasts = []; const feats = []; const shadow = []; const writes = [];
  const store = {
    selectIn: async (t, q, col, ids) => (t === 'pred_contracts' ? contracts.filter((c) => ids.includes(c.contract_id))
      : t === 'pred_forecasts' ? [...forecasts].sort((a, b) => b.captured_at.localeCompare(a.captured_at))
      : t === 'pred_feature_snapshots' ? feats.filter((f) => ids.includes(f.snapshot_id))
      : t === 'pred_venue_snapshots' ? venues.filter((v) => ids.includes(v.contract_id))
      : t === 'pred_forecasts_shadow' ? shadow.filter((s) => ids.includes(s.contract_id)).sort((a, b) => b.captured_at.localeCompare(a.captured_at)) : []),
    select: async () => obsRows.rows,
    insertFeatureRows: async (r) => { writes.push('pred_feature_snapshots'); feats.push(...r); },
    insertForecastRows: async (r) => { writes.push('pred_forecasts'); forecasts.push(...r); },
    insertMany: async (t, r) => { writes.push(t); if (t === 'pred_forecasts_shadow') for (const x of r) if (!shadow.some((s) => s.record_id === x.record_id)) shadow.push(x); },
  };
  const st = { icao: 'KNYC', cli: 'CLINYC', start: contracts[0].observation_start, end: contracts[0].observation_end, contracts };
  return { forecasts, feats, shadow, writes, run: (now, src, shadowOn, fetchImpl = iemFetch([run06])) => intradayForStation(store, st, { now, sources: src, shadow: shadowOn, fetchImpl }) };
}
const high = (suffix = '-B67.5') => normalizeContract({ series: highFx.series, event: highFx.event, market: highFx.markets.find((m) => m.ticker.endsWith(suffix)) }, { now: NOW0 });
const NOWS = ['2026-10-04T18:05:00.000Z', '2026-10-04T18:07:00.000Z', '2026-10-04T19:05:00.000Z', '2026-10-04T20:05:00.000Z'];

test('engineObservationsV22 = engineObservations + wxcodes/sky from the stored raw METAR; no raw text -> no wx keys', () => {
  const rows = [metarRow(0), metarRow(1, { sky: 'OVC008' }), metarRow(2, { raw: false })];
  const a = engineObservations(rows, 'KNYC'); const b = engineObservationsV22(rows, 'KNYC');
  assert.deepEqual(b.map(({ wxcodes, sky, ...o }) => o), a);
  assert.deepEqual(b[1].sky, [{ cover: 'OVC', base_ft: 800 }]);
  assert.equal(Object.hasOwn(b[2], 'wxcodes'), false);
});

test('v2.1 PARITY: v2.1 forecast + feature rows are byte-identical with the shadow lane off vs on', async () => {
  const contracts = [await high('-B67.5'), await high('-B65.5'), await high('-T70')];
  const rows = { rows: Array.from({ length: 15 }, (_, k) => metarRow(k)) };
  const off = await harness(contracts, rows); const on = await harness(contracts, rows);
  const src = { nbm: run12, mos: mos() };
  for (const now of NOWS) { await off.run(now, src, false); await on.run(now, src, true); }
  assert.ok(off.forecasts.length > 0);
  assert.equal(JSON.stringify(on.forecasts), JSON.stringify(off.forecasts));
  assert.equal(JSON.stringify(on.feats), JSON.stringify(off.feats));
  assert.equal(off.shadow.length, 0);
  assert.ok(on.shadow.length > 0, 'shadow rows written');
  assert.deepEqual([...new Set(on.writes)].sort(), ['pred_feature_snapshots', 'pred_forecasts', 'pred_forecasts_shadow']);
  assert.ok(!on.forecasts.some((f) => f.model_version === '2.2.0' || f.model_state === 'SHADOW'), 'no shadow row in pred_forecasts');
});

test('shadow rows: SHADOW, public=false, hashes, station/date/capture, NULL market fields; frozen dedupe (no clock-only rows)', async () => {
  const c = await high('-B67.5');
  const rows = { rows: Array.from({ length: 15 }, (_, k) => metarRow(k)) };
  const h = await harness([c], rows, [{ contract_id: c.contract_id, snapshot_key: 'k', probability: 0.77, captured_at: '2026-10-04T18:00:00.000Z' }]);
  const src = { nbm: run12, mos: mos() };
  const r1 = await h.run('2026-10-04T20:05:00.000Z', src, true);
  assert.equal(r1.shadow.written, 1); assert.equal(r1.shadow.nbm_runs, 2);
  const s = h.shadow[0];
  assert.equal(`${s.model_id}@${s.model_version}`, 'pbe-weather-maxtemp-intraday@2.2.0');
  assert.equal(s.model_state, 'SHADOW'); assert.equal(s.record_type, 'shadow'); assert.equal(s.public, false);
  assert.match(s.predictive_input_hash, /^[0-9a-f]{64}$/); assert.match(s.source_state_hash, /^[0-9a-f]{64}$/);
  assert.equal(s.station_id, 'CLINYC'); assert.equal(s.climate_date, '2026-10-04'); assert.equal(s.captured_at, '2026-10-04T20:05:00.000Z');
  assert.deepEqual([s.market_probability, s.market_snapshot_key, s.market_observed_at], [null, null, null]);
  assert.equal(JSON.stringify(s).includes('0.77'), false, 'the venue price never reaches a shadow row');
  assert.equal((await h.run('2026-10-04T20:05:00.000Z', src, true)).shadow.written, 0, 'retry at the same now');
  const r3 = await h.run('2026-10-04T20:09:00.000Z', src, true);
  assert.deepEqual([r3.shadow.written, r3.shadow.unchanged], [0, 1], 'clock tick only -> no row');
});

test('market leakage: different venue prices -> identical shadow rows', async () => {
  const c = await high('-B67.5');
  const rows = { rows: Array.from({ length: 15 }, (_, k) => metarRow(k)) };
  const a = await harness([c], rows, [{ contract_id: c.contract_id, snapshot_key: 'a', probability: 0.05, captured_at: '2026-10-04T18:00:00.000Z' }]);
  const b = await harness([c], rows, [{ contract_id: c.contract_id, snapshot_key: 'b', probability: 0.95, captured_at: '2026-10-04T19:59:00.000Z' }]);
  const src = { nbm: run12, mos: mos() };
  await a.run('2026-10-04T20:05:00.000Z', src, true); await b.run('2026-10-04T20:05:00.000Z', src, true);
  assert.equal(JSON.stringify(a.shadow), JSON.stringify(b.shadow));
  assert.notEqual(a.forecasts[0].market_probability, b.forecasts[0].market_probability, 'v2.1 rows still carry their (benchmark) venue price');
  const r = forecastIntradayShadow(c, { obs: engineObservationsV22(rows.rows, 'KNYC'), nbm: [run12, run06] }, { now: '2026-10-04T20:05:00.000Z' });
  await assert.rejects(shadowTableRow(c, { ...r, features: { ...r.features, kalshi_mid: 0.4 } }, { now: '2026-10-04T20:05:00.000Z', sourceStateHash: 'x' }), MarketLeakageError);
});

test('fail closed: no raw METAR text -> INCOMPLETE_OBSERVATIONS; NBM without TMP path -> INCOMPLETE_GUIDANCE; v2.1 unaffected', async () => {
  const c = await high('-B67.5');
  const noRaw = await harness([c], { rows: Array.from({ length: 15 }, (_, k) => metarRow(k, { raw: k !== 14 })) });
  const src = { nbm: run12, mos: mos() };
  const a = await noRaw.run('2026-10-04T20:05:00.000Z', src, true);
  assert.equal(a.shadow.written, 0); assert.equal(a.shadow.skipped.INCOMPLETE_OBSERVATIONS, 1);
  assert.equal(a.written, 1, 'v2.1 still writes');
  const noTmp = { ...run12, rows: run12.rows.map((r) => ({ ...r, tmp: null })) };
  const g = await harness([c], { rows: Array.from({ length: 15 }, (_, k) => metarRow(k)) });
  const b = await g.run('2026-10-04T20:05:00.000Z', { nbm: noTmp, mos: mos() }, true, iemFetch([]));
  assert.equal(b.shadow.written, 0); assert.equal(b.shadow.skipped.INCOMPLETE_GUIDANCE, 1);
  assert.equal(b.shadow.nbm_runs, 1, 'no prior cycle available: passed as-is, never invented');
});

test('priorNbmRun: exactly the cycle 6 h earlier, only if present and <= 24 h old', async () => {
  const p = await priorNbmRun(run12, '2026-10-04T20:05:00.000Z', { fetchImpl: iemFetch([run06]) });
  assert.equal(p.runtime, run06.runtime);
  assert.equal(await priorNbmRun(run12, '2026-10-05T07:00:00.000Z', { fetchImpl: iemFetch([run06]) }), null);
  assert.equal(await priorNbmRun(run12, '2026-10-04T20:05:00.000Z', { fetchImpl: iemFetch([]) }), null);
});
