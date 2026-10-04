// Freshness pass: METAR facts at full precision, observation rows are point-in-time (available_at = first seen),
// station summary (high so far incl. 6-hour max groups wholly inside the window; routine-METAR precip), the frozen
// pre-window label, and the one-minute cron keeps the BTC branch shape (hot lane independent, never runCycle).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMetar, observationRow, cToF, HOT_LANE_MAX_SUBREQUESTS, runHotLane } from '../workers/pbe-predictions/src/hot-lane.js';
import { stationSummary, liveForOutcome, freshnessOf, windowState } from '../workers/pbe-predictions/src/live-state.js';

const raw = 'KPHL 041454Z 06009KT 4SM -RA BR BKN013 OVC025 17/15 A3022 RMK AO2 SLP233 P0004 60005 T01670150 58002 $';

test('METAR parser: tenths °C, hourly/6-hour precip; negative temps', () => {
  const m = parseMetar(raw);
  assert.deepEqual([m.temp_c, m.dewpoint_c, m.precip_hour_in, m.precip_6h_in], [16.7, 15, 0.04, 0.05]);
  assert.equal(parseMetar('KDEN 041553Z 00000KT RMK AO2 T10221044 11011 21033').temp_c, -2.2);
  assert.equal(parseMetar('KDEN 041553Z RMK AO2 T10221044 11011 21033').max6_c, -1.1);
  assert.equal(cToF(16.7), 62.1);
});

test('observation row: immutable key by station+valid time, available_at = when PBE first saw it (never the valid time)', () => {
  const f = { properties: { timestamp: '2026-10-04T14:54:00+00:00', rawMessage: raw, temperature: { value: 16.7, qualityControl: 'V' } } };
  const r = observationRow(f, { icao: 'KPHL', cli: 'CLIPHL', seenAt: '2026-10-04T17:30:00.000Z', url: 'u' });
  assert.equal(r.observation_key, 'NWS api.weather.gov (ASOS/METAR):asos:KPHL:2026-10-04T14:54:00.000Z');
  assert.deepEqual([r.observed_at, r.available_at, r.captured_at, r.source_class], ['2026-10-04T14:54:00.000Z', '2026-10-04T17:30:00.000Z', '2026-10-04T17:30:00.000Z', 'official']);
  assert.equal(r.data.temp_c_precision, 0.1);
  const fivemin = observationRow({ properties: { timestamp: '2026-10-04T16:55:00+00:00', rawMessage: '', temperature: { value: 16 } } }, { icao: 'KPHL', cli: 'CLIPHL', seenAt: 'x', url: 'u' });
  assert.equal(fivemin.data.temp_c_precision, 1);
});

test('station summary: high so far, latest, routine-METAR precip, freshness; future-seen rows excluded', () => {
  const row = (t, d, seen = '2026-10-04T17:00:00.000Z') => ({ observed_at: t, available_at: seen, data: d });
  const rows = [
    row('2026-10-04T05:54:00.000Z', { temp_f: 63.0, temp_c_precision: 0.1, metar: true, raw_message: 'KPHL 040554Z RMK P0001', precip_hour_in: 0.01 }),
    row('2026-10-04T11:54:00.000Z', { temp_f: 61.0, temp_c_precision: 0.1, max6_f: 64.2, metar: true, raw_message: 'KPHL 041154Z RMK P0002', precip_hour_in: 0.02 }),
    row('2026-10-04T12:28:00.000Z', { temp_f: 62.0, temp_c_precision: 0.1, metar: true, raw_message: 'KPHL 041228Z RMK P0003', precip_hour_in: 0.03 }), // special: not summed
    row('2026-10-04T16:55:00.000Z', { temp_f: 60.8, temp_c_precision: 1, metar: false }),
    row('2026-10-04T17:10:00.000Z', { temp_f: 70.0, temp_c_precision: 0.1, metar: true }, '2026-10-04T18:00:00.000Z'), // not yet seen at "now"
  ];
  const s = stationSummary(rows, { start: '2026-10-04T05:00:00.000Z', end: '2026-10-05T05:00:00.000Z', now: '2026-10-04T17:20:00.000Z' });
  assert.equal(s.n, 4);
  assert.deepEqual([s.max_so_far.temp_f, s.max_so_far.basis], [64.2, '6-hour maximum group']);
  assert.equal(s.latest.temp_f, 60.8);
  assert.equal(s.precip_so_far_in, 0.03);
  assert.equal(s.precip_measurable, true);
  assert.equal(s.freshness.label, 'CURRENT');
  assert.equal(freshnessOf('observation', '2026-10-04T12:00:00Z', '2026-10-04T17:20:00Z').label, 'STALE');
});

