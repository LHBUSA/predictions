// PREDICTIONS V4 — decision layer + evidence packet. Facts create the PBE probability and the decision; Kalshi and
// Polymarket only benchmark afterwards. Absurd venue prices must leave features_sha256, probability, confidence,
// the evidence packet hash and CALL/PASS/HOLD byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, decisionInput, assertDecisionInput, DECISION_POLICY, DECISION_INPUT_KEYS, REASONS, isOfficial, policyHash } from '../src/engine/decision.js';
import { buildEvidencePacket, checkIntegrity, canonicalJson, driverSentence, DRIVER_SPECS } from '../src/engine/evidence.js';
import { MarketLeakageError } from '../src/engine/leakage.js';
import { runAllLanes, polymarketVenue } from './helpers/venue-harness.js';

const NOW = '2026-10-04T12:00:00.000Z';
// A test-only policy with every family validated, so every branch of the decision is exercised.
const TEST_POLICY = Object.freeze({
  ...DECISION_POLICY, status: 'ACTIVE_TEST', activated_at: '2026-10-04T00:00:00Z', version: 'prediction-decision-test',
  families: Object.fromEntries(Object.entries(DECISION_POLICY.families).map(([k, v]) => [k, { ...v, validated: true, threshold: 0.65 }])),
});
const base = { model_id: 'pbe-weather-precip', model_version: '1.1.0', model_state: 'RESEARCH', probability: 0.7, confidence: 'HIGH', data_cutoff_at: '2026-10-04T05:00:00Z', as_of: NOW, contract_status: 'NORMALIZED', contract_reason: null, integrity_ok: true, is_modal: null, exclusive: false, contract_month: 10, decision_time: '2026-10-04T05:30:00Z' };

test('input allowlist: any venue-derived key is refused; unknown keys are refused', () => {
  for (const k of ['kalshi_mid', 'polymarket_price', 'market_probability', 'bid', 'ask', 'mid_bp', 'spread_bp', 'volume', 'liquidity', 'venue_gap_pts', 'consensus_prob', 'last_price']) {
    assert.throws(() => decide({ ...base, [k]: 0.5 }), MarketLeakageError, k);
  }
  assert.throws(() => decide({ ...base, foo: 1 }), /not allowlisted/);
  assert.deepEqual(Object.keys(assertDecisionInput({ ...base })).sort(), [...DECISION_INPUT_KEYS].sort());
});

test('decisionInput never copies a market column from a forecast row', () => {
  const f = { model_id: 'pbe-weather-precip', model_version: '1.1.0', model_state: 'RESEARCH', probability: 0.7, confidence: 'HIGH', data_cutoff_at: base.data_cutoff_at, market_probability: 0.1, market_snapshot_key: 'x', market_observed_at: NOW, divergence_points: 60 };
  const a = decisionInput({ forecast: f, contract: { normalization_status: 'NORMALIZED' }, integrityOk: true, asOf: NOW });
  const b = decisionInput({ forecast: { ...f, market_probability: 0.99, divergence_points: -29 }, contract: { normalization_status: 'NORMALIZED' }, integrityOk: true, asOf: NOW });
  assert.deepEqual(a, b);
  assert.deepEqual(decide(a, TEST_POLICY), decide(b, TEST_POLICY));
});

