// Phases 2-3: scheduler lanes dispatched by cron identity, atomic lease (never two core engines), append-only run
// transitions, engine health for /api/summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CRONS, laneFor, runLane, healthFrom, cadenceMinutes, coreCounts, countingFetch } from '../workers/pbe-predictions/src/engine-runs.js';

// In-memory store whose pred_engine_claim is atomic the way the SQL is (check-and-set in one step).
function fakeStore({ claimThrows = false } = {}) {
  const lease = new Map(); const runs = []; const calls = [];
  const fetchImpl = async (url, init) => {
    const fn = String(url).split('/rpc/')[1]; const a = JSON.parse(init.body); calls.push(fn);
    if (claimThrows) return { ok: false, status: 503, text: async () => 'down' };
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    if (fn === 'pred_engine_claim') { const l = lease.get(a.p_lane); const free = !l || !l.holder; if (free) lease.set(a.p_lane, { holder: a.p_run_id }); return { ok: true, json: async () => free }; }
    if (fn === 'pred_engine_release') { const l = lease.get(a.p_lane); const mine = l?.holder === a.p_run_id; if (mine) l.holder = null; return { ok: true, json: async () => mine }; }
    throw new Error(fn);
  };
  const select = async (t, q) => {
    if (t === 'pred_engine_lease') { const l = lease.get(q.lane.slice(3)); return l ? [{ holder: l.holder, expires_at: l.expires_at ?? null }] : []; }
    return runs.filter((r) => r.lane === q.lane.slice(3)).slice().reverse();
  };
  return { url: 'https://x', serviceKey: 'k', fetchImpl, select, write: async (t, row) => { assert.equal(t, 'pred_engine_runs'); if (runs.some((r) => r.run_id === row.run_id && r.transition === row.transition)) throw new Error('dup'); runs.push(row); }, runs, lease, calls };
}
const args = (store, work, extra = {}) => ({ store, lane: 'core', cron: CRONS.CORE, scheduledAt: '2026-10-04T20:00:00.000Z', workerVersion: 'v-test', work, ...extra });

test('lanes dispatch by cron identity; wrangler crons match exactly; core lane never calls the newsroom', () => {
  assert.equal(laneFor(CRONS.FAST), 'fast'); assert.equal(laneFor(CRONS.CORE), 'core'); assert.equal(laneFor(CRONS.NEWSROOM), 'newsroom');
  assert.equal(laneFor('0 * * * *'), null);
  const w = readFileSync(new URL('../workers/pbe-predictions/wrangler.jsonc', import.meta.url), 'utf8');
  const crons = JSON.parse(/"crons":\s*(\[[^\]]*\])/.exec(w)[1]);
  assert.deepEqual([...crons].sort(), Object.values(CRONS).sort());
  assert.equal(new Set(Object.values(CRONS)).size, 3);
  const src = readFileSync(new URL('../workers/pbe-predictions/src/index.js', import.meta.url), 'utf8');
  const core = src.slice(src.indexOf("if (lane === 'core')"), src.indexOf('// NEWSROOM lane'));
  assert.ok(core.length > 100 && !/newsroomCycle/.test(core), 'core lane must not call the newsroom');
  assert.match(src, /if \(event\.cron === BTC_SHADOW_CRON\)/, 'FAST lane unchanged');
  assert.equal(cadenceMinutes('*/2 * * * *'), 2); assert.equal(cadenceMinutes('*/15 * * * *'), 15);
});

test('claimed run: STARTED -> COMPLETED with duration/version/counts, lease released', async () => {
  const s = fakeStore();
  const r = await runLane(args(s, async () => ({ counts: { forecasts: 3 } })));
  assert.equal(r.transition, 'COMPLETED');
  assert.deepEqual(s.runs.map((x) => x.transition), ['STARTED', 'COMPLETED']);
  assert.equal(s.runs[1].worker_version, 'v-test'); assert.deepEqual(s.runs[1].counts, { forecasts: 3 }); assert.ok(s.runs[1].duration_ms >= 0);
  assert.equal(s.lease.get('core').holder, null);
});

test('overlap: a tick that cannot claim records SKIPPED_OVERLAP and never runs the engine', async () => {
  const s = fakeStore(); s.lease.set('core', { holder: 'core:earlier:abc' });
  let ran = false;
  const r = await runLane(args(s, async () => { ran = true; return {}; }));
  assert.equal(r.transition, 'SKIPPED_OVERLAP'); assert.equal(ran, false);
  assert.deepEqual(s.runs.map((x) => x.transition), ['SKIPPED_OVERLAP']);
  assert.equal(s.lease.get('core').holder, 'core:earlier:abc', 'the running holder keeps its lease');
});

