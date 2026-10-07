// Intraday scoring designations (designation-intraday/1) — FROZEN 2026-10-07. Separate from designation/1: intraday
// rows never take pre-window designations, and these designations/scores live in their own tables
// (pred_intraday_designations / pred_intraday_scores, sql/013), so they can never enter the pre-window track record.
//
// Which forecast counts is fixed by rule from capture times only (never outcomes, never market prices):
//   WINDOW_OPEN     the standing forecast at observation_start + 2 h  (02:00 local standard time)
//   MIDDAY_LOCAL    the standing forecast at observation_start + 12 h (12:00 local standard time)
//   FINAL_INTRADAY  the latest forecast captured strictly before min(observation_end, resolved_at)
// "Standing forecast at R" = the newest row of the same (contract, model_id, model_version) captured inside the window
// at or before R. Intraday rows are written only when the predictive state changes, so the newest row at R IS the
// forecast in force at R. A designation is written only once R + SETTLE_MS has passed (a row inserted late with an
// earlier captured_at can then no longer change the choice). No standing forecast at R => no designation (reported as
// coverage, never substituted).
//
// Benchmark (same-time market): the venue mid stored on the designated forecast row at its capture. VALID only when
//   - the row carries a market probability observed at or before capture (mid exists only when spread <= 10c),
//   - that venue snapshot was 'active',
//   - a core engine run COMPLETED within MARKET_FRESH_MS before capture with zero market HTTP/backoff errors
//     (venue snapshots are change-only, so an old observed_at is the current price only if the collector was running).
// Otherwise the PBE score is stored and the benchmark is null with an explicit benchmark_state.
import { brierScore, logLoss } from '../scoring.js';
import { stationGroup } from '../weather/intraday/models.js';

export const INTRADAY_DESIGNATION_RULES = 'designation-intraday/1';
export const INTRADAY_DESIGNATIONS = Object.freeze(['WINDOW_OPEN', 'MIDDAY_LOCAL', 'FINAL_INTRADAY']);
const OFFSET_H = Object.freeze({ WINDOW_OPEN: 2, MIDDAY_LOCAL: 12 });
export const SETTLE_MS = 10 * 60000;
export const MARKET_FRESH_MS = 10 * 60000;
export const SOURCE_GAP_MS = 90 * 60000; // no exact-station observation available in the 90 min before R => SOURCE_GAP
export const BENCHMARK_STATES = Object.freeze(['VALID', 'NO_MARKET_PRICE', 'MARKET_AFTER_FORECAST', 'MARKET_NOT_ACTIVE', 'MARKET_FEED_UNVERIFIED']);
export const isIntradayModel = (modelId) => /-intraday$/.test(String(modelId || ''));
const H = 3600000;

export const designationKey = (contractId, modelId, modelVersion, designation) => `${contractId}|${modelId}@${modelVersion}|${designation}`;

