// Automated Newsroom V1 acceptance: movers need same-version evidence of changed inputs, anomalies hold, resolution
// reports fail closed on incomplete/ambiguous provenance, validation rejects leakage, IDs dedupe, and an
// unavailable expected source skips publication instead of substituting another model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMover, buildResolution, diffInputs } from '../workers/pbe-predictions/src/newsroom/templates.js';
import { validateStory, storyId, runNewsroom } from '../workers/pbe-predictions/src/newsroom/engine.js';
import { runCycle } from '../workers/pbe-predictions/src/cycle.js';

const contract = { contract_id: 'C1', market_id: 'M1', outcome_label: '95° to 96°', normalization_status: 'NORMALIZED', resolution_authority: 'The Weather Company', resolution_dataset: 'TWC daily max', verification_dataset: 'NWS CLI', measurement_definition: 'max temp', rounding_rule: 'whole', exceptions: [], rules_primary: 'rule' };
const snap = (id, t, pbe, extra = {}) => ({ id, t, pbe, pbe_raw: pbe / 100, market: 50, model: 'pbe-weather-maxtemp@1.1.0', model_id: 'pbe-weather-maxtemp', version: '1.1.0', state: 'RESEARCH', cutoff: t, sha: 'x', feature_snapshot_id: `fs-${id}`, evidence: [], provenance: [], tier: null, roles: [], ...extra });
const packet = (snaps, asOf, extra = {}) => ({ as_of: asOf, event: { id: 'E1', kind: 'exclusive', slug: 'ev', title: 'Highest temperature in Austin on Oct 4, 2026?', category: 'WEATHER', category_label: 'Weather' }, outcomes: [{ contract, market_id: 'M1', label: '95° to 96°', snapshots: snaps, market_path: [{ t: snaps[0].t, mid: 50, bid: 48, ask: 52 }], resolution: null, scores: [], ...extra }] });

test('mover: same version, later cutoff, changed primary input -> built with verifiable claims', () => {
  const p = packet([snap('a', '2026-10-03T18:00:00Z', 20), snap('b', '2026-10-03T23:00:00Z', 45)], '2026-10-03T23:00:00Z');
  const features = new Map([['fs-a', { nbm_max_temp_guidance_f: 95, run_lead_hours: 30 }], ['fs-b', { nbm_max_temp_guidance_f: 97, run_lead_hours: 24 }]]);
  const built = buildMover({ packet: p, marketId: 'M1', s0Id: 'a', s1Id: 'b', features });
  assert.equal(built.ok, true, built.reason);
  assert.deepEqual(validateStory(built, p, p.as_of), []);
  assert.ok(built.claims.some((c) => c.snapshot_id === 'b' && c.value === 45));
});

test('mover holds: no input change, large unexplained jump, mixed versions', () => {
  const p = packet([snap('a', '2026-10-03T18:00:00Z', 20), snap('b', '2026-10-03T23:00:00Z', 60)], '2026-10-03T23:00:00Z');
  const same = new Map([['fs-a', { nbm_max_temp_guidance_f: 95 }], ['fs-b', { nbm_max_temp_guidance_f: 95 }]]);
  assert.equal(buildMover({ packet: p, marketId: 'M1', s0Id: 'a', s1Id: 'b', features: same }).reason, 'NO_INPUT_CHANGE');
  const secondaryOnly = new Map([['fs-a', { nbm_max_temp_guidance_f: 95, run_lead_hours: 30 }], ['fs-b', { nbm_max_temp_guidance_f: 95, run_lead_hours: 24 }]]);
  assert.equal(buildMover({ packet: p, marketId: 'M1', s0Id: 'a', s1Id: 'b', features: secondaryOnly }).reason, 'LARGE_JUMP_UNEXPLAINED');
  const mixed = packet([snap('a', '2026-10-03T18:00:00Z', 20, { model: 'pbe-weather-maxtemp@1.0.0', version: '1.0.0' }), snap('b', '2026-10-03T23:00:00Z', 45)], '2026-10-03T23:00:00Z');
  assert.match(buildMover({ packet: mixed, marketId: 'M1', s0Id: 'a', s1Id: 'b', features: same }).reason, /different model versions/);
  assert.deepEqual(diffInputs({ guidance_error_table: 'x', mos_pop_periods: [1] }, { guidance_error_table: 'y', mos_pop_periods: [2] }, 'pbe-weather-maxtemp'), []);
});