test('concurrent ticks: exactly one engine runs at a time', async () => {
  const s = fakeStore(); let active = 0; let maxActive = 0; let ran = 0;
  const work = async () => { active += 1; ran += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active -= 1; return {}; };
  let n = 0; const rand = () => `r${n++}`;
  const out = await Promise.all(Array.from({ length: 8 }, () => runLane(args(s, work, { rand }))));
  assert.equal(maxActive, 1); assert.equal(ran, 1);
  assert.equal(out.filter((o) => o.transition === 'COMPLETED').length, 1);
  assert.equal(out.filter((o) => o.transition === 'SKIPPED_OVERLAP').length, 7);
});

test('failure: engine error -> FAILED (lease released); lease outage -> fail closed, engine never runs', async () => {
  const s = fakeStore();
  const r = await runLane(args(s, async () => { throw new Error('kalshi down'); }));
  assert.equal(r.transition, 'FAILED'); assert.match(s.runs[1].error, /kalshi down/); assert.equal(s.lease.get('core').holder, null);
  const d = fakeStore({ claimThrows: true }); let ran = false;
  const r2 = await runLane(args(d, async () => { ran = true; }));
  assert.equal(r2.transition, 'FAILED'); assert.equal(ran, false); assert.match(d.runs[0].error, /lease unavailable/);
});

test('health: healthy / running / delayed / failed; last success comes from COMPLETED only', () => {
  const now = '2026-10-04T20:20:00Z';
  const done = { run_id: 'a', transition: 'COMPLETED', scheduled_at: '2026-10-04T20:15:00Z', at: '2026-10-04T20:16:10Z', duration_ms: 70000, worker_version: 'v', counts: {} };
  assert.equal(healthFrom([done], null, now).state, 'healthy');
  assert.equal(healthFrom([done], null, now).last_success.completed_at, '2026-10-04T20:16:10Z');
  assert.equal(healthFrom([{ transition: 'STARTED', at: now }, done], { holder: 'b', claimed_at: now, expires_at: '2026-10-04T20:30:00Z' }, now).state, 'running');
  assert.equal(healthFrom([done], { holder: 'b', claimed_at: '2026-10-04T19:00:00Z', expires_at: '2026-10-04T19:10:00Z' }, now).state, 'healthy', 'expired lease is not running');
  assert.equal(healthFrom([done], null, '2026-10-04T21:00:00Z').state, 'delayed');
  const h = healthFrom([{ transition: 'FAILED', at: now, error: 'x' }, done], null, now);
  assert.equal(h.state, 'failed'); assert.equal(h.last_success.run_id, 'a');
  assert.equal(healthFrom([{ transition: 'SKIPPED_OVERLAP', at: now }, done], null, now).recent.skipped_overlap, 1);
  assert.equal(healthFrom([], null, now).state, 'delayed');
});

test('counts: engine summary + Supabase/market request counters', async () => {
  const c = countingFetch(async () => ({ ok: true, status: 200 }));
  await c.fetch('u'); await c.fetch('u', { method: 'POST' });
  const k = coreCounts({ events: 4, contracts: { NORMALIZED: 30, UNMODELABLE: 2 }, forecasts: 5, venue_snapshots: 32, errors: [{ source: 'markets', error: 'canonical market service in rate-limit backoff until x' }] }, c.counts, { requests: 9, errors: 0, rate_limited: 0 });
  assert.deepEqual([k.events, k.contracts, k.forecasts, k.venue_snapshots, k.errors, k.market_backoff_errors, k.market_requests, k.supabase_requests, k.supabase_writes], [4, 32, 5, 32, 1, 1, 9, 2, 1]);
});

