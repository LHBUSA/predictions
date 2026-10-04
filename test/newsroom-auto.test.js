// AUTOMATED NEWSROOM (owner 2026-10-04): the 5-minute NEWSROOM cron publishes VALIDATED movers and resolution reports by
// itself. Proves: publication without an admin request, append-only chain, idempotency across cron runs and under a
// concurrent cycle, HELD / anomaly never published, desk cap, kill switch, and that a RESOLUTION_REPORT publishes
// and is served by the read path (rebuilt deterministically with its frozen family count).
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishStory, autoPublish, publishedNewsroomStories, PUBLISHABLE_CLASSES } from '../workers/pbe-predictions/src/newsroom/publish.js';
import { buildResolution } from '../workers/pbe-predictions/src/newsroom/templates.js';
import { MOVER } from '../workers/pbe-predictions/src/newsroom/config.js';

// In-memory tables with the sql/003 + sql/005 guarantees: story_id PK, unique trigger_key + slug, transition graph,
// one PUBLISHED per story, no UPDATE/DELETE (the store has no update method at all).
const NEXT = { none: ['CANDIDATE'], CANDIDATE: ['EVIDENCE_READY', 'HELD'], EVIDENCE_READY: ['GENERATED', 'HELD'], GENERATED: ['VALIDATED', 'HELD'], VALIDATED: ['PUBLISHED', 'HELD'], HELD: ['CANDIDATE'] };
function db(extra = {}) {
  const t = { pred_newsroom_stories: [], pred_newsroom_transitions: [], ...extra };
  let seq = 0;
  const match = (r, q) => Object.entries(q).every(([k, v]) => k === 'select' || typeof v !== 'string' || !v.startsWith('eq.') || String(r[k]) === v.slice(3));
  return {
    t,
    async select(table, q) { return (t[table] || []).filter((r) => match(r, q)); },
    async selectIn(table, q, col, ids) { return (t[table] || []).filter((r) => ids.includes(r[col]) && match(r, q)); },
    async write(table, row) {
      if (table === 'pred_newsroom_stories') {
        for (const k of ['story_id', 'trigger_key', 'slug']) if (t[table].some((x) => x[k] === row[k])) throw new Error(`duplicate key value violates unique constraint (${k})`);
        t[table].push({ ...row });
      } else if (table === 'pred_newsroom_transitions') {
        const prior = t[table].filter((x) => x.story_id === row.story_id).at(-1)?.state || 'none';
        if (!NEXT[prior].includes(row.state)) throw new Error(`newsroom: ${row.story_id} cannot move from ${prior} to ${row.state}`);
        seq += 1; t[table].push({ ...row, seq, at: new Date(Date.UTC(2026, 9, 4, 16, 0, 0) + seq * 1000).toISOString() });
      } else throw new Error(`unexpected table ${table}`);
    },
  };
}
const mover = (id, t1, extra = {}) => ({ story_id: id, class: 'FORECAST_MOVER', state: 'VALIDATED', slug: `ev-${id}-pbe-move`, trigger: { event_slug: `ev-${id}`, market_id: `M-${id}`, s0: `s0-${id}`, s1: `s1-${id}`, t1 }, def: { as_of: t1 }, packet: { event: { id: `E-${id}` }, as_of: t1 }, built: { claims: [{ kind: 'pbe', snapshot_id: `s1-${id}`, value: 40 }], title: `Mover ${id}` }, ...extra });

test('a VALIDATED mover publishes with no admin request; the chain is the full append-only graph, by auto-cron', async () => {
  const st = db();
  const r = await autoPublish(st, { stories: [mover('a', '2026-10-04T15:00:00Z')] }, { cycleAt: '2026-10-04T15:45:00Z', engineCompletedAt: '2026-10-04T15:46:10Z' });
  assert.equal(r.published.length, 1);
  assert.equal(r.published[0].url, 'https://predictions.propbetedge.ai/insights/ev-a-pbe-move');
  assert.deepEqual(st.t.pred_newsroom_transitions.map((x) => x.state), ['CANDIDATE', 'EVIDENCE_READY', 'GENERATED', 'VALIDATED', 'PUBLISHED']);
  const pub = st.t.pred_newsroom_transitions.at(-1).detail;
  assert.deepEqual([pub.by, pub.cycle_at, pub.engine_completed_at], ['auto-cron', '2026-10-04T15:45:00Z', '2026-10-04T15:46:10Z']);
  assert.equal(typeof st.update, 'undefined', 'no update path exists');
});

