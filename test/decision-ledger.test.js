// DECISION LEDGER (sql/006 pred_decisions): stored immutable row at designation time + deterministic recomputation.
// Prospective only, one row per contract for the predeclared unit, no market value in a row, verifier catches drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeDecisions, verifyDecisions } from '../workers/pbe-predictions/src/decision-ledger.js';
import { prospectiveRecord } from '../workers/pbe-predictions/src/prospective.js';
import { DECISION_POLICY, policyHash } from '../src/engine/decision.js';
import { findMarketKeys } from '../src/engine/leakage.js';

const prov = [{ source: 'NWS GFS MOS (MAV) station guidance', provider: 'NOAA/NWS', role: 'model input', available_at: '2026-10-05T05:00:00Z' }];
const fc = (id, cid, p, at, cutoff) => ({ forecast_id: id, event_id: 'E', contract_id: cid, market_id: `KX-${cid}`, model_id: 'pbe-weather-precip', model_version: '1.1.0', model_state: 'RESEARCH', probability: p, confidence: 'HIGH', captured_at: at, data_cutoff_at: cutoff, feature_snapshot_id: `s-${id}`, features_sha256: 'f'.repeat(64), provenance: prov, explanation: {}, market_probability: 0.5, market_snapshot_key: 'k' });

function memStore() {
  const t = {
    pred_forecasts: [fc('f1', 'c1', 0.8, '2026-10-05T05:30:00Z', '2026-10-05T05:00:00Z'), fc('f2', 'c2', 0.1, '2026-10-05T05:30:00Z', '2026-10-05T05:00:00Z'), fc('f0', 'c3', 0.9, '2026-10-04T05:00:09Z', '2026-10-04T05:00:00Z')],
    pred_events: [{ event_id: 'E', canonical_question: 'Where will it rain on Oct 6?', metadata: {} }],
    pred_contracts: ['c1', 'c2', 'c3'].map((id) => ({ contract_id: id, event_id: 'E', market_id: `KX-${id}`, normalization_status: 'NORMALIZED', event_type: 'PRECIP_ANY', observation_start: '2026-10-06T05:00:00Z', detail: { climate_date: '2026-10-06' } })),
    pred_feature_snapshots: ['f1', 'f2', 'f0'].map((id) => ({ snapshot_id: `s-${id}`, cutoff_at: id === 'f0' ? '2026-10-04T05:00:00Z' : '2026-10-05T05:00:00Z', features: { nbm_pop_union: 0.6 }, source_observation_keys: [] })),
    pred_decisions: [], pred_resolutions: [],
  };
  const match = (r, q) => Object.entries(q).every(([k, v]) => k === 'select' || (String(v).startsWith('eq.') ? String(r[k]) === String(v).slice(3) : true));
  return {
    t, writes: 0,
    async select(table, q) { return t[table].filter((r) => match(r, q)); },
    async selectIn(table, q, col, ids) { return t[table].filter((r) => ids.includes(r[col]) && match(r, q)); },
    async write(table, row) { if (table === 'pred_decisions' && t.pred_decisions.some((x) => x.record_key === row.record_key)) throw new Error('duplicate key'); this.writes += 1; t[table].push({ decision_id: `d${t[table].length + 1}`, inserted_at: new Date().toISOString(), correction_of: null, ...row }); },
  };
}
const designations = [{ contract_id: 'c1', designation: 'FINAL_PRE_RESOLUTION', forecast_id: 'f1' }, { contract_id: 'c2', designation: 'FINAL_PRE_RESOLUTION', forecast_id: 'f2' }, { contract_id: 'c3', designation: 'FINAL_PRE_RESOLUTION', forecast_id: 'f0' }, { contract_id: 'c1', designation: 'FIRST_PUBLISHED', forecast_id: 'f1' }];

test('writer: one row per FINAL_PRE_RESOLUTION contract after the freeze; no backfill; idempotent', async () => {
  const st = memStore();
  const r1 = await writeDecisions(st, designations);
  assert.deepEqual(r1, { written: 2, skipped_existing: 0, pre_freeze: 1 }, 'the pre-freeze forecast is never written');
  const rows = st.t.pred_decisions;
  assert.deepEqual(rows.map((r) => [r.contract_id, r.state, r.side, r.official_at_decision]), [['c1', 'CALL', 'YES', false], ['c2', 'CALL', 'NO', false]]);
  assert.equal(rows[0].policy_sha256, await policyHash());
  assert.equal(rows[0].decision_as_of, '2026-10-05T05:30:00Z');
  assert.equal(rows[0].designation, 'FINAL_PRE_RESOLUTION');
  for (const r of rows) assert.deepEqual(findMarketKeys(r), [], 'no market / venue field in a decision row');
  const r2 = await writeDecisions(st, designations);
  assert.deepEqual([r2.written, r2.skipped_existing], [0, 2]);
});

test('verifier: stored rows reproduce byte-for-byte; a tampered field is caught; activation never rewrites history', async () => {
  const st = memStore();
  await writeDecisions(st, designations);
  const v = await verifyDecisions(st);
  assert.deepEqual([v.stored, v.verified, v.mismatches.length], [2, 2, 0]);
  st.t.pred_decisions[0] = { ...st.t.pred_decisions[0], side: 'NO' };
  const v2 = await verifyDecisions(st);
  assert.equal(v2.mismatches.length, 1);
  assert.equal(v2.mismatches[0].diff[0].field, 'side');
  // the policy activated later: rows decided before activation still verify as unofficial
  const st3 = memStore(); await writeDecisions(st3, designations);
  const v3 = await verifyDecisions(st3, { ...DECISION_POLICY, activated_at: '2026-11-20T00:00:00Z' });
  assert.equal(v3.mismatches.length, 0);
  assert.ok(st3.t.pred_decisions.every((r) => r.official_at_decision === false));
});

test('prospective record counts the stored ledger only (resolved CALLs, distinct dates, stage)', async () => {
  const st = memStore();
  await writeDecisions(st, designations);
  st.t.pred_resolutions.push({ contract_id: 'c1', venue_result: 'yes' }, { contract_id: 'c2', venue_result: 'yes' });
  const r = await prospectiveRecord(st);
  assert.equal(r.source, 'pred_decisions (stored at designation time)');
  assert.deepEqual([r.decision_records, r.resolved_calls, r.distinct_resolution_dates, r.hit_rate, r.official_records, r.stage], [2, 2, 1, 0.5, 0, 'COLLECTING']);
  assert.deepEqual([r.yes.n, r.yes.hits, r.no.n, r.no.hits], [1, 1, 1, 0]);
});