test('orphan recovery: STARTED -> process disappears -> lease expires -> next invocation appends ABANDONED -> new lease claimed', async () => {
  const s = fakeStore();
  // run A claims and writes STARTED, then the isolate is hard-killed: no terminal row, no release
  s.lease.set('newsroom', { holder: 'newsroom:20:22:a', expires_at: '2026-10-04T20:38:53Z' });
  s.runs.push({ run_id: 'newsroom:20:22:a', lane: 'newsroom', transition: 'STARTED', scheduled_at: '2026-10-04T20:22:39Z', at: '2026-10-04T20:22:53Z' });
  // before expiry: the next tick must skip, never run concurrently
  const early = await runLane(args(s, async () => ({}), { lane: 'newsroom', cron: CRONS.NEWSROOM }));
  assert.equal(early.transition, 'SKIPPED_OVERLAP');
  assert.ok(!s.runs.some((r) => r.transition === 'ABANDONED'), 'no ABANDONED while the lease may still be alive');
  // lease expires (the SQL claim succeeds over an expired lease)
  s.lease.get('newsroom').holder = null;
  const r = await runLane(args(s, async () => ({ counts: { published: 0 } }), { lane: 'newsroom', cron: CRONS.NEWSROOM, scheduledAt: '2026-10-04T20:52:39Z' }));
  assert.equal(r.transition, 'COMPLETED');
  const ab = s.runs.filter((x) => x.transition === 'ABANDONED');
  assert.equal(ab.length, 1); assert.equal(ab[0].run_id, 'newsroom:20:22:a'); assert.equal(ab[0].error, 'no_terminal_before_lease_expiry');
  assert.equal(ab[0].counts.original_run_id, 'newsroom:20:22:a'); assert.equal(ab[0].counts.detected_by, r.run_id); assert.ok(ab[0].counts.detected_at);
  const started = s.runs.find((x) => x.run_id === 'newsroom:20:22:a' && x.transition === 'STARTED');
  assert.equal(started.at, '2026-10-04T20:22:53Z', 'the original STARTED row is untouched');
  // a further run does not append a second ABANDONED
  await runLane(args(s, async () => ({}), { lane: 'newsroom', cron: CRONS.NEWSROOM, scheduledAt: '2026-10-04T21:07:39Z' }));
  assert.equal(s.runs.filter((x) => x.transition === 'ABANDONED').length, 1);
  // health treats it as a killed (failed) run, not running
  const h = healthFrom([...s.runs].reverse().filter((x) => x.lane === 'newsroom'), null, '2026-10-04T21:08:00Z');
  assert.equal(h.recent.abandoned, 1);
  assert.equal(healthFrom([{ transition: 'ABANDONED', run_id: 'x', at: '2026-10-04T21:00:00Z' }], null, '2026-10-04T21:01:00Z').state, 'failed');
});

test('lease TTL exceeds the Cloudflare cron wall-time cap (15 min) with margin', async () => {
  const { LEASE_TTL_S } = await import('../workers/pbe-predictions/src/engine-runs.js');
  assert.ok(LEASE_TTL_S.core > 900 && LEASE_TTL_S.newsroom > 900);
});

test('timing attribution: per-dependency latency + slowest request, never the query string', async () => {
  const c = countingFetch(async () => { await new Promise((r) => setTimeout(r, 15)); return { ok: true, status: 200 }; });
  await c.fetch('https://api.weather.gov/stations/KPHL/observations?key=SECRET');
  assert.ok(c.counts.ms_total >= 10 && c.counts.ms_max >= 10);
  assert.equal(c.counts.slowest, 'api.weather.gov/stations/KPHL/observations');
  const k = coreCounts({ phase_ms: { series_and_inputs: 5 } }, c.counts, null, c.counts);
  assert.equal(k.timing.phase_ms.series_and_inputs, 5); assert.equal(k.external_requests, 1);
  assert.doesNotMatch(JSON.stringify(k), /SECRET/);
});

test('cadence (owner 2026-10-04): core every 2 min, newsroom every 5 min (offset :01), UI never hard-codes it', async () => {
  const { CORE_CADENCE_MIN, NEWSROOM_MAX_CORE_AGE_MIN } = await import('../workers/pbe-predictions/src/engine-runs.js');
  assert.equal(CRONS.CORE, '*/2 * * * *'); assert.equal(CORE_CADENCE_MIN, 2);
  const mins = CRONS.NEWSROOM.split(' ')[0].split(',').map(Number);
  assert.deepEqual(mins, Array.from({ length: 12 }, (_, i) => i * 5 + 1));
  assert.equal(NEWSROOM_MAX_CORE_AGE_MIN, 10);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!/every \d+ min/i.test(html), 'cadence copy comes from /api/summary engine.cadence_minutes only');
});

test('failure attribution: failing requests recorded as status + host/path (bounded, no query string)', async () => {
  const c = countingFetch(async (u) => ({ ok: !String(u).includes('bad'), status: String(u).includes('bad') ? 503 : 200 }));
  for (let i = 0; i < 10; i++) await c.fetch(`https://api.weather.gov/bad/${i}?key=SECRET`);
  await c.fetch('https://api.weather.gov/good');
  assert.equal(c.counts.errors, 10); assert.equal(c.counts.failures.length, 8);
  assert.equal(c.counts.failures[0], '503 api.weather.gov/bad/0');
  assert.ok(!c.counts.failures.join().includes('SECRET'));
  assert.deepEqual(coreCounts({}, c.counts, null, c.counts).external_failures.length, 8);
});