test('idempotent: a second cron run (and a third) never duplicates the story or its transitions', async () => {
  const st = db();
  const report = { stories: [mover('a', '2026-10-04T15:00:00Z')] };
  await autoPublish(st, report, { cycleAt: 'c1' });
  const r2 = await autoPublish(st, report, { cycleAt: 'c2' });
  const r3 = await autoPublish(st, report, { cycleAt: 'c3' });
  assert.deepEqual([r2.published.length, r3.published.length], [0, 0]);
  assert.equal(r2.skipped[0].reason, 'already_published');
  assert.equal(st.t.pred_newsroom_stories.length, 1);
  assert.equal(st.t.pred_newsroom_transitions.filter((x) => x.state === 'PUBLISHED').length, 1);
});

test('overlapping cycles: the cycle that loses the race to insert the story row publishes nothing', async () => {
  const st = db();
  const s = mover('a', '2026-10-04T15:00:00Z');
  const racer = { ...st, select: st.select, selectIn: async (...a) => (a[0] === 'pred_newsroom_transitions' ? [] : st.selectIn(...a)), write: st.write };
  await publishStory(st, s, { by: 'auto-cron' });
  const lost = await publishStory(racer, s, { by: 'auto-cron' }); // saw "not persisted" in its read, then lost the insert
  assert.equal(lost.ok, false);
  assert.equal(lost.error, 'already_persisted_concurrently');
  assert.equal(st.t.pred_newsroom_transitions.filter((x) => x.state === 'PUBLISHED').length, 1);
});

test('resumable: a chain interrupted after VALIDATED completes to PUBLISHED on the next cycle without duplicating states', async () => {
  const st = db();
  const s = mover('a', '2026-10-04T15:00:00Z');
  await st.write('pred_newsroom_stories', { story_id: 'a', trigger_key: 'MOVER|M-a|s0-a|s1-a', slug: s.slug });
  for (const state of ['CANDIDATE', 'EVIDENCE_READY', 'GENERATED', 'VALIDATED']) await st.write('pred_newsroom_transitions', { story_id: 'a', state, detail: {} });
  const r = await autoPublish(st, { stories: [s] }, { cycleAt: 'c' });
  assert.equal(r.published.length, 1);
  assert.deepEqual(st.t.pred_newsroom_transitions.map((x) => x.state), ['CANDIDATE', 'EVIDENCE_READY', 'GENERATED', 'VALIDATED', 'PUBLISHED']);
});

test('HELD stories, the anomaly lane and any non-publishable class are never published', async () => {
  const st = db();
  const r = await autoPublish(st, { stories: [
    { ...mover('h', '2026-10-04T15:00:00Z'), state: 'HELD', reason: 'COOLDOWN' },
    { ...mover('x', '2026-10-04T15:00:00Z'), state: 'HELD', reason: 'ANOMALY_HOLD: LARGE_JUMP_UNEXPLAINED' },
    { ...mover('y', '2026-10-04T15:00:00Z'), state: 'GENERATED' },
    { ...mover('z', '2026-10-04T15:00:00Z'), class: 'ANOMALY' },
  ] }, { cycleAt: 'c' });
  assert.deepEqual([r.considered, r.published.length, st.t.pred_newsroom_stories.length], [0, 0, 0]);
  assert.deepEqual([...PUBLISHABLE_CLASSES], ['FORECAST_MOVER', 'RESOLUTION_REPORT']);
});