test('validation rejects future snapshots, SHADOW snapshots and claims that do not match the archive', () => {
  const p = packet([snap('a', '2026-10-03T18:00:00Z', 20), snap('b', '2026-10-04T01:00:00Z', 45), snap('c', '2026-10-03T19:00:00Z', 30, { state: 'SHADOW' })], '2026-10-03T23:00:00Z');
  const problems = validateStory({ title: 't', dek: 'd', sections: 's', card: {}, claims: [{ kind: 'pbe', snapshot_id: 'a', value: 21 }, { kind: 'pbe', snapshot_id: 'zzz', value: 1 }] }, p, p.as_of);
  assert.ok(problems.some((x) => /after story cutoff/.test(x)));
  assert.ok(problems.some((x) => /non-public/.test(x)));
  assert.ok(problems.some((x) => /21% != snapshot 20%/.test(x)));
  assert.ok(problems.some((x) => /unknown snapshot/.test(x)));
});

test('story ids are deterministic: the same trigger cannot produce two stories', async () => {
  const a = await storyId(['MOVER', 'M1', 'a', 'b']);
  assert.equal(a, await storyId(['MOVER', 'M1', 'a', 'b']));
  assert.notEqual(a, await storyId(['MOVER', 'M1', 'a', 'c']));
});

const resolved = (extra = {}) => ({ resolution_id: 'R1', venue_result: 'yes', official_outcome: 'YES', official_value: 96, official_units: '°F', sources_agree: true, resolved_at: '2026-10-05T09:00:00Z', venue_settled_at: '2026-10-05T09:00:00Z', official_source: 'NWS CLI CLIAUS', ...extra });
const scored = [{ designation: 'FINAL_PRE_RESOLUTION', scoring_method: 'brier', score: 0.3, benchmark_score: 0.2 }, { designation: 'FINAL_PRE_RESOLUTION', scoring_method: 'log_loss', score: 0.9, benchmark_score: 0.7 }];
const finalSnap = () => [snap('a', '2026-10-03T18:00:00Z', 20, { roles: ['FIRST_PUBLISHED'] }), snap('b', '2026-10-04T05:00:00Z', 45, { roles: ['FINAL_PRE_RESOLUTION'] })];

test('resolution report: complete provenance builds; every displayed probability validates', () => {
  const p = packet(finalSnap(), '2026-10-05T09:00:01Z', { resolution: resolved(), scores: scored });
  const built = buildResolution({ packet: p, familyResolved: 12 });
  assert.equal(built.ok, true, built.reason);
  assert.deepEqual(validateStory(built, p, p.as_of), []);
  assert.match(built.sections, /12 resolved in total/);
});

test('resolution report fails closed on missing/disagreeing official check, void result, missing designation or score', () => {
  const cases = [
    [{ resolution: resolved({ official_outcome: null }) }, /official verification missing/],
    [{ resolution: resolved({ sources_agree: false }) }, /disagree/],
    [{ resolution: resolved({ venue_result: 'void' }) }, /not yes\/no/],
    [{ resolution: null }, /unresolved/],
  ];
  for (const [extra, re] of cases) assert.match(buildResolution({ packet: packet(finalSnap(), '2026-10-05T09:00:01Z', { scores: scored, ...extra }) }).reason, re);
  const noFinal = packet([snap('a', '2026-10-03T18:00:00Z', 20, { roles: ['FIRST_PUBLISHED'] })], '2026-10-05T09:00:01Z', { resolution: resolved(), scores: scored });
  assert.match(buildResolution({ packet: noFinal }).reason, /FINAL_PRE_RESOLUTION/);
  assert.match(buildResolution({ packet: packet(finalSnap(), '2026-10-05T09:00:01Z', { resolution: resolved(), scores: [] }) }).reason, /not scored/);
});

