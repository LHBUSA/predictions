// Prospective forward-validation lane for pbe-weather-maxtemp-intraday@2.2.0 (SHADOW). PURE module — not wired.
// Plan: docs/research/WEATHER_INTRADAY_V22_SHADOW_PLAN.md.
//
// The live caller (hot intraday lane) keeps writing v2.1 exactly as today. For the SAME contracts, SAME stored
// observations and SAME guidance it additionally calls forecastIntradayShadow(); when shadowWriteDecision() says so it
// inserts shadowForecastRow() (record_type 'shadow', model_state 'SHADOW', never public, own designation set).
// No market data is an input; the market snapshot keys a live row may carry are NOT copied onto shadow rows.
import { forecastIntraday } from './engine.js';
import './temp-v22.js'; // registers the 2.2.0 SHADOW artifact (opt-in; not bundled by the v2.1 production path)
import { canonicalJson } from '../../engine/evidence.js';
import { sha256Hex } from './sha256.js';

export const SHADOW_TEMP_MODEL_VERSION = '2.2.0';
export const SHADOW_DESIGNATION_RULES = 'designation-intraday-shadow/1';
export const SHADOW_LANE = 'hot-intraday-shadow';
export const SHADOW_MIN_RESOLVED_DAYS = 30;
export const SHADOW_MIN_STATIONS = 10;

// The one call the live caller makes. sources = { obs, nbm } where every obs row carries max6_f, wxcodes, sky
// (parseNwsObservationsV22 / parseMetarWeather on the stored raw METAR) and nbm runs carry rows[].tmp (IEM NBS JSON).
export function forecastIntradayShadow(contract, sources, { now }) {
  if (contract?.event_type !== 'MAX_TEMP_BUCKET') return { status: 'UNSUPPORTED_EVENT_TYPE' };
  const r = forecastIntraday(contract, { obs: sources?.obs || [], nbm: sources?.nbm }, { now, tempModelVersion: SHADOW_TEMP_MODEL_VERSION });
  if (r.status === 'OK' && r.model.state !== 'SHADOW') throw new Error('shadow lane: model state must be SHADOW');
  return r;
}

// predictive_input_hash: hash of what the probability is a function of (table cells for every level, M, anchor, the
// below-max cell, the contract range). Identical hash => identical probability. Wall clock never enters it.
export const shadowPredictiveHash = (r) => sha256Hex(canonicalJson(r.explanation.predictive_state));
// source_state_hash (audit only): the exact observations the model could use + the guidance runs it used.
export const shadowSourceStateHash = (r, contractId, obsUsed) => sha256Hex(canonicalJson({
  contract: contractId, model: `${r.model.id}@${r.model.version}`,
  obs: obsUsed.map((o) => [o.valid_at, o.tmpf, o.max6_f ?? null, o.wxcodes ?? null, o.sky ?? null]),
  guidance: (r.provenance || []).filter((p) => /model input/i.test(p.role || '') && p.run).map((p) => p.run).sort(),
}));

// Write-dedupe (Phase A semantics): write only when the PREDICTIVE state changed versus the newest prior shadow row for
// the same contract and model version. A changed source state with an unchanged predictive state is NOT written
// (counted as 'unchanged'); a clock tick is never by itself a reason to write.
export function shadowWriteDecision(priorRow, r) {
  if (r.status !== 'OK') return { write: false, reason: r.status };
  const hash = shadowPredictiveHash(r);
  if (priorRow && priorRow.explanation?.predictive_input_hash === hash) return { write: false, reason: 'UNCHANGED_PREDICTIVE_STATE', predictive_input_hash: hash };
  return { write: true, reason: priorRow ? 'PREDICTIVE_STATE_CHANGED' : 'FIRST_ROW', predictive_input_hash: hash };
}

// Immutable shadow forecast row. recordId is content-addressed by the predictive hash (not by the wall clock), so a
// retried cycle cannot create a duplicate row for the same predictive state.
export function shadowForecastRow(contract, r, { now, sourceStateHash, featureSnapshotId = null }) {
  if (r.status !== 'OK') throw new Error(`shadow row from non-OK result ${r.status}`);
  const pHash = shadowPredictiveHash(r);
  const recordId = `${contract.contract_id}|${r.model.id}@${r.model.version}|shadow|${pHash.slice(0, 24)}`;
  return {
    record_id: recordId, event_id: contract.event_id, contract_id: contract.contract_id, market_id: contract.market_id,
    model_id: r.model.id, model_version: r.model.version, model_state: 'SHADOW', record_type: 'shadow', public: false,
    designation_rules: SHADOW_DESIGNATION_RULES, probability: r.probability, captured_at: now, data_cutoff_at: r.dataCutoffAt,
    confidence: r.confidence, feature_snapshot_id: featureSnapshotId, provenance: r.provenance,
    market_probability: null, market_snapshot_key: null, market_observed_at: null, // never carried on shadow rows
    explanation: { ...r.explanation, evidence: r.evidence, raw_probability: r.rawProbability, input_hash: r.inputHash, predictive_input_hash: pHash, source_state_hash: sourceStateHash ?? null, lane: SHADOW_LANE },
    metadata: { domain: contract.domain ?? 'weather', event_type: contract.event_type, station_id: contract.station_id, observation_start: contract.observation_start, intraday: true, shadow: true },
  };
}

