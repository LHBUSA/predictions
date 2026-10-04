// Prospective record for the FROZEN decision candidate (owner 2026-10-04), counted from the SYSTEM OF RECORD:
// pred_decisions (sql/006), one immutable row per contract for the predeclared unit (FINAL_PRE_RESOLUTION designated
// forecast captured at/after frozen_at, decided as of its capture time). Rows were written at designation time;
// /admin/decisions/verify proves each one reproduces from the pinned policy. Raw engine-cadence reforecasts never count.
// 100 resolved calls = diagnostic only; 300 on >= 30 distinct resolution dates = owner promotion review.
import { DECISION_POLICY, policyHash } from '../../../src/engine/decision.js';

const FAMILY = 'pbe-weather-precip';

export async function prospectiveRecord(store, policy = DECISION_POLICY) {
  const P = policy.promotion;
  const hash = await policyHash(policy);
  const stored = (await store.select('pred_decisions', { select: 'decision_id,contract_id,forecast_id,model_id,probability,confidence,decision_as_of,state,side,reasons,official_at_decision,policy_sha256,correction_of', candidate: `eq.${policy.candidate}` }, { order: 'inserted_at.asc' }))
    .filter((r) => r.policy_sha256 === hash);
  // a correction supersedes the row it references (both stay in the ledger)
  const corrected = new Set(stored.filter((r) => r.correction_of).map((r) => r.correction_of));
  const rows = stored.filter((r) => !corrected.has(r.decision_id) && r.model_id === FAMILY);
  const cids = [...new Set(rows.map((r) => r.contract_id))];
  const [contracts, resolutions] = cids.length ? await Promise.all([
    store.selectIn('pred_contracts', { select: 'contract_id,observation_start,detail' }, 'contract_id', cids),
    store.selectIn('pred_resolutions', { select: 'contract_id,venue_result' }, 'contract_id', cids),
  ]) : [[], []];
  const out = rows.map((r) => {
    const c = contracts.find((x) => x.contract_id === r.contract_id);
    const res = String(resolutions.find((x) => x.contract_id === r.contract_id)?.venue_result || '').toLowerCase();
    const outcome = res === 'yes' ? 1 : res === 'no' ? 0 : null;
    const hit = r.state === 'CALL' && outcome !== null ? Number((r.side === 'YES') === (outcome === 1)) : null;
    return { contract_id: r.contract_id, forecast_id: r.forecast_id, decision_as_of: r.decision_as_of, resolution_date: c?.detail?.climate_date || c?.observation_start?.slice(0, 10) || null, p: Number(r.probability), confidence: r.confidence, state: r.state, side: r.side, reasons: r.reasons, official_at_decision: r.official_at_decision, outcome, hit };
  });
  const calls = out.filter((r) => r.state === 'CALL');
  const resolved = calls.filter((r) => r.outcome !== null);
  const side = (s) => { const x = resolved.filter((r) => r.side === s); return { n: x.length, hits: x.reduce((a, r) => a + r.hit, 0), mean_called_p: x.length ? +(x.reduce((a, r) => a + (s === 'YES' ? r.p : 1 - r.p), 0) / x.length).toFixed(4) : null }; };
  const dates = new Set(resolved.map((r) => r.resolution_date));
  const n = resolved.length;
  const stage = n >= P.promotion_review_at && dates.size >= P.min_distinct_resolution_dates ? 'PROMOTION_REVIEW_DUE' : n >= P.promotion_review_at ? 'AWAITING_DISTINCT_DATES' : n >= P.interim_diagnostic_at ? 'INTERIM_DIAGNOSTIC (no promotion decision)' : 'COLLECTING';
  return {
    source: 'pred_decisions (stored at designation time)',
    policy: { version: policy.version, candidate: policy.candidate, status: policy.status, policy_sha256: hash, frozen_at: policy.frozen_at, activated_at: policy.activated_at, promotion: P },
    stage, decision_records: out.length, calls: calls.length, resolved_calls: n, distinct_resolution_dates: dates.size,
    hit_rate: n ? +(resolved.reduce((a, r) => a + r.hit, 0) / n).toFixed(4) : null, yes: side('YES'), no: side('NO'),
    official_records: out.filter((r) => r.official_at_decision).length,
    by_state: out.reduce((a, r) => { const k = r.state === 'CALL' ? `CALL_${r.side}` : `${r.state}:${r.reasons.join('+')}`; a[k] = (a[k] || 0) + 1; return a; }, {}),
    rows: out,
  };
}