function fakeStore(tables) {
  const match = (row, q) => Object.entries(q).every(([k, v]) => {
    if (k === 'select' || typeof v !== 'string') return true;
    const i = v.indexOf('.'); const op = v.slice(0, i); const val = v.slice(i + 1);
    if (op === 'eq') return String(row[k]) === val;
    if (op === 'gte') return Date.parse(row[k]) >= Date.parse(val);
    if (op === 'lte') return Date.parse(row[k]) <= Date.parse(val);
    return true;
  });
  return { select: async (t, q) => (tables[t] || []).filter((r) => match(r, q)), selectIn: async (t, q, col, ids) => (tables[t] || []).filter((r) => ids.includes(r[col]) && match(r, q)) };
}

test('engine: HOLD_RESOLUTION_AMBIGUOUS contracts hold the resolution report; same-cutoff version change is flagged, not a mover', async () => {
  const now = '2026-10-05T10:00:00Z';
  const f = (id, t, p, v, cutoff) => ({ forecast_id: id, contract_id: 'C1', model_id: 'pbe-weather-maxtemp', model_version: v, model_state: 'RESEARCH', probability: p, market_probability: 0.5, captured_at: t, data_cutoff_at: cutoff, feature_snapshot_id: `fs-${id}`, explanation: {} });
  const store = fakeStore({
    pred_events: [{ event_id: 'E1', slug: 'ev', canonical_question: 'Q?', category: 'WEATHER', close_time: now }],
    pred_contracts: [{ ...contract, event_id: 'E1', normalized_at: '2026-10-03T10:00:00Z', observation_start: '2026-10-05T05:00:00Z' }, { ...contract, contract_id: 'C2', market_id: 'M2', normalization_status: 'HOLD_RESOLUTION_AMBIGUOUS', event_id: 'E1', normalized_at: '2026-10-03T10:00:00Z' }],
    pred_forecasts: [f('a', '2026-10-04T18:31:00Z', 0.24, '1.0.0', '2026-10-04T17:00:00Z'), f('b', '2026-10-04T18:45:00Z', 0.08, '1.1.0', '2026-10-04T17:00:00Z')],
    pred_resolutions: [{ ...resolved(), contract_id: 'C1', event_id: 'E1', resolved_at: '2026-10-05T09:00:00Z' }],
  });
  const r = await runNewsroom(store, { now });
  const rep = r.stories.find((s) => s.class === 'RESOLUTION_REPORT');
  assert.equal(rep.state, 'HELD');
  assert.match(rep.reason, /RESOLUTION_AMBIGUOUS/);
  assert.ok(r.anomalies.some((a) => a.flag === 'SAME_CUTOFF_VERSION_CHANGE'));
  assert.equal(r.stories.filter((s) => s.class === 'FORECAST_MOVER').length, 0);
});

test('expected NBM guidance unavailable -> the station is skipped (recorded), never published from GFS-only', async () => {
  const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
  const fixtures = { KXHIGHNY: read('./fixtures/kalshi/KXHIGHNY-26OCT04.json') };
  const markets = { requests: 0, async series(t) { return fixtures[t].series; }, async openEvents(t) { return { events: [{ ...fixtures[t].event, markets: fixtures[t].markets }] }; }, async marketsByTicker() { return []; } };
  const fetchImpl = (url) => {
    const u = String(url);
    if (/model=NBS/.test(u)) return Promise.reject(new Error('network error'));
    const m = /mos\.json\?station=([A-Z]{4})/.exec(u);
    if (m) { try { return Promise.resolve(new Response(JSON.stringify(read(`./fixtures/weather/mos-${m[1]}.json`)), { status: 200 })); } catch { return Promise.resolve(new Response('{}', { status: 404 })); } }
    return Promise.resolve(new Response('{}', { status: 404 }));
  };
  const { summary, writes } = await runCycle({ WEATHER_SERIES: 'KXHIGHNY' }, { markets, fetchImpl, now: '2026-10-03T18:30:00.000Z', dryRun: true });
  assert.equal(writes.forecasts.length, 0);
  const keys = Object.keys(summary.skipped);
  assert.ok(keys.some((k) => k.startsWith('station:')), JSON.stringify(summary.skipped));
  assert.match(Object.values(summary.skipped)[0].detail, /NBM fetch failed .* holding station/);
});