test('OFFICIAL policy (owner 2026-10-09): frozen rain-v1 activated prospectively; only precip can CALL; temperature/rates/Fed never official', () => {
  assert.equal(DECISION_POLICY.status, 'OFFICIAL');
  assert.equal(DECISION_POLICY.frozen_at, '2026-10-04T13:21:00Z');
  assert.equal(DECISION_POLICY.activated_at, '2026-10-09T21:15:00Z');
  assert.deepEqual(Object.entries(DECISION_POLICY.families).filter(([, f]) => f.validated).map(([k]) => k), ['pbe-weather-precip'], 'activation enables rain only');
  const post = { decision_time: '2026-10-10T05:30:00Z', data_cutoff_at: '2026-10-10T05:00:00Z', as_of: '2026-10-10T06:00:00Z' };
  for (const fam of ['pbe-weather-maxtemp', 'pbe-rates-path', 'pbe-fed-decision']) for (const p of [0.99, 0.9, 0.75, 0.25, 0.05]) {
    const d = decide({ ...base, ...post, model_id: fam, probability: p });
    assert.deepEqual([d.state, ...d.reasons], ['PASS', 'MODEL_NOT_VALIDATED'], `${fam} ${p}: valid forecast, unvalidated model = PASS, never a pick`);
  }
  const P = (x) => decide({ ...base, data_cutoff_at: '2026-10-04T05:00:00Z', as_of: '2026-10-04T12:00:00Z', ...x });
  assert.deepEqual([P({ probability: 0.72, contract_month: 10 }).state, P({ probability: 0.72, contract_month: 10 }).side, P({}).official], ['CALL', 'YES', false], 'a pre-activation (Oct 4) call stays research');
  const A = decide({ ...base, ...post, probability: 0.72, contract_month: 10 });
  assert.deepEqual([A.state, A.side, A.official, A.policy_status], ['CALL', 'YES', true, 'OFFICIAL'], 'a post-activation rain call is official');
  assert.deepEqual([P({ probability: 0.72, contract_month: 7 }).state, ...P({ probability: 0.72, contract_month: 7 }).reasons], ['PASS', 'MODEL_NOT_VALIDATED']);
  assert.deepEqual([P({ probability: 0.2, contract_month: 7 }).state, P({ probability: 0.2, contract_month: 7 }).side], ['CALL', 'NO']);
  assert.deepEqual([...P({ probability: 0.65 }).reasons], ['WITHIN_UNCERTAINTY_BAND']);
  assert.deepEqual([...P({ as_of: '2026-10-04T18:00:00Z' }).reasons], ['STALE_EVIDENCE'], '12 h freshness limit');
});

test('states and reasons (validated test policy)', () => {
  const D = (x) => decide({ ...base, ...x }, TEST_POLICY);
  assert.deepEqual([D({}).state, D({}).side], ['CALL', 'YES']);
  assert.deepEqual([D({ probability: 0.3 }).state, D({ probability: 0.3 }).side], ['CALL', 'NO']);
  assert.deepEqual([D({ probability: 0.55 }).state, [...D({ probability: 0.55 }).reasons]], ['PASS', ['WITHIN_UNCERTAINTY_BAND']]);
  assert.deepEqual([...D({ probability: 0.98 }).reasons], ['NEAR_CERTAIN']);
  assert.deepEqual([...D({ probability: 0.02 }).reasons], ['NEAR_CERTAIN']);
  assert.deepEqual([...D({ confidence: 'MEDIUM' }).reasons], ['INSUFFICIENT_CONFIDENCE']);
  assert.deepEqual([...D({ as_of: '2026-10-06T12:00:00Z' }).reasons], ['STALE_EVIDENCE']);
  assert.deepEqual([...D({ integrity_ok: false }).reasons], ['EVIDENCE_INTEGRITY_FAILED']);
  assert.deepEqual([D({ model_state: 'SHADOW', model_id: 'pbe-fed-decision' }).state, ...D({ model_state: 'SHADOW', model_id: 'pbe-fed-decision' }).reasons], ['PASS', 'MODEL_NOT_VALIDATED']);
  // HOLD = cannot evaluate responsibly; it outranks PASS even for an unvalidated model
  assert.deepEqual([D({ model_id: 'pbe-fed-decision', model_state: 'SHADOW', as_of: '2026-10-20T00:00:00Z' }).state], ['HOLD']);
  assert.deepEqual([D({ model_id: 'pbe-rates-path', integrity_ok: false }).state], ['HOLD']);
  assert.deepEqual([...D({ probability: null }).reasons], ['INSUFFICIENT_SOURCE_DATA']);
  assert.deepEqual([...D({ model_id: 'corporate-fundamentals' }).reasons], ['UNSUPPORTED_DOMAIN']);
  for (const s of ['UNMODELABLE', 'HOLD_RESOLUTION_AMBIGUOUS', 'UNSUPPORTED_DOMAIN']) assert.deepEqual([...D({ contract_status: s }).reasons], [s]);
  // exclusive bucket family (max temp = modal_only): only the PBE-modal outcome can be called; never CALL NO
  assert.deepEqual([D({ model_id: 'pbe-weather-maxtemp', exclusive: true, is_modal: true, probability: 0.7 }).state], ['CALL']);
  assert.deepEqual([...D({ model_id: 'pbe-weather-maxtemp', exclusive: true, is_modal: false, probability: 0.7 }).reasons], ['NOT_MODAL_OUTCOME']);
  assert.deepEqual([...D({ model_id: 'pbe-weather-maxtemp', exclusive: true, is_modal: false, probability: 0.1 }).reasons], ['NOT_MODAL_OUTCOME']);
  for (const d of [D({}), D({ probability: 0.55 }), D({ integrity_ok: false })]) assert.ok(d.reasons.every((r) => REASONS[r]), 'every reason is a documented code');
});

