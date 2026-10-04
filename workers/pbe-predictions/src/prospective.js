// Prospective record for the FROZEN decision candidate (owner 2026-10-04). Counts exactly the predeclared unit in
// DECISION_POLICY.promotion: one decision per contract = its FINAL_PRE_RESOLUTION designated forecast captured at/after
// frozen_at, decided by the frozen policy AS OF that forecast's own capture time (never re-decided with later data).
// Raw 15-minute reforecasts never count. 100 resolved calls = diagnostic only; 300 = owner promotion review.
import { DECISION_POLICY, decide, decisionInput } from '../../../src/engine/decision.js';
import { checkIntegrity } from '../../../src/engine/evidence.js';

const FAMILY = 'pbe-weather-precip';

export async function prospectiveRecord(store, policy = DECISION_POLICY) {
  const P = policy.promotion;
  const des = await store.select('pred_forecast_designations', { select: 'contract_id,forecast_id,designated_at', designation: 'eq.FINAL_PRE_RESOLUTION', designated_at: `gte.${policy.frozen_at}` });
  const fids = des.map((d) => d.forecast_id);
  const forecasts = fids.length ? (await store.selectIn('pred_forecasts', { select: 'forecast_id,contract_id,model_id,model_version,model_state,probability,confidence,captured_at,data_cutoff_at,feature_snapshot_id,provenance', model_id: `eq.${FAMILY}` }, 'forecast_id', fids, { chunkSize: 60 })).filter((f) => f.captured_at >= policy.frozen_at) : [];
  const cids = [...new Set(forecasts.map((f) => f.contract_id))];
  const [contracts, resolutions, snaps] = cids.length ? await Promise.all([
    store.selectIn('pred_contracts', { select: 'contract_id,normalization_status,status_reason,observation_start,detail' }, 'contract_id', cids),
    store.selectIn('pred_resolutions', { select: 'contract_id,venue_result,resolved_at' }, 'contract_id', cids),
    store.selectIn('pred_feature_snapshots', { select: 'snapshot_id,features,cutoff_at' }, 'snapshot_id', forecasts.map((f) => f.feature_snapshot_id), { chunkSize: 20 }),
  ]) : [[], [], []];
  const cById = new Map(contracts.map((c) => [c.contract_id, c]));
  const sById = new Map(snaps.map((s) => [s.snapshot_id, s]));
  const rows = forecasts.map((f) => {
    const c = cById.get(f.contract_id);
    const integrity = checkIntegrity({ forecast: f, snapshot: sById.get(f.feature_snapshot_id) || null });
    const d = decide(decisionInput({ forecast: f, contract: c, integrityOk: integrity.ok, asOf: f.captured_at }), policy);
    const r = resolutions.find((x) => x.contract_id === f.contract_id);
    const res = String(r?.venue_result || '').toLowerCase();
    const outcome = res === 'yes' ? 1 : res === 'no' ? 0 : null;
    const hit = d.state === 'CALL' && outcome !== null ? Number((d.side === 'YES') === (outcome === 1)) : null;
    return { contract_id: f.contract_id, forecast_id: f.forecast_id, captured_at: f.captured_at, resolution_date: c?.detail?.climate_date || c?.observation_start?.slice(0, 10) || null, p: Number(f.probability), confidence: f.confidence, state: d.state, side: d.side, reasons: d.reasons, outcome, hit };
  });
  const calls = rows.filter((r) => r.state === 'CALL');
  const resolved = calls.filter((r) => r.outcome !== null);
  const side = (s) => { const x = resolved.filter((r) => r.side === s); return { n: x.length, hits: x.reduce((a, r) => a + r.hit, 0), mean_called_p: x.length ? +(x.reduce((a, r) => a + (s === 'YES' ? r.p : 1 - r.p), 0) / x.length).toFixed(4) : null }; };
  const dates = new Set(resolved.map((r) => r.resolution_date));
  const n = resolved.length;
  const stage = n >= P.promotion_review_at && dates.size >= P.min_distinct_resolution_dates ? 'PROMOTION_REVIEW_DUE' : n >= P.promotion_review_at ? 'AWAITING_DISTINCT_DATES' : n >= P.interim_diagnostic_at ? 'INTERIM_DIAGNOSTIC (no promotion decision)' : 'COLLECTING';
  return {
    policy: { version: policy.version, candidate: policy.candidate, status: policy.status, frozen_at: policy.frozen_at, activated_at: policy.activated_at, promotion: P },
    stage, decision_records: rows.length, calls: calls.length, resolved_calls: n, distinct_resolution_dates: dates.size,
    hit_rate: n ? +(resolved.reduce((a, r) => a + r.hit, 0) / n).toFixed(4) : null, yes: side('YES'), no: side('NO'),
    by_state: rows.reduce((a, r) => { const k = r.state === 'CALL' ? `CALL_${r.side}` : `${r.state}:${r.reasons.join('+')}`; a[k] = (a[k] || 0) + 1; return a; }, {}),
    rows,
  };
}