// Reference time (ms) of a designation, or null if the window bounds are missing.
export function referenceTime(designation, contract, resolvedAt = null) {
  const start = Date.parse(contract.observation_start); const end = Date.parse(contract.observation_end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (designation === 'FINAL_INTRADAY') return Math.min(end, resolvedAt ? Date.parse(resolvedAt) : Infinity);
  return start + OFFSET_H[designation] * H;
}

// Standing forecast for one designation from rows of ONE (contract, model_id, model_version), any order.
export function standingForecast(designation, contract, rows, resolvedAt = null) {
  const ref = referenceTime(designation, contract, resolvedAt);
  if (ref === null) return null;
  const start = Date.parse(contract.observation_start);
  const strict = designation === 'FINAL_INTRADAY';
  let best = null;
  for (const f of rows) {
    const t = Date.parse(f.captured_at);
    if (t < start || (strict ? t >= ref : t > ref)) continue;
    if (!best || t > Date.parse(best.captured_at) || (t === Date.parse(best.captured_at) && String(f.forecast_id) > String(best.forecast_id))) best = f;
  }
  return best ? { forecast: best, reference_time: new Date(ref).toISOString() } : null;
}

// Due designations for one contract. forecasts: live intraday rows of this contract (any models/versions);
// existing: designation rows already stored (designation_key). Returns { rows, missing }.
export function dueIntradayDesignations({ contract, forecasts, existing = [], now, resolvedAt = null, backfill = false }) {
  const nowMs = Date.parse(now);
  const have = new Set(existing.map((d) => d.designation_key));
  const groups = new Map();
  for (const f of forecasts) {
    if (f.contract_id !== contract.contract_id || !isIntradayModel(f.model_id) || (f.record_type && f.record_type !== 'live')) continue;
    const k = `${f.model_id}@${f.model_version}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const rows = []; const missing = [];
  for (const [, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const { model_id: modelId, model_version: version } = list[0];
    for (const designation of INTRADAY_DESIGNATIONS) {
      const key = designationKey(contract.contract_id, modelId, version, designation);
      if (have.has(key)) continue;
      const ref = referenceTime(designation, contract, resolvedAt);
      if (ref === null || nowMs < ref + SETTLE_MS) continue;
      const s = standingForecast(designation, contract, list, resolvedAt);
      if (!s) { missing.push({ designation_key: key, designation, model_id: modelId, model_version: version, reference_time: new Date(ref).toISOString() }); continue; }
      rows.push({
        designation_key: key, contract_id: contract.contract_id, model_id: modelId, model_version: version, designation,
        forecast_id: s.forecast.forecast_id, rule_version: INTRADAY_DESIGNATION_RULES, reference_time: s.reference_time,
        forecast_captured_at: new Date(Date.parse(s.forecast.captured_at)).toISOString(), backfilled: Boolean(backfill),
        detail: { forecast_age_min: +((Date.parse(s.reference_time) - Date.parse(s.forecast.captured_at)) / 60000).toFixed(2), observation_start: contract.observation_start, observation_end: contract.observation_end, resolved_at: resolvedAt ?? null },
      });
    }
  }
  return { rows, missing };
}

// ---- score-row helpers ----
const pad = (n) => String(n).padStart(2, '0');
// Local standard clock of an instant (the CLI window starts at local-standard midnight).
export function localStandardClock(contract, iso) {
  const h = (Date.parse(iso) - Date.parse(contract.observation_start)) / H;
  const hh = Math.floor(h); const mm = Math.floor((h - hh) * 60 + 1e-9);
  return `${pad(hh)}:${pad(mm)} LST`;
}
export function hourBucket(contract, iso) {
  const h = Math.floor((Date.parse(iso) - Date.parse(contract.observation_start)) / H);
  return h < 7 ? '00-06' : h < 13 ? '07-12' : h < 17 ? '13-16' : '17-23';
}
export function probabilityBucket(p) {
  const i = Math.min(9, Math.max(0, Math.floor(Number(p) * 10)));
  return `${i * 10}-${i * 10 + 10}%`;
}

// Benchmark state for one designated forecast (see header). venue: { market_status } of its stored snapshot or null;
// runs: COMPLETED core runs { at, market_http_errors, market_backoff_errors }.
export function benchmarkState(forecast, venue, runs) {
  if (forecast.market_probability === null || forecast.market_probability === undefined || !forecast.market_observed_at) return 'NO_MARKET_PRICE';
  const cap = Date.parse(forecast.captured_at);
  if (Date.parse(forecast.market_observed_at) > cap) return 'MARKET_AFTER_FORECAST';
  if (!venue || String(venue.market_status || '').toLowerCase() !== 'active') return 'MARKET_NOT_ACTIVE';
  const ok = runs.some((r) => { const t = Date.parse(r.at); return t <= cap && cap - t <= MARKET_FRESH_MS && !Number(r.market_http_errors || 0) && !Number(r.market_backoff_errors || 0); });
  return ok ? 'VALID' : 'MARKET_FEED_UNVERIFIED';
}

// Source/data-quality state at the designation's reference time. obsTimes: available_at (ms) of exact-station
// observations; resolution: the stored pred_resolutions row.
export function qualityState({ designation, obsTimes, resolution }) {
  const ref = Date.parse(designation.reference_time);
  const fresh = obsTimes.some((t) => t <= ref && ref - t <= SOURCE_GAP_MS);
  const flags = [];
  if (!fresh) flags.push('SOURCE_GAP');
  if (resolution?.sources_agree === false) flags.push('RESOLUTION_SOURCES_DISAGREE');
  if (resolution?.sources_agree === null || resolution?.sources_agree === undefined) flags.push('OFFICIAL_UNVERIFIED');
  return { state: flags.length ? flags[0] : 'OK', flags, station_obs_fresh: fresh };
}

// Two immutable score rows (brier, log_loss) for one designation of a resolved contract.
export function intradayScoreRows({ designation, forecast, contract, resolution, benchmark, quality }) {
  if (!['yes', 'no'].includes(resolution.venue_result)) throw new Error('intraday score needs a settled venue result');
  if (forecast.forecast_id !== designation.forecast_id) throw new Error('designation/forecast mismatch');
  const outcome = resolution.venue_result === 'yes' ? 1 : 0;
  const p = Number(forecast.probability);
  const valid = benchmark === 'VALID';
  const m = valid ? Number(forecast.market_probability) : null;
  const common = {
    designation_key: designation.designation_key, forecast_id: forecast.forecast_id, resolution_id: resolution.resolution_id,
    contract_id: contract.contract_id, model_id: designation.model_id, model_version: designation.model_version, designation: designation.designation,
    pbe_probability: p, outcome, market_probability: m, market_observed_at: valid ? forecast.market_observed_at : null, benchmark_state: benchmark,
    station_id: contract.station_id, station_group: stationGroup(contract.station_id), climate_date: contract.detail?.climate_date ?? null,
    local_cutoff: localStandardClock(contract, designation.reference_time), hour_bucket: hourBucket(contract, forecast.captured_at),
    calibration_bucket: probabilityBucket(p), quality_state: quality.state,
    data_quality: { flags: quality.flags, station_obs_fresh: quality.station_obs_fresh, forecast_age_min: designation.detail?.forecast_age_min ?? null, data_cutoff_at: forecast.data_cutoff_at ?? null, confidence: forecast.confidence ?? null, official_outcome: resolution.official_outcome ?? null, sources_agree: resolution.sources_agree ?? null },
    details: { rules: INTRADAY_DESIGNATION_RULES, scored_on: 'venue settlement', benchmark: 'venue mid stored on the forecast row at capture', event_type: contract.event_type, forecast_captured_at: forecast.captured_at, reference_time: designation.reference_time },
  };
  return [['brier', brierScore], ['log_loss', logLoss]].map(([method, fn]) => {
    const score = fn(p, outcome); const bench = m === null ? null : fn(m, outcome);
    return { ...common, score_key: `${designation.designation_key}|${method}`, scoring_method: method, score, benchmark_score: bench, improvement: bench === null ? null : bench - score };
  });
}

// ---- aggregate report (pure; rows = pred_intraday_scores) ----
const mean = (a) => (a.length ? a.reduce((u, v) => u + v, 0) / a.length : null);
function summarize(rows) {
  const b = rows.filter((r) => r.scoring_method === 'brier'); const l = rows.filter((r) => r.scoring_method === 'log_loss');
  const bv = b.filter((r) => r.benchmark_state === 'VALID'); const lv = l.filter((r) => r.benchmark_state === 'VALID');
  const num = (r, k) => Number(r[k]);
  return {
    n: b.length, contracts: new Set(b.map((r) => r.contract_id)).size, climate_days: new Set(b.map((r) => r.climate_date)).size, stations: new Set(b.map((r) => r.station_id)).size,
    yes_rate: mean(b.map((r) => num(r, 'outcome'))), mean_p: mean(b.map((r) => num(r, 'pbe_probability'))),
    pbe_brier: mean(b.map((r) => num(r, 'score'))), pbe_log_loss: mean(l.map((r) => num(r, 'score'))),
    benchmark_n: bv.length,
    paired: bv.length ? { pbe_brier: mean(bv.map((r) => num(r, 'score'))), market_brier: mean(bv.map((r) => num(r, 'benchmark_score'))), pbe_log_loss: mean(lv.map((r) => num(r, 'score'))), market_log_loss: mean(lv.map((r) => num(r, 'benchmark_score'))) } : null,
    quality_ok: b.filter((r) => r.quality_state === 'OK').length,
  };
}
const groupBy = (rows, keyFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, list]) => ({ key: k, ...summarize(list) })); };
export function intradayScoreReport(rows, { coverage = null } = {}) {
  const mv = (r) => `${r.model_id}@${r.model_version}`;
  const dims = {
    model_version: (r) => mv(r),
    designation: (r) => `${mv(r)} | ${r.designation}`,
    station: (r) => `${mv(r)} | ${r.station_id}`,
    station_group: (r) => `${mv(r)} | ${r.station_group}`,
    hour_bucket: (r) => `${mv(r)} | ${r.hour_bucket}`,
    calibration_bucket: (r) => `${mv(r)} | ${r.calibration_bucket}`,
    benchmark_state: (r) => `${mv(r)} | ${r.benchmark_state}`,
    quality_state: (r) => `${mv(r)} | ${r.quality_state}`,
  };
  const out = { rules: INTRADAY_DESIGNATION_RULES, rows: rows.length, scored_designations: rows.filter((r) => r.scoring_method === 'brier').length, overall: summarize(rows), by: {} };
  for (const [name, fn] of Object.entries(dims)) out.by[name] = groupBy(rows, fn);
  if (coverage) out.coverage = coverage;
  out.note = 'Prospective intraday forecasts only (captured live by the hot lane). Market benchmark = scoring only; never a model input. Small samples: descriptive, not a gate.';
  return out;
}