test('evidence packet: drivers resolve to stored feature values; integrity rules catch future facts and market keys', async () => {
  const forecast = { forecast_id: 'f1', contract_id: 'c1', model_id: 'pbe-weather-precip', model_version: '1.1.0', model_state: 'RESEARCH', probability: 0.68, confidence: 'HIGH', captured_at: '2026-10-04T11:00:09Z', data_cutoff_at: '2026-10-04T11:00:00Z', feature_snapshot_id: 's1', features_sha256: 'abc',
    provenance: [{ source: 'NWS GFS MOS (MAV) station guidance', provider: 'NOAA/NWS', role: 'model input', available_at: '2026-10-04T11:00:00Z' }, { source: 'NWS National Blend of Models (NBS) station guidance', provider: 'NOAA/NWS', role: 'model input', available_at: '2026-10-04T11:00:00Z' }, { source: 'Station climatology 1991-2020', provider: 'ACIS', role: 'model input' }, { source: 'NWS gridpoint forecast', role: 'evidence (not a model input in v1)', updated_at: '2026-10-04T10:00:00Z' }],
    explanation: { model_tier: 'v1.1 GFS MOS + NBM', evidence: [{ label: 'x', value: 1, unit: '%' }] } };
  const snapshot = { snapshot_id: 's1', cutoff_at: '2026-10-04T11:00:00Z', features: { nbm_pop_union: 0.62, mos_pop_union: 0.58, climatology_rate_1991_2020: 0.33, run_lead_hours: 23 } };
  const { packet, sha256 } = await buildEvidencePacket({ event: { event_id: 'E', canonical_question: 'Rain?' }, contract: { contract_id: 'c1', yes_condition: '> 0.00 in' }, forecast, snapshot });
  assert.equal(packet.integrity.ok, true);
  assert.deepEqual(packet.drivers.map((d) => [d.feature, d.display]), [['nbm_pop_union', '62'], ['mos_pop_union', '58'], ['climatology_rate_1991_2020', '33'], ['run_lead_hours', '23']]);
  for (const d of packet.drivers) assert.equal(d.value, snapshot.features[d.feature], 'every driver number is the stored feature value');
  assert.match(driverSentence(packet), /National Blend of Models: chance of rain in the climate day 62%/);
  // same rows, any key order -> same hash (jsonb reorders keys)
  const again = await buildEvidencePacket({ event: { canonical_question: 'Rain?', event_id: 'E' }, contract: { yes_condition: '> 0.00 in', contract_id: 'c1' }, forecast: { ...forecast }, snapshot: { ...snapshot, features: Object.fromEntries(Object.entries(snapshot.features).reverse()) } });
  assert.equal(again.sha256, sha256);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
  // violations
  const late = checkIntegrity({ forecast: { ...forecast, provenance: [{ ...forecast.provenance[1], available_at: '2026-10-04T12:00:00Z' }] }, snapshot });
  assert.deepEqual(late.violations.map((v) => v.rule).sort(), ['evidence_after_publication', 'source_after_cutoff']);
  assert.deepEqual(checkIntegrity({ forecast, snapshot: { ...snapshot, features: { ...snapshot.features, kalshi_mid: 0.4 } } }).violations.map((v) => v.rule), ['market_key_in_features']);
  assert.deepEqual(checkIntegrity({ forecast, snapshot: null }).violations.map((v) => v.rule), ['feature_snapshot_missing']);
  assert.deepEqual(checkIntegrity({ forecast: { ...forecast, data_cutoff_at: '2026-10-04T11:30:00Z' }, snapshot }).violations.map((v) => v.rule).sort(), ['cutoff_after_publication', 'snapshot_cutoff_mismatch']);
});

