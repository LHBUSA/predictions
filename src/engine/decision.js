// DECISION LAYER — prediction-decision-v1. Turns ONE independent PBE forecast + the quality of its evidence into an
// explicit state: CALL (YES | NO) | PASS | HOLD, with machine reasons. It is a pure function of an ALLOWLISTED input:
// no venue price, quote, spread, volume or any market-derived value can be passed (unknown keys and any key matching
// the market denylist throw). Changing Kalshi or Polymarket therefore cannot change a decision (test/decision.test.js).
//
// STATUS (owner 2026-10-04): FROZEN_PROSPECTIVE — parameters frozen at frozen_at so they cannot be tuned while the
// natural live record accumulates; public CALL is NOT activated (activated_at = null => official=false everywhere).
// Frozen != activated: activation is a separate owner decision after the promotion review below. Any parameter change
// = a NEW candidate version (test/decision.test.js pins the frozen parameter hash).
//
// HOLD = PBE cannot responsibly evaluate the contract right now (rules, data, staleness, integrity, domain).
// PASS = PBE evaluated it and deliberately declines to call (unvalidated model, band, confidence, near-certain).
import { MARKET_KEY_PATTERN, MarketLeakageError } from './leakage.js';
import { canonicalJson } from './evidence.js';

export const DECISION_STATES = Object.freeze(['CALL', 'PASS', 'HOLD']);
export const REASONS = Object.freeze({
  // HOLD — no decision can be issued on this evidence
  UNMODELABLE: 'Contract cannot be modeled from public facts',
  HOLD_RESOLUTION_AMBIGUOUS: 'Resolution rule is ambiguous',
  UNSUPPORTED_DOMAIN: 'No PBE model for this domain',
  RESOLUTION_NOT_PROVEN: 'Settlement source not independently verified for this family',
  INSUFFICIENT_SOURCE_DATA: 'No complete forecast from source data',
  EVIDENCE_INTEGRITY_FAILED: 'Evidence packet failed an integrity rule',
  STALE_EVIDENCE: 'Latest evidence is older than the family freshness limit',
  // PASS — a valid decision: PBE evaluated the contract and the evidence does not justify a call
  MODEL_NOT_VALIDATED: 'Valid forecast; the model has not passed out-of-sample validation for calls',
  WITHIN_UNCERTAINTY_BAND: 'PBE probability inside the no-call band',
  INSUFFICIENT_CONFIDENCE: 'Evidence quality below the call floor',
  NEAR_CERTAIN: 'Evidence makes the outcome near-certain; scored, not called',
  NOT_MODAL_OUTCOME: 'Only the most likely outcome of an exclusive set can be called',
});

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };

