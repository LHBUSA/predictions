// PRIVATE SHADOW lane for pbe-weather-maxtemp-intraday@2.2.0 (frozen; docs/research/WEATHER_INTRADAY_V22_SHADOW_PLAN.md).
// Called by intradayForStation AFTER the v2.1 write, with the SAME stored observation rows, the SAME `now` and the SAME
// guidance fetch. Writes only pred_forecasts_shadow (sql/014): never pred_forecasts, so no public read path and no v2.1
// dedupe can see a shadow row. The model, its artifact and its dedupe rule are used exactly as frozen.
//   observations: the v2.1 rows + wxcodes/sky decoded from the STORED raw METAR (point in time: same available_at);
//                 a row without raw METAR text carries no wx fields -> the model fails closed (INCOMPLETE_OBSERVATIONS)
//   guidance:     the v2.1 NBS run + the previous NBS cycle (only nbm_run_change_f, an evidence field, needs it);
//                 the model itself fails closed without a usable TMP path (INCOMPLETE_GUIDANCE)
//   market:       never read; every market column on the row is NULL (DB CHECK)
import { forecastIntradayShadow, shadowWriteDecision, shadowForecastRow, shadowSourceStateHash, SHADOW_TEMP_MODEL_VERSION } from '../../../src/weather/intraday/shadow.js';
import { parseMetarWeather } from '../../../src/weather/intraday/observations.js';
import { fetchMosRun } from '../../../src/weather/mos.js';
import { assertMarketFree } from '../../../src/engine/leakage.js';
import { sha256Hex } from '../../../src/engine/contracts.js';
import { engineObservations } from './intraday-live.js';

const H = 3600000;
const SHADOW_MODEL_ID = 'pbe-weather-maxtemp-intraday';

// engineObservations(rows) + wxcodes/sky from each row's stored raw METAR. Same rows, same order, same fields otherwise.
export function engineObservationsV22(rows, icao) {
  const base = engineObservations(rows, icao);
  const byValid = new Map();
  for (const r of rows) if (r.data?.metar && r.data.temp_f !== null && r.data.temp_f !== undefined) byValid.set(new Date(r.observed_at).toISOString(), r);
  return base.map((o) => {
    const raw = byValid.get(o.valid_at)?.data?.raw_message;
    return raw ? { ...o, ...parseMetarWeather(raw) } : o; // no raw text -> no wx keys -> fail closed downstream
  });
}

// The NBS cycle 6 h before the v2.1 run, if IEM has it and it is <= 24 h old at `now` (usable rule: cycle + 5 h).
export async function priorNbmRun(nbm, now, { fetchImpl, userAgent }) {
  if (!nbm?.runtime) return null;
  const rt = new Date(Date.parse(nbm.runtime) - 6 * H).toISOString();
  if (Date.parse(now) - Date.parse(rt) > 24 * H) return null;
  const run = await fetchMosRun({ icao: nbm.icao, model: 'NBS', runtime: rt }, { fetchImpl, userAgent });
  return run.rows.length && run.runtime === rt ? run : null;
}

// Map the frozen shadowForecastRow() onto pred_forecasts_shadow columns. record_id = the plan's content address
// (predictive hash) + capture time: a retried call at the same `now` is a no-op, and a predictive state that recurs after
// a different one (A -> B -> A) is still recorded instead of being swallowed by a record_id collision.
export async function shadowTableRow(contract, r, { now, sourceStateHash }) {
  const row = shadowForecastRow(contract, r, { now, sourceStateHash });
  assertMarketFree(r.features);
  const featuresSha = await sha256Hex(JSON.stringify({ model: r.model, features: r.features }));
  const { feature_snapshot_id: _f, ...rest } = row;
  return {
    ...rest, record_id: `${row.record_id}|${now}`,
    predictive_input_hash: row.explanation.predictive_input_hash, source_state_hash: row.explanation.source_state_hash,
    raw_probability: r.rawProbability, features: r.features, features_sha256: featuresSha,
    station_id: contract.station_id, climate_date: contract.detail?.climate_date, observation_start: contract.observation_start,
  };
}

export async function shadowForStation(store, { contracts, obsRows, icao, src, now, spend = () => {}, fetchImpl = globalThis.fetch, userAgent }) {
  const out = { model: `${SHADOW_MODEL_ID}@${SHADOW_TEMP_MODEL_VERSION}`, considered: 0, written: 0, unchanged: 0, skipped: {}, nbm_runs: 0 };
  const temp = contracts.filter((c) => c.event_type === 'MAX_TEMP_BUCKET');
  if (!temp.length) return out;
  const obs22 = engineObservationsV22(obsRows, icao);
  let prior = null;
  try { spend(); prior = await priorNbmRun(src.nbm, now, { fetchImpl, userAgent }); } catch (e) { if (/budget exhausted/.test(e.message)) throw e; out.prior_nbm_error = e.message; }
  const nbm = [src.nbm, prior].filter((x) => x?.runtime);
  out.nbm_runs = nbm.length;
  spend(); const priorRows = await store.selectIn('pred_forecasts_shadow', { select: 'contract_id,captured_at,predictive_input_hash', model_id: `eq.${SHADOW_MODEL_ID}`, model_version: `eq.${SHADOW_TEMP_MODEL_VERSION}` }, 'contract_id', temp.map((c) => c.contract_id), { order: 'captured_at.desc' });
  const rows = [];
  for (const c of temp) {
    out.considered += 1;
    const r = forecastIntradayShadow(c, { obs: obs22, nbm }, { now });
    const last = priorRows.find((p) => p.contract_id === c.contract_id); // newest first
    const d = shadowWriteDecision(last ? { explanation: { predictive_input_hash: last.predictive_input_hash } } : null, r);
    if (!d.write) { if (d.reason === 'UNCHANGED_PREDICTIVE_STATE') out.unchanged += 1; else out.skipped[d.reason] = (out.skipped[d.reason] || 0) + 1; continue; }
    const used = obs22.filter((o) => Date.parse(o.available_at) <= Date.parse(now) && o.valid_at >= c.observation_start && o.valid_at < c.observation_end);
    rows.push(await shadowTableRow(c, r, { now, sourceStateHash: await shadowSourceStateHash(r, c.contract_id, used) }));
  }
  if (rows.length) { spend(Math.ceil(rows.length / 500)); await store.insertMany('pred_forecasts_shadow', rows, 'record_id'); out.written = rows.length; }
  return out;
}