test('every live feature named in a driver spec exists in the model outputs (no dead driver)', async () => {
  const r = await runAllLanes({ nbm: true });
  const seen = new Map();
  for (const fs of r.writes.features) for (const k of Object.keys(fs.features)) seen.set(`${fs.model_id}|${k}`, true);
  for (const [fam, spec] of Object.entries(DRIVER_SPECS)) { if (/-intraday$/.test(fam)) continue; for (const s of spec) assert.ok(seen.has(`${fam}|${s.feature}`), `${fam}.${s.feature}`); }
  // intraday families: every driver feature is a feature the intraday engine actually emits
  const eng = readFileSync(new URL('../src/weather/intraday/engine.js', import.meta.url), 'utf8');
  for (const fam of ['pbe-weather-maxtemp-intraday', 'pbe-weather-precip-intraday']) for (const s of DRIVER_SPECS[fam]) assert.ok(eng.includes(`name: '${s.feature}'`), `${fam}.${s.feature}`);
});

function mulberry32(seed) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sizeOrPrice = (k, priceFn, sizeFn) => (/volume|open_interest|liquidity/i.test(k) ? sizeFn() : priceFn());

async function decisionSide(run) {
  const out = [];
  for (const f of run.writes.forecasts) {
    const snap = run.writes.features.find((x) => x.snapshot_id === f.feature_snapshot_id);
    const contract = run.writes.contracts.find((c) => c.contract_id === f.contract_id);
    const { packet, sha256 } = await buildEvidencePacket({ event: { event_id: f.event_id }, contract, forecast: { ...f, forecast_id: f.record_id }, snapshot: snap });
    const d = decide(decisionInput({ forecast: f, contract, integrityOk: packet.integrity.ok, asOf: f.captured_at }), TEST_POLICY);
    out.push({ id: f.record_id, features_sha256: f.features_sha256, probability: f.probability, confidence: f.confidence, evidence_sha256: sha256, integrity: packet.integrity.ok, state: d.state, side: d.side, reasons: d.reasons });
  }
  return JSON.stringify(out);
}

test('INVARIANT: absurd Kalshi AND Polymarket prices leave features_sha256, probability, confidence, evidence hash and CALL/PASS/HOLD byte-identical', async () => {
  const baseRun = await runAllLanes({ nbm: true });
  const baseSide = await decisionSide(baseRun);
  const parsed = JSON.parse(baseSide);
  assert.ok(parsed.length >= 80, 'covers every live lane');
  assert.ok(parsed.every((x) => x.integrity), 'every harness packet passes integrity');
  assert.ok(new Set(parsed.map((x) => x.state)).size >= 2, 'decisions are not all one state (the test exercises the policy)');
  const rnd = mulberry32(20261004);
  for (const [name, s] of Object.entries({
    all_0c: { price: (v, k) => sizeOrPrice(k, () => '0.0000', () => '0.00'), polymarket: polymarketVenue(0) },
    all_99c: { price: (v, k) => sizeOrPrice(k, () => '0.9900', () => '99999999.00'), polymarket: polymarketVenue(0.99) },
    random: { price: (v, k) => sizeOrPrice(k, () => rnd().toFixed(4), () => (rnd() * 1e7).toFixed(2)), polymarket: polymarketVenue(0.37) },
  })) {
    const r = await runAllLanes({ nbm: true, ...s });
    assert.equal(await decisionSide(r), baseSide, name);
    assert.notDeepEqual(r.writes.forecasts.map((f) => f.market_probability), baseRun.writes.forecasts.map((f) => f.market_probability), `${name}: the venue side did move`);
  }
});

