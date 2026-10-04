// DECISION LEDGER ROW (pbe-decision-record/1, Predictions side). One immutable row per contract for the predeclared
// counting unit (FINAL_PRE_RESOLUTION designated forecast), built by ONE function used both by the engine cycle (write
// at designation time) and by the verifier (recompute and compare). No market value is ever part of the row: venue
// benchmarks stay in the venue layer and join by forecast/contract afterwards.
import { decide, decisionInput, policyHash, isOfficial, DECISION_POLICY } from './decision.js';
import { buildEvidencePacket } from './evidence.js';
import { FAMILIES } from './registry.js';
import { distributionKindOf } from './distribution.js';

export const DECISION_RECORD_SCHEMA = 'pbe-decision-record/1';
export const COUNTING_DESIGNATION = 'FINAL_PRE_RESOLUTION';
// Fields compared byte-for-byte between a stored row and its recomputation.
export const VERIFIED_FIELDS = Object.freeze(['state', 'side', 'reasons', 'policy_sha256', 'evidence_sha256', 'official_at_decision', 'probability', 'decision_as_of']);

// rows: { event {event_id, canonical_question, metadata}, contract (pred_contracts row), siblings (latest public
// forecasts of the event, for the PBE-modal rule), forecast (pred_forecasts row), snapshot (pred_feature_snapshots row) }
export async function buildDecisionRecord({ event, contract, contracts = [contract], siblings = [], forecast, snapshot, policy = DECISION_POLICY }) {
  const fam = FAMILIES.find((f) => f.id === forecast.model_id) || null;
  const { packet, sha256 } = await buildEvidencePacket({ event, contract, forecast, snapshot, limitations: fam?.limitations ?? [] });
  const exclusive = distributionKindOf(event, contracts) === 'exclusive';
  const modalP = Math.max(Number(forecast.probability), ...siblings.map((f) => Number(f.probability)));
  const asOf = forecast.captured_at; // decided as of the designated forecast's own capture time
  const d = decide(decisionInput({ forecast, contract, integrityOk: packet.integrity.ok, asOf, isModal: exclusive ? Number(forecast.probability) >= modalP : null, exclusive }), policy);
  const hash = await policyHash(policy);
  return {
    record_key: `${contract.contract_id}|${COUNTING_DESIGNATION}|${policy.candidate}|${hash.slice(0, 16)}`,
    record_schema: DECISION_RECORD_SCHEMA,
    contract_id: contract.contract_id,
    event_id: event?.event_id ?? forecast.event_id ?? null,
    forecast_id: forecast.forecast_id,
    designation: COUNTING_DESIGNATION,
    counting_unit: policy.promotion.unit,
    candidate: policy.candidate,
    policy_version: policy.version,
    policy_status: policy.status,
    policy_sha256: hash,
    policy_frozen_at: policy.frozen_at,
    policy_activated_at: policy.activated_at,
    model_id: forecast.model_id,
    model_version: forecast.model_version,
    model_state: forecast.model_state,
    probability: Number(forecast.probability),
    confidence: forecast.confidence ?? null,
    evidence_sha256: sha256,
    feature_snapshot_id: forecast.feature_snapshot_id,
    features_sha256: forecast.features_sha256 ?? null,
    data_cutoff_at: forecast.data_cutoff_at,
    decision_as_of: asOf,
    state: d.state,
    side: d.side,
    reasons: [...d.reasons],
    official_at_decision: isOfficial(policy, asOf),
  };
}

// Prospective only: the ledger begins at frozen_at (no historical backfill).
export const eligibleForLedger = (forecast, policy = DECISION_POLICY) => Boolean(policy.frozen_at) && forecast.captured_at >= policy.frozen_at;

const norm = (k, v) => (k === 'reasons' ? JSON.stringify([...(v || [])]) : ['decision_as_of'].includes(k) ? new Date(v).toISOString() : k === 'probability' ? Number(v) : v ?? null);
export function compareRecord(stored, recomputed) {
  return VERIFIED_FIELDS.filter((k) => norm(k, stored[k]) !== norm(k, recomputed[k])).map((k) => ({ field: k, stored: stored[k], recomputed: recomputed[k] }));
}