// Per-family policy. `validated` + `threshold` are set from strict point-in-time holdout evidence ONLY.
export const DECISION_POLICY = Object.freeze({
  version: 'prediction-decision-v1',
  candidate: 'rain-v1-candidate',
  status: 'FROZEN_PROSPECTIVE',
  frozen_at: '2026-10-04T13:21:00Z',
  activated_at: null,
  evidence: 'docs/research/DECISION_POLICY_V1_EVIDENCE.md',
  // Prospective promotion evidence, predeclared before collection (owner 2026-10-04). Never raw 15-minute snapshots.
  promotion: Object.freeze({
    unit: 'one decision per contract: its FINAL_PRE_RESOLUTION designated forecast, captured at/after frozen_at, decided by this frozen policy as of the captured_at of that forecast',
    counted: 'CALL decisions on resolved contracts (venue settlement), family pbe-weather-precip',
    interim_diagnostic_at: 100, // review only, no promotion decision
    promotion_review_at: 300, // owner promotion review; fail => candidate recorded as failed permanently, V2 researched separately
    min_distinct_resolution_dates: 30,
    evaluation: 'hit rate vs mean called probability with date-clustered bootstrap 95% CI; Brier of the called subset; YES and NO separately',
  }),
  near_certain: 0.97,
  families: Object.freeze({
    // holdout 2025-07..2026-09 (52,896 cases, 457 dates): skill vs climatology 0.515 [0.493,0.536], vs raw NWS PoP 0.065
    // [0.052,0.077]. T=0.70 HIGH-only: 87.2% hit vs 86.9% mean p (selection), 87.2% vs 87.4% (final window).
    // Warm-season (Jun-Sep) YES calls run 3-7 pts overconfident -> no YES calls in those months.
    'pbe-weather-precip': Object.freeze({ validated: true, threshold: 0.70, confidence_floor: 'HIGH', max_evidence_age_h: 12, no_yes_months: Object.freeze([6, 7, 8, 9]), resolution_proof: 'TWC == NWS CLI 112/112 + 40/40 (scripts/research/resolution-proof.mjs)', exclusive: 'per_contract' }),
    // probabilities skilled (0.327 vs climatology, 0.014 vs Normal-error) but CALLs fail: high-p YES comes from NBM/GFS
    // disagreement (51% hit vs 74% predicted); NO calls do not beat calling NO on every bucket -> no CALLs in v1.
    'pbe-weather-maxtemp': Object.freeze({ validated: false, threshold: null, confidence_floor: 'HIGH', max_evidence_age_h: 12, resolution_proof: 'TWC == NWS CLI 112/112 + 40/40 (scripts/research/resolution-proof.mjs)', exclusive: 'modal_only' }),
    // skill vs Gaussian baseline 0.019 [-0.003, 0.042] (105 month clusters): not validated
    'pbe-rates-path': Object.freeze({ validated: false, threshold: null, confidence_floor: 'HIGH', max_evidence_age_h: 120, resolution_proof: 'Treasury par yield CSV = settlement source; FRED DGS* identical 688/688', exclusive: 'per_contract' }),
    // skill 0.016 [-0.13, 0.15] on 85 meetings; top-outcome accuracy 56.5% < always-hold 65.9%: not validated
    'pbe-fed-decision': Object.freeze({ validated: false, threshold: null, confidence_floor: 'HIGH', max_evidence_age_h: 120, resolution_proof: 'FOMC statement; official calendar', exclusive: 'modal_only' }),
  }),
});

export const DECISION_INPUT_KEYS = Object.freeze(['model_id', 'model_version', 'model_state', 'probability', 'confidence', 'data_cutoff_at', 'as_of', 'decision_time',
  'contract_status', 'contract_reason', 'integrity_ok', 'is_modal', 'exclusive', 'contract_month']);

export function assertDecisionInput(input) {
  for (const k of Object.keys(input)) {
    if (MARKET_KEY_PATTERN.test(k)) throw new MarketLeakageError(`decision.${k}`);
    if (!DECISION_INPUT_KEYS.includes(k)) throw new TypeError(`decision input "${k}" is not allowlisted`);
  }
  return input;
}

// NO RETROACTIVE OFFICIAL CALLS (owner 2026-10-04): a decision is official only if the policy is activated AND the
// decision's own time (the designated forecast's capture time) is at/after activated_at. A pre-activation decision stays
// unofficial forever, however often the same immutable forecast is recomputed after activation.
export function isOfficial(policy, decisionTime) {
  if (!policy.activated_at || !decisionTime) return false;
  return Date.parse(decisionTime) >= Date.parse(policy.activated_at);
}
const out = (state, side, reasons, policy, decisionTime, extra = {}) => Object.freeze({ state, side, reasons: Object.freeze(reasons), policy: policy.version, policy_status: policy.status, official: isOfficial(policy, decisionTime), ...extra });