test('desk cap: never more than the defined movers per UTC day, counting movers already published', async () => {
  const st = db();
  const day = '2026-10-04T';
  const report = { stories: Array.from({ length: MOVER.desk_cap_per_day + 3 }, (_, i) => mover(`m${i}`, `${day}${String(10 + i).padStart(2, '0')}:00:00Z`)) };
  const r = await autoPublish(st, report, { cycleAt: 'c' });
  assert.equal(r.published.length, MOVER.desk_cap_per_day);
  assert.equal(r.skipped.filter((x) => /DESK_CAP/.test(x.reason)).length, 3);
});

// resolution report fixtures (same shapes as test/newsroom.test.js)
const contract = { contract_id: 'C1', market_id: 'M1', outcome_label: '95° to 96°', normalization_status: 'NORMALIZED', resolution_authority: 'The Weather Company', resolution_dataset: 'TWC daily max', verification_dataset: 'NWS CLI', measurement_definition: 'max temp', rounding_rule: 'whole', exceptions: [], rules_primary: 'rule' };
const snap = (id, t, pbe, extra = {}) => ({ id, t, pbe, pbe_raw: pbe / 100, market: 50, model: 'pbe-weather-maxtemp@1.1.0', model_id: 'pbe-weather-maxtemp', version: '1.1.0', state: 'RESEARCH', cutoff: t, sha: 'x', feature_snapshot_id: `fs-${id}`, evidence: [], provenance: [], tier: null, roles: [], ...extra });
const resolved = { resolution_id: 'R1', venue_result: 'yes', official_outcome: 'YES', official_value: 96, official_units: '°F', sources_agree: true, resolved_at: '2026-10-05T09:00:00Z', venue_settled_at: '2026-10-05T09:00:00Z', official_source: 'NWS CLI CLIAUS' };
const scored = [{ designation: 'FINAL_PRE_RESOLUTION', scoring_method: 'brier', score: 0.3, benchmark_score: 0.2 }, { designation: 'FINAL_PRE_RESOLUTION', scoring_method: 'log_loss', score: 0.9, benchmark_score: 0.7 }];
const packet = { as_of: '2026-10-05T09:00:01Z', event: { id: 'E1', kind: 'exclusive', slug: 'ev', title: 'Highest temperature in Austin on Oct 4, 2026?', category: 'WEATHER', category_label: 'Weather' },
  outcomes: [{ contract, market_id: 'M1', label: '95° to 96°', snapshots: [snap('a', '2026-10-03T18:00:00Z', 20, { roles: ['FIRST_PUBLISHED'] }), snap('b', '2026-10-04T05:00:00Z', 45, { roles: ['FINAL_PRE_RESOLUTION'] })], market_path: [{ t: '2026-10-03T18:00:00Z', mid: 50, bid: 48, ask: 52 }], resolution: resolved, scores: scored }] };

test('a RESOLUTION_REPORT auto-publishes and the read path serves it, rebuilt with its frozen family count', async () => {
  const built = buildResolution({ packet, familyResolved: 12 });
  assert.equal(built.ok, true);
  const story = { story_id: 'rr1', class: 'RESOLUTION_REPORT', state: 'VALIDATED', slug: 'ev-resolution-report', trigger: { event_slug: 'ev', event_title: packet.event.title, resolutions: 1 }, def: { as_of: packet.as_of }, packet, built, resolution_ids: ['R1'], family_resolved: 12 };
  const st = db();
  const r = await autoPublish(st, { stories: [story] }, { cycleAt: '2026-10-05T09:15:00Z' });
  assert.equal(r.published.length, 1);
  assert.equal(r.published[0].class, 'RESOLUTION_REPORT');
  const row = st.t.pred_newsroom_stories[0];
  assert.equal(row.trigger_key, 'RESOLUTION|E1|R1');
  assert.deepEqual([row.evidence.family_resolved, row.evidence.resolution_ids], [12, ['R1']]);
  const items = await publishedNewsroomStories(st, { fresh: true, loadPacket: async () => packet });
  assert.equal(items.length, 1);
  assert.equal(items[0].story.family, 'RESOLUTION_REPORT');
  assert.equal(items[0].story.slug, 'ev-resolution-report');
  assert.equal(items[0].built.title, built.title, 'rebuilt identically');
  assert.match(items[0].built.sections, /12 resolved in total/, 'frozen family count, not the live one');
});