test('pre-window forecast is labelled FROZEN once the window opens; not before', () => {
  const c = { station_id: 'CLIPHL', observation_start: '2026-10-04T05:00:00.000Z', observation_end: '2026-10-05T05:00:00.000Z' };
  const call = { published_at: '2026-10-03T23:00:09.000Z' };
  assert.equal(liveForOutcome(c, call, new Map(), '2026-10-03T23:30:00Z').pbe_frozen, null);
  assert.equal(liveForOutcome(c, call, new Map(), '2026-10-04T17:00:00Z').pbe_frozen.frozen_at, call.published_at);
  assert.equal(windowState(c, '2026-10-05T06:00:00Z').state, 'WINDOW_CLOSED');
});

test('hot lane: nothing new = nothing written; only new observations are inserted; budget hard-capped', async () => {
  const contracts = [{ contract_id: 'c', event_id: 'e', station_id: 'CLIPHL', event_type: 'MAX_TEMP_BUCKET', observation_start: '2026-10-04T05:00:00.000Z', observation_end: '2026-10-05T05:00:00.000Z' }];
  const stored = [];
  const store = {
    select: async (t) => (t === 'pred_contracts' ? contracts : stored.map((r) => ({ observation_key: r.observation_key }))),
    insertObservations: async (rows) => { stored.push(...rows); },
  };
  const feats = [{ properties: { timestamp: '2026-10-04T14:54:00+00:00', rawMessage: raw, temperature: { value: 16.7 } } }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ features: feats }) });
  const r1 = await runHotLane({}, { store, now: '2026-10-04T17:30:00.000Z', fetchImpl, force: true });
  assert.equal(r1.new_observations, 1);
  const r2 = await runHotLane({}, { store, now: '2026-10-04T17:31:00.000Z', fetchImpl, force: true });
  assert.equal(r2.new_observations, 0, 'identical upstream -> no write');
  assert.equal(stored.length, 1);
  assert.ok(r1.subrequests <= HOT_LANE_MAX_SUBREQUESTS && HOT_LANE_MAX_SUBREQUESTS <= 300);
});

test('one-minute cron: hot lane is independent of the BTC gate, has its own catch, never runs the engine cycle', () => {
  const src = readFileSync(new URL('../workers/pbe-predictions/src/index.js', import.meta.url), 'utf8');
  const sched = src.slice(src.indexOf('async scheduled('), src.indexOf('async fetch('));
  const oneMin = sched.slice(0, sched.indexOf("if (env.ENGINE_ENABLED !== 'true') return;"));
  assert.ok(oneMin.indexOf("env.HOT_LANE === 'true'") < oneMin.indexOf("CRYPTO_SHADOW !== 'true') return;"), 'hot lane before the BTC gate');
  assert.match(oneMin, /runHotLane\([\s\S]*?\.catch\(/);
  assert.ok(!/runCycle/.test(oneMin));
});

test('intraday models never take pre-window designations (designation/1) — static guard in the cycle', () => {
  const src = readFileSync(new URL('../workers/pbe-predictions/src/cycle.js', import.meta.url), 'utf8');
  const loop = src.slice(src.indexOf('for (const [modelId, list] of byModel)'), src.indexOf('dueDesignations({'));
  assert.match(loop, /if \(\/-intraday\$\/\.test\(modelId\)\) continue;/);
});