// Frozen candidate parameters (owner 2026-10-04). Changing ANY of these = a new candidate version, never an edit.
test('FROZEN: rain-v1-candidate parameters are pinned', async () => {
  const { canonicalJson } = await import('../src/engine/evidence.js');
  const { createHash } = await import('node:crypto');
  const frozen = { version: DECISION_POLICY.version, candidate: DECISION_POLICY.candidate, frozen_at: DECISION_POLICY.frozen_at, near_certain: DECISION_POLICY.near_certain, families: DECISION_POLICY.families, promotion: DECISION_POLICY.promotion };
  const h = createHash('sha256').update(canonicalJson(frozen)).digest('hex');
  assert.equal(h, FROZEN_SHA256, `frozen policy changed (${h}) — create a new candidate version instead`);
  const rain = DECISION_POLICY.families['pbe-weather-precip'];
  assert.deepEqual([rain.validated, rain.threshold, rain.confidence_floor, [...rain.no_yes_months], DECISION_POLICY.near_certain], [true, 0.7, 'HIGH', [6, 7, 8, 9], 0.97]);
  assert.deepEqual([DECISION_POLICY.promotion.interim_diagnostic_at, DECISION_POLICY.promotion.promotion_review_at], [100, 300]);
});
const FROZEN_SHA256 = 'fb495f6779e492174f54202543951d304065b6ec0de5fa3bc9db134dd44ce475';

// NO RETROACTIVE OFFICIAL CALLS (owner 2026-10-04)
test('activation invariant: a pre-activation decision stays unofficial forever; only decisions at/after activation are official', () => {
  const oct5 = { forecast: { model_id: 'pbe-weather-precip', model_version: '1.1.0', model_state: 'RESEARCH', probability: 0.8, confidence: 'HIGH', data_cutoff_at: '2026-10-05T05:00:00Z', captured_at: '2026-10-05T05:30:00Z' }, contract: { normalization_status: 'NORMALIZED', observation_start: '2026-10-06T05:00:00Z' }, integrityOk: true };
  // 1. frozen candidate, no activation -> Oct 5 decision unofficial
  const d1 = decide(decisionInput({ ...oct5, asOf: oct5.forecast.captured_at }));
  assert.deepEqual([d1.state, d1.side, d1.official], ['CALL', 'YES', false]);
  // 2. activated Nov 20 -> recomputing Oct 5 (even "now", after activation) stays unofficial
  const activated = { ...DECISION_POLICY, activated_at: '2026-11-20T00:00:00Z' };
  assert.equal(decide(decisionInput({ ...oct5, asOf: oct5.forecast.captured_at }), activated).official, false);
  assert.equal(decide(decisionInput({ ...oct5, asOf: oct5.forecast.captured_at }), activated).state, 'CALL');
  // 3. a decision made on/after Nov 20 is official
  const nov21 = { ...oct5, forecast: { ...oct5.forecast, captured_at: '2026-11-21T05:30:00Z', data_cutoff_at: '2026-11-21T05:00:00Z' }, contract: { ...oct5.contract, observation_start: '2026-11-22T05:00:00Z' } };
  assert.equal(decide(decisionInput({ ...nov21, asOf: nov21.forecast.captured_at }), activated).official, true);
  assert.equal(isOfficial(activated, '2026-11-20T00:00:00Z'), true, 'at activation counts');
  // 4. no historical/backfilled row becomes official because activated_at is later populated, and no decision time = never official
  for (const t of ['2026-10-04T13:21:00Z', '2026-11-19T23:59:59Z', null, undefined]) assert.equal(isOfficial(activated, t), false, String(t));
  assert.equal(isOfficial({ ...DECISION_POLICY, activated_at: null }, '2027-01-01T00:00:00Z'), false, 'not activated -> never official');
  // 5. the production activation: strictly prospective from 2026-10-09T21:15:00Z
  assert.equal(isOfficial(DECISION_POLICY, '2026-10-09T21:14:59.999Z'), false);
  assert.equal(isOfficial(DECISION_POLICY, '2026-10-09T21:15:00Z'), true);
});

test('policyHash = the pinned frozen hash (one definition shared by tests and the decision ledger)', async () => {
  assert.equal(await policyHash(), FROZEN_SHA256);
});

