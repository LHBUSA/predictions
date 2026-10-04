// LIVE INTRADAY forecasts (Weather Intraday V2, validated RESEARCH — docs/research/WEATHER_INTRADAY_V2_EVIDENCE.md).
// Called by the hot lane when NEW exact-station observations were stored for a station. For every open-window contract
// at that station: run the intraday model on stored observations (METAR / specials only — the training distribution)
// + the latest usable guidance; append an immutable forecast ONLY when the model's inputHash changed.
// Pre-window v1.x forecasts are never touched; intraday rows take no pre-window designations (cycle.js guard).
// Point in time: each observation's available_at is when PBE first saw it (never earlier than valid + 10 min).
import { forecastIntraday, INTRADAY_MODELS } from '../../../src/weather/intraday/engine.js';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { sha256Hex } from '../../../src/engine/contracts.js';
import { assertMarketFree } from '../../../src/engine/leakage.js';
import { weatherSources } from './cycle.js';
import { canonicalJson } from '../../../src/engine/evidence.js';

// THREE STATES (Phase A, owner 2026-10-04) — never one hash with three meanings:
//   source state     = the exact-station observations the model can use + the guidance runs it actually used
//                      (source_state_hash; audit only)
//   predictive state = only what can legitimately change the forecast (predictive_input_hash; DECIDES whether a new
//                      immutable forecast row is written)
//   presentation     = wall clock / "x min ago" / freshness labels — can never by itself manufacture a forecast row.
// Rain (precip-intraday 2.0.0): continuous clock-derived inputs (hours into window, hours remaining, remaining PoP) and
// the raw report count are replaced by the model's discrete local-standard-hour bucket — and only on the branch that
// uses time (logistic). On the measured_bound branch time cannot move the forecast, so the bucket is not part of it.
// Temperature (maxtemp-intraday 2.1.0): unchanged, its existing inputHash semantics (byte-identical behaviour).
export const RAIN_MODEL_ID = 'pbe-weather-precip-intraday';
const RAIN_CONTINUOUS_TIME = Object.freeze(['obs_count', 'hours_into_window_lst', 'hours_remaining', 'remaining_pop']);
export function predictiveState(modelId, features, provenance, branch) {
  if (modelId !== RAIN_MODEL_ID) return null;
  const f = { ...(features || {}) };
  const hourBucket = Math.floor(Number(f.hours_into_window_lst));
  for (const k of RAIN_CONTINUOUS_TIME) delete f[k];
  const runs = (provenance || []).filter((p) => /model input/i.test(p.role || '') && p.run).map((p) => p.run).sort();
  return { model: modelId, branch: branch ?? null, features: f, guidance_runs: runs, lst_hour_bucket: branch === 'measured_bound' ? null : hourBucket };
}
export const predictiveHash = async (state) => (state ? sha256Hex(canonicalJson(state)) : null);
export const sourceStateHash = (c, obsUsed, provenance) => sha256Hex(canonicalJson({ contract: c.contract_id, obs: obsUsed.map((o) => [o.valid_at, o.tmpf, o.p01i, o.max6_f ?? null]),
  guidance: (provenance || []).filter((p) => /model input/i.test(p.role || '') && p.run).map((p) => p.run).sort() }));

const LAG_MS = 10 * 60000; // research publication-lag floor
export const TEMP_MODEL_VERSION = '2.1.0';
const latestBy = (rows, key, time) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k) || m.get(k)[time] < r[time]) m.set(k, r); } return m; };

export function engineObservations(rows, icao) {
  return rows.filter((r) => r.data?.metar && r.data.temp_f !== null && r.data.temp_f !== undefined)
    .map((r) => ({ station: icao, valid_at: new Date(r.observed_at).toISOString(), available_at: new Date(Math.max(Date.parse(r.available_at), Date.parse(r.observed_at) + LAG_MS)).toISOString(), tmpf: r.data.temp_f, p01i: r.data.precip_hour_in ?? null, max6_f: r.data.max6_f ?? null, trace: false }))
    .sort((a, b) => a.valid_at.localeCompare(b.valid_at));
}

