import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dueIntradayDesignations, standingForecast, referenceTime, benchmarkState, qualityState, intradayScoreRows, intradayScoreReport, designationKey, hourBucket, localStandardClock, probabilityBucket, INTRADAY_DESIGNATION_RULES, SETTLE_MS } from '../src/engine/intraday-designations.js';
import { dueDesignations } from '../src/engine/designations.js';
import { runIntradayScoring, intradayScoringDue } from '../workers/pbe-predictions/src/intraday-scoring.js';

const START = '2026-10-05T05:00:00.000Z'; // CDT station: local-standard midnight = 06:00Z; any start works for the rule
const END = '2026-10-06T05:00:00.000Z';
const C = { contract_id: 'c1', normalization_status: 'NORMALIZED', market_id: 'KXHIGHCHI-26OCT05-B70.5', event_type: 'MAX_TEMP_BUCKET', station_id: 'CLIMDW', observation_start: START, observation_end: END, detail: { climate_date: '2026-10-05' } };
const at = (h, m = 0) => new Date(Date.parse(START) + h * 3600000 + m * 60000).toISOString();
const F = (id, h, m = 0, extra = {}) => ({ forecast_id: id, contract_id: 'c1', model_id: 'pbe-weather-maxtemp-intraday', model_version: '2.1.0', record_type: 'live', probability: 0.3, market_probability: 0.4, market_observed_at: at(h, m - 1), market_snapshot_key: `k${id}`, captured_at: at(h, m), data_cutoff_at: at(h, m - 5), confidence: 'HIGH', ...extra });
const ROWS = [F('pre', -1), F('a', 1, 10), F('b', 2, 0), F('c', 2, 1), F('d', 11, 59), F('e', 12, 0), F('f', 23, 58), F('late', 24, 0)];

test('designation-intraday/1: fixed reference times and standing-forecast choice', () => {
  assert.equal(new Date(referenceTime('WINDOW_OPEN', C)).toISOString(), at(2));
  assert.equal(new Date(referenceTime('MIDDAY_LOCAL', C)).toISOString(), at(12));
  assert.equal(new Date(referenceTime('FINAL_INTRADAY', C)).toISOString(), END);
  assert.equal(new Date(referenceTime('FINAL_INTRADAY', C, at(20))).toISOString(), at(20)); // early resolution caps FINAL
  assert.equal(standingForecast('WINDOW_OPEN', C, ROWS).forecast.forecast_id, 'b'); // inclusive at R
  assert.equal(standingForecast('MIDDAY_LOCAL', C, ROWS).forecast.forecast_id, 'e');
  assert.equal(standingForecast('FINAL_INTRADAY', C, ROWS).forecast.forecast_id, 'f'); // strictly before end
  assert.equal(standingForecast('WINDOW_OPEN', C, [F('pre', -1)]), null); // pre-window rows never count
  // order of input rows is irrelevant
  assert.equal(standingForecast('MIDDAY_LOCAL', C, [...ROWS].reverse()).forecast.forecast_id, 'e');
});

