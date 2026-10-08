// Intraday scoring lane (designation-intraday/1, sql/013). Runs on its own schedule (INTRADAY_SCORING=true, twice an
// hour off the core cron), never inside runCycle: the core cycle, its writes and the v2.1 / v2.0 forecast paths are
// untouched. Reads the append-only ledger, writes only pred_intraday_designations / pred_intraday_scores.
// Prospective only: designations point at live rows the hot lane captured; nothing is ever forecast here.
import { dueIntradayDesignations, intradayScoreRows, benchmarkState, qualityState, intradayScoreReport, isIntradayModel, INTRADAY_DESIGNATIONS, SETTLE_MS, MARKET_FRESH_MS, SOURCE_GAP_MS } from '../../../src/engine/intraday-designations.js';
import { cliStation } from '../../../src/weather/stations.js';

const LOOKBACK_DAYS = 10;
const EVENT_TYPES = ['MAX_TEMP_BUCKET', 'PRECIP_ANY'];
const FORECAST_COLS = 'forecast_id,contract_id,model_id,model_version,record_type,probability,market_probability,market_observed_at,market_snapshot_key,captured_at,data_cutoff_at,confidence';
const H = 3600000;

export const intradayScoringDue = (scheduledIso) => new Date(scheduledIso).getUTCMinutes() % 30 === 4; // :04 and :34