export async function intradayForStation(store, st, { now, fetchImpl = globalThis.fetch, spend = () => {}, sources = null } = {}) {
  const out = { station: st.icao, considered: 0, written: 0, unchanged: 0, skipped: {} };
  const ids = st.contracts.filter((c) => Date.parse(c.observation_start) <= Date.parse(now) && Date.parse(now) < Date.parse(c.observation_end)).map((c) => c.contract_id);
  if (!ids.length) return out;
  spend(); const contracts = [...latestBy(await store.selectIn('pred_contracts', { select: '*' }, 'contract_id', ids), 'market_id', 'normalized_at').values()];
  spend(); const obsRows = await store.select('pred_source_observations', { select: 'observed_at,available_at,data', source_id: `like.asos:${st.icao}:*`, observed_at: `gte.${st.start}` }, { order: 'observed_at.asc' });
  const obs = engineObservations(obsRows, st.icao);
  const station = CLI_STATIONS[st.cli];
  let src = sources;
  if (!src) { spend(4); src = await weatherSources(station, { fetchImpl, now }); }
  const cids = contracts.map((c) => c.contract_id);
  const modelIds = [...new Set(Object.values(INTRADAY_MODELS).map((m) => m.id))];
  spend(); const prior = await store.selectIn('pred_forecasts', { select: 'contract_id,model_id,captured_at,explanation,provenance,feature_snapshot_id', model_id: `in.(${modelIds.join(',')})` }, 'contract_id', cids, { order: 'captured_at.desc' });
  // predictive state of the latest prior RAIN row (recomputed from its stored features when the row predates Phase A)
  const lastRain = []; const seenRain = new Set(); // newest prior rain row per contract (prior is newest-first)
  for (const p of prior) if (p.model_id === RAIN_MODEL_ID && !seenRain.has(p.contract_id)) { seenRain.add(p.contract_id); lastRain.push(p); }
  const needFeat = lastRain.filter((p) => !p.explanation?.predictive_input_hash).map((p) => p.feature_snapshot_id).filter(Boolean);
  if (needFeat.length) spend();
  const priorFeat = needFeat.length ? new Map((await store.selectIn('pred_feature_snapshots', { select: 'snapshot_id,features' }, 'snapshot_id', needFeat)).map((x) => [x.snapshot_id, x.features])) : new Map();
  const priorPredictive = async (p) => p.explanation?.predictive_input_hash ?? predictiveHash(predictiveState(p.model_id, priorFeat.get(p.feature_snapshot_id), p.provenance, p.explanation?.branch));
  spend(); const venue = latestBy((await store.selectIn('pred_venue_snapshots', { select: 'contract_id,snapshot_key,probability,captured_at', captured_at: `lte.${now}` }, 'contract_id', cids)), 'contract_id', 'captured_at');
  const features = []; const forecasts = [];
  for (const c of contracts) {
    out.considered += 1;
    // max temp: v2.1.0 (adds the official METAR 6-hour maximum group; validated RESEARCH); rain: v2.0.0
    const r = forecastIntraday(c, { obs, nbm: src.nbm, mos: src.mos }, { now, tempModelVersion: TEMP_MODEL_VERSION });
    if (r.status !== 'OK') { out.skipped[r.status] = (out.skipped[r.status] || 0) + 1; continue; }
    const last = prior.find((p) => p.contract_id === c.contract_id && p.model_id === r.model.id);
    const pState = predictiveState(r.model.id, r.features, r.provenance, r.explanation?.branch);
    const pHash = await predictiveHash(pState);
    if (pState) { // rain: write only when the PREDICTIVE state changed
      if (last && (await priorPredictive(last)) === pHash) { out.unchanged += 1; continue; }
    } else if (last?.explanation?.input_hash === r.inputHash) { out.unchanged += 1; continue; } // temp: unchanged semantics
    const obsUsed = obs.filter((o) => Date.parse(o.available_at) <= Date.parse(now) && o.valid_at >= c.observation_start && o.valid_at < c.observation_end);
    const sHash = await sourceStateHash(c, obsUsed, r.provenance);
    assertMarketFree(r.features);
    const featuresSha = await sha256Hex(JSON.stringify({ model: r.model, features: r.features }));
    const recordId = `${c.contract_id}|${r.model.id}@${r.model.version}|${featuresSha.slice(0, 16)}|${now}`;
    const snapshotId = `fs|${recordId}`;
    const v = venue.get(c.contract_id);
    features.push({ snapshot_id: snapshotId, event_id: c.event_id, model_id: r.model.id, cutoff_at: r.dataCutoffAt, created_at: now, features: r.features,
      source_classes: [...new Set((r.featureSources || []).map((x) => x.sourceClass).filter(Boolean))].length ? [...new Set(r.featureSources.map((x) => x.sourceClass))] : ['official'],
      source_observation_keys: [], context: { contract_id: c.contract_id, lane: 'hot-intraday', observations_used: obs.filter((o) => Date.parse(o.available_at) <= Date.parse(now)).length }, quality: { grade: r.confidence, rules: r.explanation?.quality_rules ?? null } });
    forecasts.push({
      record_id: recordId, event_id: c.event_id, model_id: r.model.id, model_version: r.model.version, probability: r.probability, captured_at: now,
      feature_snapshot_id: snapshotId, record_type: 'live', contract_id: c.contract_id, market_id: c.market_id,
      market_probability: v?.probability ?? null, market_snapshot_key: v?.snapshot_key ?? null, market_observed_at: v?.captured_at ?? null,
      data_cutoff_at: r.dataCutoffAt, model_state: r.model.state, confidence: r.confidence, features_sha256: featuresSha,
      provenance: r.provenance, explanation: { ...r.explanation, evidence: r.evidence, raw_probability: r.rawProbability, input_hash: r.inputHash, predictive_input_hash: pHash ?? r.inputHash, source_state_hash: sHash, predictive_state: pState, lane: 'hot-intraday' },
      metadata: { domain: c.domain, category: c.detail?.category ?? null, event_type: c.event_type, station_id: c.station_id, observation_start: c.observation_start, intraday: true },
    });
  }
  if (forecasts.length) { spend(2); await store.insertFeatureRows(features); await store.insertForecastRows(forecasts); out.written = forecasts.length; }
  return out;
}
