// Decision ledger I/O (sql/006 pred_decisions). The writer (engine cycle, at designation time) and the verifier
// (/admin/decisions/verify) load inputs through the SAME function and build rows with the SAME pure builder
// (src/engine/decision-record.js), so a stored row and its recomputation must match field-for-field.
import { buildDecisionRecord, compareRecord, eligibleForLedger, COUNTING_DESIGNATION } from '../../../src/engine/decision-record.js';
import { DECISION_POLICY, policyHash } from '../../../src/engine/decision.js';

const FORECAST_COLS = 'forecast_id,event_id,contract_id,market_id,model_id,model_version,model_state,probability,confidence,captured_at,data_cutoff_at,feature_snapshot_id,features_sha256,provenance,explanation';

// Inputs for each designated forecast: event, contract, all contracts of the event, siblings (for each other contract
// of the event: its latest same-model forecast captured at or before this one — immutable, so deterministic), snapshot.
export async function loadDecisionInputs(store, forecastIds) {
  if (!forecastIds.length) return [];
  const forecasts = await store.selectIn('pred_forecasts', { select: FORECAST_COLS }, 'forecast_id', forecastIds, { chunkSize: 60 });
  const eventIds = [...new Set(forecasts.map((f) => f.event_id))];
  const [events, contracts, snaps] = await Promise.all([
    store.selectIn('pred_events', { select: 'event_id,canonical_question,metadata' }, 'event_id', eventIds),
    store.selectIn('pred_contracts', { select: '*' }, 'event_id', eventIds),
    store.selectIn('pred_feature_snapshots', { select: 'snapshot_id,features,cutoff_at,source_observation_keys' }, 'snapshot_id', forecasts.map((f) => f.feature_snapshot_id), { chunkSize: 20 }),
  ]);
  const evContractIds = contracts.map((c) => c.contract_id);
  const evForecasts = await store.selectIn('pred_forecasts', { select: 'forecast_id,contract_id,model_id,probability,captured_at' }, 'contract_id', evContractIds);
  return forecasts.map((f) => {
    const contract = contracts.find((c) => c.contract_id === f.contract_id);
    const evContracts = contracts.filter((c) => c.event_id === f.event_id);
    const siblings = evContracts.filter((c) => c.contract_id !== f.contract_id).map((c) => evForecasts.filter((x) => x.contract_id === c.contract_id && x.model_id === f.model_id && x.captured_at <= f.captured_at).sort((a, b) => a.captured_at.localeCompare(b.captured_at)).at(-1)).filter(Boolean);
    return { forecast: f, contract, contracts: evContracts, siblings, event: events.find((e) => e.event_id === f.event_id) || { event_id: f.event_id }, snapshot: snaps.find((s) => s.snapshot_id === f.feature_snapshot_id) || null };
  }).filter((x) => x.contract);
}

// Write one row per FINAL_PRE_RESOLUTION designation whose forecast was captured at/after the freeze. Idempotent:
// an existing original row for the contract/candidate/policy is never rewritten (and the DB forbids it anyway).
export async function writeDecisions(store, designations, policy = DECISION_POLICY) {
  const finals = designations.filter((d) => d.designation === COUNTING_DESIGNATION && d.forecast_id);
  if (!finals.length || !policy.frozen_at) return { written: 0, skipped_existing: 0, pre_freeze: 0 };
  const hash = await policyHash(policy);
  const existing = new Set((await store.selectIn('pred_decisions', { select: 'contract_id,candidate,policy_sha256,correction_of' }, 'contract_id', finals.map((d) => d.contract_id))).filter((r) => !r.correction_of && r.candidate === policy.candidate && r.policy_sha256 === hash).map((r) => r.contract_id));
  const todo = finals.filter((d) => !existing.has(d.contract_id));
  const inputs = await loadDecisionInputs(store, todo.map((d) => d.forecast_id));
  let written = 0; let preFreeze = 0;
  for (const inp of inputs) {
    if (!eligibleForLedger(inp.forecast, policy)) { preFreeze += 1; continue; } // no historical backfill
    const row = await buildDecisionRecord({ ...inp, policy });
    try { await store.write('pred_decisions', row, {}); written += 1; } catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; }
  }
  return { written, skipped_existing: finals.length - todo.length, pre_freeze: preFreeze };
}

// Verify every stored original row against deterministic recomputation with the pinned policy.
export async function verifyDecisions(store, policy = DECISION_POLICY) {
  const rows = (await store.select('pred_decisions', { select: '*', candidate: `eq.${policy.candidate}` }, { order: 'inserted_at.asc' })).filter((r) => !r.correction_of);
  const inputs = await loadDecisionInputs(store, rows.map((r) => r.forecast_id));
  const byF = new Map(inputs.map((i) => [i.forecast.forecast_id, i]));
  const mismatches = [];
  for (const r of rows) {
    const inp = byF.get(r.forecast_id);
    if (!inp) { mismatches.push({ record_key: r.record_key, error: 'inputs_missing' }); continue; }
    // the policy known at decision time: recompute with the row's own activation state (activation never rewrites history)
    const re = await buildDecisionRecord({ ...inp, policy: { ...policy, activated_at: r.policy_activated_at } });
    const diff = compareRecord(r, re);
    if (diff.length) mismatches.push({ record_key: r.record_key, diff });
  }
  return { policy_sha256: await policyHash(policy), stored: rows.length, verified: rows.length - mismatches.length, mismatches };
}