export async function runIntradayScoring(store, { now, dryRun = false, lookbackDays = LOOKBACK_DAYS } = {}) {
  const out = { now, dry_run: dryRun, contracts: 0, work_contracts: 0, designations_written: 0, missing: {}, scores_written: 0, skipped: {} };
  const since = new Date(Date.parse(now) - lookbackDays * 86400000).toISOString();
  const firstRef = new Date(Date.parse(now) - 2 * H - SETTLE_MS).toISOString();
  const contracts = await store.select('pred_contracts', { select: 'contract_id,market_id,event_type,station_id,observation_start,observation_end,detail', normalization_status: 'eq.NORMALIZED', event_type: `in.(${EVENT_TYPES.join(',')})`, observation_end: `gte.${since}`, observation_start: `lte.${firstRef}` });
  out.contracts = contracts.length;
  if (!contracts.length) return out;
  const ids = contracts.map((c) => c.contract_id);
  const [existing, resolutions] = await Promise.all([
    store.selectIn('pred_intraday_designations', { select: 'designation_key,contract_id,model_id,model_version,designation,forecast_id,reference_time,detail' }, 'contract_id', ids),
    store.selectIn('pred_resolutions', { select: 'resolution_id,contract_id,venue_result,resolved_at,official_outcome,sources_agree' }, 'contract_id', ids),
  ]);
  const resBy = new Map(resolutions.filter((r) => ['yes', 'no'].includes(r.venue_result)).map((r) => [r.contract_id, r]));
  const scoredKeys = new Set();
  const resolvedWithDes = [...new Set(existing.filter((d) => resBy.has(d.contract_id)).map((d) => d.contract_id))];
  if (resolvedWithDes.length) for (const s of await store.selectIn('pred_intraday_scores', { select: 'designation_key,scoring_method' }, 'contract_id', resolvedWithDes)) scoredKeys.add(`${s.designation_key}|${s.scoring_method}`);
  const desBy = new Map(); for (const d of existing) { if (!desBy.has(d.contract_id)) desBy.set(d.contract_id, []); desBy.get(d.contract_id).push(d); }
  // work = designation still open (no FINAL yet: every group is decided in the run that writes its FINAL) or resolved with unscored designations
  const work = contracts.filter((c) => {
    const ds = desBy.get(c.contract_id) || [];
    const final = ds.some((d) => d.designation === 'FINAL_INTRADAY');
    const unscored = resBy.has(c.contract_id) && ds.some((d) => !scoredKeys.has(`${d.designation_key}|brier`) || !scoredKeys.has(`${d.designation_key}|log_loss`));
    return !final || unscored;
  });
  out.work_contracts = work.length;
  if (!work.length) return out;
  const forecasts = (await store.selectIn('pred_forecasts', { select: FORECAST_COLS, model_id: 'like.*-intraday', record_type: 'eq.live' }, 'contract_id', work.map((c) => c.contract_id))).filter((f) => isIntradayModel(f.model_id));
  const fBy = new Map(); for (const f of forecasts) { if (!fBy.has(f.contract_id)) fBy.set(f.contract_id, []); fBy.get(f.contract_id).push(f); }
  // fail closed: one market must map to one contract row carrying intraday forecasts (else the market would be double-counted)
  const perMarket = new Map(); for (const c of work) if (fBy.has(c.contract_id)) perMarket.set(c.market_id, (perMarket.get(c.market_id) || 0) + 1);

  // 1. designations
  const newDes = [];
  for (const c of work) {
    if (!fBy.has(c.contract_id)) continue;
    if (perMarket.get(c.market_id) > 1) { out.skipped.AMBIGUOUS_CONTRACT = (out.skipped.AMBIGUOUS_CONTRACT || 0) + 1; continue; }
    const resolvedAt = resBy.get(c.contract_id)?.resolved_at ?? null;
    const { rows, missing } = dueIntradayDesignations({ contract: c, forecasts: fBy.get(c.contract_id), existing: desBy.get(c.contract_id) || [], now, resolvedAt });
    for (const m of missing) out.missing[m.designation] = (out.missing[m.designation] || 0) + 1;
    for (const d of rows) { d.backfilled = Date.parse(now) - Date.parse(d.reference_time) > H; d.detail.market_id = c.market_id; newDes.push(d); }
  }
  if (!dryRun && newDes.length) await store.insertMany('pred_intraday_designations', newDes, 'designation_key');
  out.designations_written = newDes.length;
  for (const d of newDes) { if (!desBy.has(d.contract_id)) desBy.set(d.contract_id, []); desBy.get(d.contract_id).push(d); }

  // 2. scores for resolved contracts
  const fById = new Map(forecasts.map((f) => [f.forecast_id, f]));
  const toScore = [];
  for (const c of work) {
    const r = resBy.get(c.contract_id); if (!r) continue;
    for (const d of desBy.get(c.contract_id) || []) {
      if (scoredKeys.has(`${d.designation_key}|brier`) && scoredKeys.has(`${d.designation_key}|log_loss`)) continue;
      const f = fById.get(d.forecast_id); if (!f) { out.skipped.FORECAST_NOT_LOADED = (out.skipped.FORECAST_NOT_LOADED || 0) + 1; continue; }
      toScore.push({ c, d, f, r });
    }
  }
  if (toScore.length) {
    const keys = [...new Set(toScore.map((x) => x.f.market_snapshot_key).filter(Boolean))];
    const venues = new Map((keys.length ? await store.selectIn('pred_venue_snapshots', { select: 'snapshot_key,market_status' }, 'snapshot_key', keys, { chunkSize: 20 }) : []).map((v) => [v.snapshot_key, v]));
    const caps = toScore.map((x) => Date.parse(x.f.captured_at));
    const runs = (await store.select('pred_engine_runs', { select: 'at,counts', lane: 'eq.core', transition: 'eq.COMPLETED', and: `(at.gte.${new Date(Math.min(...caps) - MARKET_FRESH_MS).toISOString()},at.lte.${new Date(Math.max(...caps)).toISOString()})` }, { order: 'at.asc' }))
      .map((x) => ({ at: x.at, market_http_errors: x.counts?.market_http_errors ?? null, market_backoff_errors: x.counts?.market_backoff_errors ?? null }));
    // exact-station observation availability around each reference time (source-gap check)
    const obsTimes = new Map();
    const byIcao = new Map();
    for (const x of toScore) { const icao = cliStation(x.c.station_id)?.icao; if (!icao) continue; const ref = Date.parse(x.d.reference_time); const cur = byIcao.get(icao) || [Infinity, -Infinity]; byIcao.set(icao, [Math.min(cur[0], ref - SOURCE_GAP_MS), Math.max(cur[1], ref)]); }
    for (const [icao, [lo, hi]] of byIcao) {
      // observed_at bounds (the hot lane's indexed access path); availability is checked per reference time
      const rows = await store.select('pred_source_observations', { select: 'observed_at,available_at', source_id: `like.asos:${icao}:*`, and: `(observed_at.gte.${new Date(lo - SOURCE_GAP_MS).toISOString()},observed_at.lte.${new Date(hi).toISOString()})` }, { order: 'observed_at.asc' });
      obsTimes.set(icao, rows.map((o) => Date.parse(o.available_at)));
    }
    const scoreRows = [];
    for (const { c, d, f, r } of toScore) {
      const bench = benchmarkState(f, venues.get(f.market_snapshot_key) || null, runs);
      const quality = qualityState({ designation: d, obsTimes: obsTimes.get(cliStation(c.station_id)?.icao) || [], resolution: r });
      for (const row of intradayScoreRows({ designation: d, forecast: f, contract: c, resolution: r, benchmark: bench, quality })) if (!scoredKeys.has(row.score_key)) scoreRows.push(row);
    }
    if (!dryRun && scoreRows.length) await store.insertMany('pred_intraday_scores', scoreRows, 'score_key');
    out.scores_written = scoreRows.length;
    if (dryRun) out.preview = { designations: newDes.slice(0, 5), scores: scoreRows.slice(0, 4) };
  }
  return out;
}