test('designations are written only after reference + settle, once, keyed per model version', () => {
  const before = dueIntradayDesignations({ contract: C, forecasts: ROWS, now: new Date(Date.parse(at(2)) + SETTLE_MS - 1).toISOString() });
  assert.equal(before.rows.length, 0);
  const mid = dueIntradayDesignations({ contract: C, forecasts: ROWS, now: at(13) });
  assert.deepEqual(mid.rows.map((d) => d.designation), ['WINDOW_OPEN', 'MIDDAY_LOCAL']);
  assert.equal(mid.rows[0].designation_key, designationKey('c1', 'pbe-weather-maxtemp-intraday', '2.1.0', 'WINDOW_OPEN'));
  assert.equal(mid.rows[0].rule_version, INTRADAY_DESIGNATION_RULES);
  const all = dueIntradayDesignations({ contract: C, forecasts: ROWS, existing: mid.rows, now: at(30) });
  assert.deepEqual(all.rows.map((d) => d.designation), ['FINAL_INTRADAY']);
  // a second model version gets its own designations; shadow and pre-window rows never take one
  const mixed = [...ROWS, F('v2', 1, 30, { model_version: '2.2.0' }), F('sh', 1, 40, { record_type: 'shadow' }), F('pw', 1, 45, { model_id: 'pbe-weather-maxtemp' })];
  const r = dueIntradayDesignations({ contract: C, forecasts: mixed, now: at(30) });
  assert.deepEqual(r.rows.map((d) => `${d.model_version}:${d.designation}:${d.forecast_id}`), ['2.1.0:WINDOW_OPEN:b', '2.1.0:MIDDAY_LOCAL:e', '2.1.0:FINAL_INTRADAY:f', '2.2.0:WINDOW_OPEN:v2', '2.2.0:MIDDAY_LOCAL:v2', '2.2.0:FINAL_INTRADAY:v2']);
  assert.ok(!r.rows.some((d) => ['sh', 'pw'].includes(d.forecast_id)));
  // no standing forecast => reported missing, never substituted
  const late = dueIntradayDesignations({ contract: C, forecasts: [F('x', 5)], now: at(30) });
  assert.deepEqual(late.missing.map((m) => m.designation), ['WINDOW_OPEN']);
});

test('market leakage: market fields cannot change which forecast is designated or its PBE score', () => {
  const shifted = ROWS.map((f, i) => ({ ...f, market_probability: (i * 0.137) % 1, market_observed_at: at(-5), market_snapshot_key: `zz${i}` }));
  const a = dueIntradayDesignations({ contract: C, forecasts: ROWS, now: at(30) }).rows;
  const b = dueIntradayDesignations({ contract: C, forecasts: shifted, now: at(30) }).rows;
  assert.deepEqual(a.map((d) => [d.designation_key, d.forecast_id, d.reference_time]), b.map((d) => [d.designation_key, d.forecast_id, d.reference_time]));
  const res = { resolution_id: 'r1', contract_id: 'c1', venue_result: 'yes', sources_agree: true, official_outcome: 'YES' };
  const q = { state: 'OK', flags: [], station_obs_fresh: true };
  const fa = ROWS.find((f) => f.forecast_id === a[1].forecast_id); const fb = shifted.find((f) => f.forecast_id === b[1].forecast_id);
  const sa = intradayScoreRows({ designation: a[1], forecast: fa, contract: C, resolution: res, benchmark: 'VALID', quality: q });
  const sb = intradayScoreRows({ designation: b[1], forecast: fb, contract: C, resolution: res, benchmark: 'VALID', quality: q });
  assert.deepEqual(sa.map((x) => [x.score_key, x.pbe_probability, x.score, x.outcome]), sb.map((x) => [x.score_key, x.pbe_probability, x.score, x.outcome]));
  assert.notDeepEqual(sa.map((x) => x.benchmark_score), sb.map((x) => x.benchmark_score)); // only the benchmark moves
});

test('intraday rows never take designation/1 (pre-window) designations', () => {
  const src = readFileSync(new URL('../workers/pbe-predictions/src/cycle.js', import.meta.url), 'utf8');
  assert.match(src, /if \(\/-intraday\$\/\.test\(modelId\)\) continue;/);
  // and the intraday lane never writes the pre-window tables
  const lane = readFileSync(new URL('../workers/pbe-predictions/src/intraday-scoring.js', import.meta.url), 'utf8');
  assert.ok(!/'pred_scores'|'pred_forecast_designations'/.test(lane));
  assert.equal(typeof dueDesignations, 'function');
});