// Hash of the frozen parameters (what a candidate IS). Any change = a different hash = a new candidate version.
export function frozenParameters(policy = DECISION_POLICY) {
  return { version: policy.version, candidate: policy.candidate, frozen_at: policy.frozen_at, near_certain: policy.near_certain, families: policy.families, promotion: policy.promotion };
}
export async function policyHash(policy = DECISION_POLICY) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(frozenParameters(policy))));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function decide(input, policy = DECISION_POLICY) {
  const x = assertDecisionInput({ ...input });
  if (x.contract_status && x.contract_status !== 'NORMALIZED') return out('HOLD', null, [REASONS[x.contract_status] ? x.contract_status : 'UNMODELABLE'], policy, x.decision_time);
  const fam = policy.families[x.model_id];
  if (x.probability === null || x.probability === undefined || !x.model_id) return out('HOLD', null, ['INSUFFICIENT_SOURCE_DATA'], policy, x.decision_time);
  if (!fam) return out('HOLD', null, ['UNSUPPORTED_DOMAIN'], policy, x.decision_time);
  if (!fam.resolution_proof) return out('HOLD', null, ['RESOLUTION_NOT_PROVEN'], policy, x.decision_time);
  if (x.integrity_ok === false) return out('HOLD', null, ['EVIDENCE_INTEGRITY_FAILED'], policy, x.decision_time);
  const ageH = (Date.parse(x.as_of) - Date.parse(x.data_cutoff_at)) / 3600000;
  if (!Number.isFinite(ageH) || ageH > fam.max_evidence_age_h) return out('HOLD', null, ['STALE_EVIDENCE'], policy, x.decision_time, { evidence_age_h: Number.isFinite(ageH) ? +ageH.toFixed(1) : null });
  // from here PBE has a valid, current forecast: every remaining outcome is a deliberate decision (CALL or PASS)
  if (x.model_state === 'SHADOW' || !fam.validated || !(fam.threshold > 0.5)) return out('PASS', null, ['MODEL_NOT_VALIDATED'], policy, x.decision_time);
  const p = Number(x.probability);
  if ((RANK[x.confidence] ?? -1) < RANK[fam.confidence_floor]) return out('PASS', null, ['INSUFFICIENT_CONFIDENCE'], policy, x.decision_time);
  if (Math.max(p, 1 - p) >= policy.near_certain) return out('PASS', null, ['NEAR_CERTAIN'], policy, x.decision_time);
  const exclusive = x.exclusive === true && fam.exclusive === 'modal_only';
  if (p >= fam.threshold) {
    if (exclusive && x.is_modal === false) return out('PASS', null, ['NOT_MODAL_OUTCOME'], policy, x.decision_time);
    if (fam.no_yes_months?.includes(x.contract_month)) return out('PASS', null, ['MODEL_NOT_VALIDATED'], policy, x.decision_time, { scope: 'yes_calls_in_month' });
    return out('CALL', 'YES', [], policy, x.decision_time, { threshold: fam.threshold });
  }
  if (p <= 1 - fam.threshold && !exclusive) return out('CALL', 'NO', [], policy, x.decision_time, { threshold: fam.threshold });
  return out('PASS', null, [exclusive && p <= 1 - fam.threshold ? 'NOT_MODAL_OUTCOME' : 'WITHIN_UNCERTAINTY_BAND'], policy, x.decision_time);
}

// Build the allowlisted input from stored rows (never from a venue snapshot).
export function decisionInput({ forecast, contract, integrityOk, asOf, isModal = null, exclusive = false }) {
  return {
    model_id: forecast?.model_id ?? null, model_version: forecast?.model_version ?? null, model_state: forecast?.model_state ?? null,
    probability: forecast ? Number(forecast.probability) : null, confidence: forecast?.confidence ?? null, data_cutoff_at: forecast?.data_cutoff_at ?? null,
    as_of: asOf, decision_time: forecast?.captured_at ?? null, contract_status: contract?.normalization_status ?? null, contract_reason: contract?.status_reason ?? null,
    integrity_ok: integrityOk, is_modal: isModal, exclusive,
    // contract window month (resolution term, not a market value): the precip policy has no warm-season YES calls
    contract_month: contract?.observation_start ? new Date(contract.observation_start).getUTCMonth() + 1 : null,
  };
}