// ---- evaluation (run after >= SHADOW_MIN_RESOLVED_DAYS resolved climate days at >= SHADOW_MIN_STATIONS stations) ----
// rows: shadow (2.2.0) AND live (2.1.0) forecast rows, each { contract_id, model_version, captured_at, raw_probability|probability,
//   station_id, climate_date, observation_start, threshold_low, threshold_high, comparator }
// outcomes: Map/obj  `${station_id}|${climate_date}` -> final CLI max (integer degF)
// Each contract is scored at a FIXED grid (every whole hour 1..23 after window start) using the newest row captured at or
// before that time for each model, so write frequency cannot bias the comparison. Only grid points where BOTH models have
// a row are scored. Returns per-model Brier / log loss and the date-clustered bootstrap CI of (v2.1 - v2.2).
const inRange = (y, c) => (c.comparator === 'less' ? y < Number(c.threshold_high) : c.comparator === 'greater' ? y > Number(c.threshold_low) : y >= Number(c.threshold_low) && y <= Number(c.threshold_high));
export function shadowEvaluationReport(rows, outcomes, { boot = 1000, seed = 20261004, versions = ['2.1.0', '2.2.0'] } = {}) {
  const get = (k) => (outcomes instanceof Map ? outcomes.get(k) : outcomes[k]);
  const byContract = new Map();
  for (const r of rows) { if (!versions.includes(r.model_version)) continue; if (!byContract.has(r.contract_id)) byContract.set(r.contract_id, []); byContract.get(r.contract_id).push(r); }
  const pts = []; // { date, station, hour, p: {ver: p}, o }
  for (const [, list] of byContract) {
    const c = list[0]; const y = get(`${c.station_id}|${c.climate_date}`);
    if (y === undefined || y === null) continue;
    const o = inRange(y, c) ? 1 : 0; const S = Date.parse(c.observation_start);
    const sorted = [...list].sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
    for (let h = 1; h <= 23; h += 1) {
      const t = S + h * 3600000; const p = {};
      for (const v of versions) { let last = null; for (const r of sorted) { if (r.model_version !== v) continue; if (Date.parse(r.captured_at) <= t) last = r; else break; } if (last) p[v] = Math.min(0.99, Math.max(0.01, last.raw_probability ?? last.probability)); }
      if (versions.every((v) => p[v] !== undefined)) pts.push({ date: c.climate_date, station: c.station_id, hour: h, p, o });
    }
  }
  const dates = [...new Set(pts.map((x) => x.date))].sort(); const stations = new Set(pts.map((x) => x.station));
  const ready = dates.length >= SHADOW_MIN_RESOLVED_DAYS && stations.size >= SHADOW_MIN_STATIONS;
  const metric = { brier: (p, o) => (p - o) ** 2, logloss: (p, o) => -(o ? Math.log(p) : Math.log(1 - p)) };
  const out = { n_points: pts.length, resolved_days: dates.length, stations: stations.size, ready, min_resolved_days: SHADOW_MIN_RESOLVED_DAYS, min_stations: SHADOW_MIN_STATIONS, metrics: {} };
  const di = new Map(dates.map((d, i) => [d, i]));
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const draws = Array.from({ length: boot }, () => Array.from({ length: dates.length }, () => Math.floor(rnd() * dates.length)));
  const [base, cand] = versions;
  for (const [name, fn] of Object.entries(metric)) {
    const n = new Float64Array(dates.length); const a = new Float64Array(dates.length); const b = new Float64Array(dates.length);
    for (const x of pts) { const i = di.get(x.date); n[i] += 1; a[i] += fn(x.p[base], x.o); b[i] += fn(x.p[cand], x.o); }
    const N = n.reduce((u, v) => u + v, 0);
    const ds = draws.map((dr) => { let nn = 0; let aa = 0; let bb = 0; for (const k of dr) { nn += n[k]; aa += a[k]; bb += b[k]; } return nn ? (aa - bb) / nn : 0; }).sort((u, v) => u - v);
    out.metrics[name] = { [base]: N ? a.reduce((u, v) => u + v, 0) / N : null, [cand]: N ? b.reduce((u, v) => u + v, 0) / N : null, base_minus_candidate: N ? (a.reduce((u, v) => u + v, 0) - b.reduce((u, v) => u + v, 0)) / N : null, ci95: ds.length ? [ds[Math.floor(0.025 * ds.length)], ds[Math.max(0, Math.floor(0.975 * ds.length) - 1)]] : null };
  }
  out.forward_gate_passed = ready && ['brier', 'logloss'].every((k) => out.metrics[k].ci95 && out.metrics[k].ci95[0] > 0);
  return out;
}
