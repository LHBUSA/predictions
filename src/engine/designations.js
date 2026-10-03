// Scoring designations (designation/1) — which forecast counts is fixed by rule BEFORE the outcome exists.
// Reference time = the contract's scoring reference: observation-window start for weather/Fed (pre-window forecasts
// only); the period close for path contracts (detail.scoring_reference), or the venue settlement if that came first.
//   FIRST_PUBLISHED       the first forecast ever published for the contract/model
//   T_MINUS_24H           the latest forecast captured at or before window start - 24 h (if one exists)
//   FINAL_PRE_RESOLUTION  the latest forecast captured strictly before window start
// Each designation is written once (unique per contract/model) and only after its reference time passed.
import { brierScore, logLoss } from '../scoring.js';

export const DESIGNATION_RULES = 'designation/1';

export function scoringReference(contract, resolvedAt = null) {
  const ref = Date.parse(contract.detail?.scoring_reference || contract.observation_start);
  const res = resolvedAt ? Date.parse(resolvedAt) : Infinity;
  return Math.min(ref, res);
}

export function dueDesignations({ contract, forecasts, existing, now, resolvedAt = null }) {
  const start = scoringReference(contract, resolvedAt);
  const nowMs = Date.parse(now);
  const have = new Set(existing.map((d) => d.designation));
  const sorted = [...forecasts].sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
  const out = [];
  if (!have.has('FIRST_PUBLISHED') && sorted.length) out.push({ designation: 'FIRST_PUBLISHED', forecast: sorted[0], reference_time: sorted[0].captured_at });
  const t24 = start - 24 * 3600000;
  if (!have.has('T_MINUS_24H') && nowMs >= t24) {
    const f = sorted.filter((x) => Date.parse(x.captured_at) <= t24).pop();
    if (f) out.push({ designation: 'T_MINUS_24H', forecast: f, reference_time: new Date(t24).toISOString() });
  }
  if (!have.has('FINAL_PRE_RESOLUTION') && nowMs >= start) {
    const f = sorted.filter((x) => Date.parse(x.captured_at) < start).pop();
    if (f) out.push({ designation: 'FINAL_PRE_RESOLUTION', forecast: f, reference_time: new Date(start).toISOString() });
  }
  return out;
}

// PBE and market scored on the same designated snapshot (market = the price captured with that forecast).
export function scoreRows({ designation, forecast, resolution, outcome }) {
  const p = Number(forecast.probability);
  const m = forecast.market_probability === null || forecast.market_probability === undefined ? null : Number(forecast.market_probability);
  const rows = [];
  for (const [method, fn] of [['brier', brierScore], ['log_loss', logLoss]]) {
    const pbe = fn(p, outcome);
    const mkt = m === null ? null : fn(m, outcome);
    rows.push({
      forecast_id: forecast.forecast_id,
      resolution_id: resolution.resolution_id,
      contract_id: forecast.contract_id,
      designation,
      scoring_method: method,
      score: pbe,
      benchmark_score: mkt,
      improvement: mkt === null ? null : mkt - pbe,
      market_probability: m,
      outcome,
      details: { rules: DESIGNATION_RULES, benchmark: 'venue mid at forecast capture', pbe_probability: p },
    });
  }
  return rows;
}