// Admin report: every stored intraday score row, aggregated (internal diagnostics only).
export async function intradayReport(store) {
  const rows = await store.select('pred_intraday_scores', { select: 'designation_key,contract_id,model_id,model_version,designation,scoring_method,pbe_probability,outcome,score,benchmark_state,benchmark_score,station_id,station_group,climate_date,hour_bucket,calibration_bucket,quality_state' }, { order: 'score_key.asc' });
  const des = await store.select('pred_intraday_designations', { select: 'model_id,model_version,designation,backfilled' }, { order: 'designation_key.asc' });
  const coverage = {};
  for (const d of des) { const k = `${d.model_id}@${d.model_version}`; coverage[k] ||= Object.fromEntries(INTRADAY_DESIGNATIONS.map((x) => [x, 0])); coverage[k][d.designation] += 1; }
  return intradayScoreReport(rows, { coverage: { designations_by_model: coverage, designations_total: des.length, backfilled: des.filter((d) => d.backfilled).length } });
}

// v2.1 (live) vs v2.2 (SHADOW) on the pre-registered FIXED hourly grid (shadowEvaluationReport, frozen in shadow.js):
// only contracts that have shadow rows, only grid points where BOTH versions have a row. Outcome = official CLI max on the
// stored resolution. Readiness (30 resolved climate days, >= 10 stations) is decided inside the frozen report.
export async function shadowCompareReport(store, { evaluate }) {
  // weather rows only: pred_forecasts_shadow also holds CPI V1 SHADOW rows (sql/015), which never enter this comparison
  const shadow = await store.select('pred_forecasts_shadow', { select: 'contract_id,model_version,captured_at,probability,raw_probability,station_id,climate_date,observation_start', model_id: 'eq.pbe-weather-maxtemp-intraday' }, { order: 'captured_at.asc' });
  const base = { shadow_rows: shadow.length, first_shadow_capture: shadow[0]?.captured_at ?? null, last_shadow_capture: shadow.at(-1)?.captured_at ?? null,
    shadow_contracts: new Set(shadow.map((r) => r.contract_id)).size, shadow_stations: new Set(shadow.map((r) => r.station_id)).size };
  if (!shadow.length) return { ...base, report: null };
  const ids = [...new Set(shadow.map((r) => r.contract_id))];
  const [contracts, live, res] = await Promise.all([
    store.selectIn('pred_contracts', { select: 'contract_id,station_id,observation_start,comparator,threshold_low,threshold_high,detail' }, 'contract_id', ids),
    store.selectIn('pred_forecasts', { select: 'contract_id,model_version,captured_at,probability,raw_probability:explanation->raw_probability', model_id: 'eq.pbe-weather-maxtemp-intraday', model_version: 'eq.2.1.0', record_type: 'eq.live' }, 'contract_id', ids),
    store.selectIn('pred_resolutions', { select: 'contract_id,official_value,venue_result' }, 'contract_id', ids),
  ]);
  const cBy = new Map(contracts.map((c) => [c.contract_id, c]));
  const outcomes = new Map();
  for (const r of res) { const c = cBy.get(r.contract_id); if (c && r.official_value !== null && r.official_value !== undefined) outcomes.set(`${c.station_id}|${c.detail?.climate_date}`, Number(r.official_value)); }
  const rows = [...live, ...shadow].map((r) => { const c = cBy.get(r.contract_id); return c ? { ...r, raw_probability: r.raw_probability === null || r.raw_probability === undefined ? null : Number(r.raw_probability), probability: Number(r.probability), station_id: c.station_id, climate_date: c.detail?.climate_date, observation_start: c.observation_start, comparator: c.comparator, threshold_low: c.threshold_low, threshold_high: c.threshold_high } : null; }).filter(Boolean);
  return { ...base, resolved_station_days: outcomes.size, report: evaluate(rows, outcomes), note: 'Descriptive until ready=true (>= 30 resolved climate days, >= 10 stations). Gate = v2.1 vs v2.2 only; the market is not the v2.2 gate.' };
}