test('benchmark state: valid only with a fresh, error-free market collection before capture', () => {
  const f = F('b', 2, 0);
  const runOk = [{ at: at(1, 55), market_http_errors: 0, market_backoff_errors: 0 }];
  assert.equal(benchmarkState(f, { market_status: 'active' }, runOk), 'VALID');
  assert.equal(benchmarkState({ ...f, market_probability: null }, { market_status: 'active' }, runOk), 'NO_MARKET_PRICE');
  assert.equal(benchmarkState({ ...f, market_observed_at: at(2, 1) }, { market_status: 'active' }, runOk), 'MARKET_AFTER_FORECAST');
  assert.equal(benchmarkState(f, { market_status: 'closed' }, runOk), 'MARKET_NOT_ACTIVE');
  assert.equal(benchmarkState(f, { market_status: 'active' }, [{ at: at(1, 40), market_http_errors: 0 }]), 'MARKET_FEED_UNVERIFIED'); // > 10 min old
  assert.equal(benchmarkState(f, { market_status: 'active' }, [{ at: at(1, 58), market_http_errors: 2 }]), 'MARKET_FEED_UNVERIFIED');
  assert.equal(benchmarkState(f, { market_status: 'active' }, [{ at: at(2, 5), market_http_errors: 0 }]), 'MARKET_FEED_UNVERIFIED'); // after capture
});

test('quality state and score rows', () => {
  const d = { designation_key: 'k', designation: 'MIDDAY_LOCAL', model_id: 'pbe-weather-maxtemp-intraday', model_version: '2.1.0', forecast_id: 'e', reference_time: at(12), detail: { forecast_age_min: 0 } };
  assert.equal(qualityState({ designation: d, obsTimes: [Date.parse(at(11, 5))], resolution: { sources_agree: true } }).state, 'OK');
  assert.equal(qualityState({ designation: d, obsTimes: [Date.parse(at(10))], resolution: { sources_agree: true } }).state, 'SOURCE_GAP');
  assert.equal(qualityState({ designation: d, obsTimes: [Date.parse(at(11, 30))], resolution: { sources_agree: false } }).state, 'RESOLUTION_SOURCES_DISAGREE');
  const rows = intradayScoreRows({ designation: d, forecast: F('e', 12), contract: C, resolution: { resolution_id: 'r', venue_result: 'no' }, benchmark: 'NO_MARKET_PRICE', quality: { state: 'OK', flags: [], station_obs_fresh: true } });
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0].score - 0.09) < 1e-12);
  assert.ok(Math.abs(rows[1].score - -Math.log(0.7)) < 1e-12);
  assert.equal(rows[0].benchmark_score, null); assert.equal(rows[0].market_probability, null); // invalid benchmark never stored as a price
  assert.equal(rows[0].station_group, 'midwest_plains');
  assert.equal(rows[0].local_cutoff, '12:00 LST');
  assert.equal(hourBucket(C, at(12)), '07-12'); assert.equal(hourBucket(C, at(16, 59)), '13-16'); assert.equal(hourBucket(C, at(1)), '00-06');
  assert.equal(localStandardClock(C, at(2)), '02:00 LST');
  assert.equal(probabilityBucket(0.999), '90-100%'); assert.equal(probabilityBucket(0.05), '0-10%');
  assert.throws(() => intradayScoreRows({ designation: d, forecast: F('e', 12), contract: C, resolution: { venue_result: null }, benchmark: 'VALID', quality: {} }));
});

test('aggregate report slices', () => {
  const base = { contract_id: 'c1', model_id: 'm-intraday', model_version: '1', station_id: 'CLIMDW', station_group: 'midwest_plains', climate_date: '2026-10-05', hour_bucket: '07-12', calibration_bucket: '20-30%', quality_state: 'OK' };
  const rows = [
    { ...base, designation: 'MIDDAY_LOCAL', scoring_method: 'brier', pbe_probability: 0.3, outcome: 0, score: 0.09, benchmark_state: 'VALID', benchmark_score: 0.16 },
    { ...base, designation: 'MIDDAY_LOCAL', scoring_method: 'log_loss', pbe_probability: 0.3, outcome: 0, score: 0.357, benchmark_state: 'VALID', benchmark_score: 0.51 },
    { ...base, contract_id: 'c2', designation: 'FINAL_INTRADAY', scoring_method: 'brier', pbe_probability: 0.9, outcome: 1, score: 0.01, benchmark_state: 'NO_MARKET_PRICE', benchmark_score: null },
    { ...base, contract_id: 'c2', designation: 'FINAL_INTRADAY', scoring_method: 'log_loss', pbe_probability: 0.9, outcome: 1, score: 0.105, benchmark_state: 'NO_MARKET_PRICE', benchmark_score: null },
  ];
  const r = intradayScoreReport(rows);
  assert.equal(r.overall.n, 2); assert.equal(r.overall.benchmark_n, 1);
  assert.ok(Math.abs(r.overall.pbe_brier - 0.05) < 1e-12);
  assert.ok(Math.abs(r.overall.paired.market_brier - 0.16) < 1e-12);
  for (const k of ['model_version', 'designation', 'station', 'station_group', 'hour_bucket', 'calibration_bucket']) assert.ok(Array.isArray(r.by[k]) && r.by[k].length >= 1, k);
  assert.equal(r.by.designation.length, 2);
});