test('evidence hash contract: wording never moves it (driver labels, context prose, limitation prose, question); facts do', async () => {
  const prov = [{ source: 'NWS National Blend of Models (NBS) station guidance', provider: 'NOAA/NWS', role: 'model input', available_at: '2026-10-05T05:00:00Z', run: '2026-10-05T00:00:00Z' }];
  const forecast = { forecast_id: 'f1', contract_id: 'c1', model_id: 'pbe-weather-maxtemp', model_version: '1.1.0', model_state: 'RESEARCH', probability: 0.3, confidence: 'HIGH', captured_at: '2026-10-05T05:30:00Z', data_cutoff_at: '2026-10-05T05:00:00Z', feature_snapshot_id: 's1', features_sha256: 'a', provenance: prov,
    explanation: { evidence: [{ label: 'National Blend of Models high', value: 69, unit: '°F', detail: 'NBM 00Z run; blend spread ±2°F' }] } };
  const snapshot = { snapshot_id: 's1', cutoff_at: '2026-10-05T05:00:00Z', features: { nbm_max_temp_guidance_f: 69, guidance_error_table: 'temp-nbm-v1.1:CLIPHL:le30h:station:n=1820' } };
  const base = { event: { event_id: 'E', canonical_question: 'Highest temperature in Philadelphia?' }, contract: { contract_id: 'c1', rules_sha256: 'r1' }, forecast, snapshot, limitations: ['Pre-window only'] };
  const { sha256 } = await buildEvidencePacket(base);
  const h = async (o) => (await buildEvidencePacket({ ...base, ...o })).sha256;
  const { factualCore } = await import('../src/engine/evidence.js');
  const { createHash } = await import('node:crypto');
  const { packet } = await buildEvidencePacket(base);
  // wording only -> same hash
  const relabeled = { ...packet, drivers: packet.drivers.map((d) => ({ ...d, label: `${d.label} (renamed)`, display: 'x', unit: '?' })) };
  assert.equal(createHash('sha256').update(canonicalJson(factualCore(relabeled))).digest('hex'), sha256, 'driver labels');
  assert.equal(await h({ forecast: { ...forecast, explanation: { evidence: [{ label: 'NBM day high', value: 69, unit: 'F', detail: 'reworded detail' }] } } }), sha256, 'context display wording');
  assert.equal(await h({ limitations: ['Forecasts are published only before the climate day opens (reworded)'] }), sha256, 'limitation prose');
  assert.equal(await h({ event: { event_id: 'E', canonical_question: 'Philadelphia high temperature (venue retitled)?' } }), sha256, 'mutable registry question');
  // facts -> different hash
  assert.notEqual(await h({ snapshot: { ...snapshot, features: { ...snapshot.features, nbm_max_temp_guidance_f: 70 } } }), sha256, 'feature value');
  assert.notEqual(await h({ forecast: { ...forecast, probability: 0.31 } }), sha256, 'probability');
  assert.notEqual(await h({ forecast: { ...forecast, provenance: [{ ...prov[0], provider: 'NOAA/NWS (other)' }] } }), sha256, 'source');
  assert.notEqual(await h({ forecast: { ...forecast, provenance: [{ ...prov[0], available_at: '2026-10-05T04:00:00Z' }] } }), sha256, 'source availability time');
  assert.notEqual(await h({ forecast: { ...forecast, data_cutoff_at: '2026-10-05T04:30:00Z' }, snapshot: { ...snapshot, cutoff_at: '2026-10-05T04:30:00Z' } }), sha256, 'data cutoff');
  assert.notEqual(await h({ contract: { contract_id: 'c1', rules_sha256: 'r2' } }), sha256, 'contract rules hash');
  // FROZEN hash contract: field list + golden hash of this fixture. Changing either = a new evidence schema.
  const { EVIDENCE_HASH_EXCLUDED, EVIDENCE_SCHEMA } = await import('../src/engine/evidence.js');
  assert.deepEqual([...EVIDENCE_HASH_EXCLUDED], ['context', 'limitations', 'question']);
  assert.equal(EVIDENCE_SCHEMA, 'pbe-evidence/1');
  assert.equal(sha256, GOLDEN_EVIDENCE_SHA256, `evidence hash contract changed (${sha256})`);
});
const GOLDEN_EVIDENCE_SHA256 = '2f697fff3c4a056eea9c532c407a9c69d657e1d1aa6f0c84bf09bd18a4b79280';