// ---- end to end over a fake ledger ----
function fakeStore(tables) {
  const writes = [];
  const match = (rows, query) => rows.filter((r) => Object.entries(query || {}).every(([k, v]) => {
    if (k === 'select' || k === 'and') return true;
    if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(r[k]));
    if (v.startsWith('like.')) { const re = new RegExp(`^${v.slice(5).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`); return re.test(String(r[k])); }
    return true;
  }));
  return {
    writes,
    async select(t, q) { return match(tables[t] || [], q); },
    async selectIn(t, q, col, ids) { return match(tables[t] || [], q).filter((r) => ids.includes(r[col])); },
    async insertMany(t, rows, conflict) { writes.push({ t, n: rows.length }); tables[t] ||= []; for (const r of rows) if (!tables[t].some((x) => x[conflict] === r[conflict])) tables[t].push(r); },
  };
}

test('lane end to end: designates, scores into intraday tables only, idempotent on re-run', async () => {
  const tables = {
    pred_contracts: [C],
    pred_forecasts: ROWS,
    pred_resolutions: [{ resolution_id: 'r1', contract_id: 'c1', venue_result: 'no', resolved_at: at(30), official_outcome: 'NO', sources_agree: true }],
    pred_intraday_designations: [], pred_intraday_scores: [],
    pred_venue_snapshots: ROWS.map((f) => ({ snapshot_key: f.market_snapshot_key, market_status: 'active' })),
    pred_engine_runs: [{ lane: 'core', transition: 'COMPLETED', at: at(11, 55), counts: { market_http_errors: 0, market_backoff_errors: 0 } }],
    pred_source_observations: [{ observed_at: at(10, 51), available_at: at(11, 1), source_id: 'asos:KMDW:x' }, { observed_at: at(1, 51), available_at: at(1, 59), source_id: 'asos:KMDW:y' }],
  };
  const store = fakeStore(tables);
  const dry = await runIntradayScoring(store, { now: at(31), dryRun: true });
  assert.equal(store.writes.length, 0);
  assert.equal(dry.designations_written, 3);
  const r1 = await runIntradayScoring(store, { now: at(31) });
  assert.equal(r1.designations_written, 3); assert.equal(r1.scores_written, 6);
  assert.deepEqual([...new Set(store.writes.map((w) => w.t))].sort(), ['pred_intraday_designations', 'pred_intraday_scores']);
  const mid = tables.pred_intraday_scores.find((s) => s.designation === 'MIDDAY_LOCAL' && s.scoring_method === 'brier');
  assert.equal(mid.benchmark_state, 'VALID'); assert.equal(mid.quality_state, 'OK');
  assert.equal(tables.pred_intraday_scores.find((s) => s.designation === 'FINAL_INTRADAY').quality_state, 'SOURCE_GAP'); // no ob in the 90 min before 24:00
  const wo = tables.pred_intraday_scores.find((s) => s.designation === 'WINDOW_OPEN');
  assert.equal(wo.benchmark_state, 'MARKET_FEED_UNVERIFIED'); assert.equal(wo.benchmark_score, null);
  const r2 = await runIntradayScoring(store, { now: at(32) });
  assert.equal(r2.work_contracts, 0); assert.equal(r2.designations_written, 0); assert.equal(r2.scores_written, 0);
  assert.ok(intradayScoringDue('2026-10-07T12:04:00Z') && intradayScoringDue('2026-10-07T12:34:00Z') && !intradayScoringDue('2026-10-07T12:05:00Z'));
});
