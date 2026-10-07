// P0 2026-10-07: Compare amplified market-desk load. One ALL SPORTS request could wait ~36 s (10 lanes, 4 at a time,
// 12 s timeouts), every browser/tab ran its own ten whole-sport reads, and failed targeted checks retried every
// 12-15 s. These tests pin the repaired behaviour with a fake upstream (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLanes, loadTargeted, breakerState, stats, _resetLaneState, SPORT_LANES, SPORTS_BUDGET_MS, UPSTREAM_CONCURRENCY, LANE_FRESH_MS, LANE_STALE_MS, TARGETED_BREAKER_FAILS } from '../api/_lib/desk.js';
import { carryDesk, liveMarketStates, screenNotices, LIVE_MARKET } from '../core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (id) => ({ canonical_event_id: String(id), title: `E${id}`, contracts: [] });
// fake desk: per-sport delay (ms) / failure; counts calls and concurrency
function fakeDesk({ delay = {}, fail = {}, events = {} } = {}) {
  const f = { calls: [], active: 0, maxActive: 0 };
  f.fetchImpl = async (url, init) => {
    const q = new URL(url).searchParams;
    const sport = q.get('sport');
    f.calls.push({ sport, events: q.get('events') });
    f.active += 1; f.maxActive = Math.max(f.maxActive, f.active);
    try {
      const d = delay[sport] ?? 5;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, d);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); });
      });
      if (fail[sport]) return new Response('{"error":"upstream"}', { status: 503 });
      const all = events[sport] || [ev(`${sport}-1`), ev(`${sport}-2`)];
      const ids = q.get('events')?.split(',');
      return new Response(JSON.stringify({ contract: 'market-desk/1', generated_at: new Date().toISOString(), events: ids ? all.filter((e) => ids.includes(e.canonical_event_id)) : all }), { status: 200 });
    } finally { f.active -= 1; }
  };
  return f;
}
const opts = (f, extra = {}) => ({ fetchImpl: f.fetchImpl, noMedia: true, ...extra });

test('ALL SPORTS answers within its budget even when every lane hangs; lanes say delayed, never empty-ok', async () => {
  _resetLaneState();
  const f = fakeDesk({ delay: Object.fromEntries(SPORT_LANES.map((s) => [s, 60e3])) });
  const t = Date.now();
  const body = await loadLanes(SPORT_LANES, opts(f, { budgetMs: 300, timeoutMs: 400 }));
  const wall = Date.now() - t;
  assert.ok(wall < 600, `wall ${wall} ms`);
  assert.equal(body.lanes.length, 10);
  for (const l of body.lanes) { assert.equal(l.state, 'unavailable'); assert.equal(l.delayed, true); }
  assert.ok(f.maxActive <= UPSTREAM_CONCURRENCY, `max concurrent upstream ${f.maxActive}`);
  await sleep(1500); // background reads time out on their own; nothing is left in flight
  assert.equal(SPORTS_BUDGET_MS <= 6000, true);
});

test('coalescing: 25 simultaneous ALL SPORTS requests cause ONE upstream read per lane', async () => {
  _resetLaneState();
  const f = fakeDesk({ delay: Object.fromEntries(SPORT_LANES.map((s) => [s, 40])) });
  const bodies = await Promise.all(Array.from({ length: 25 }, () => loadLanes(SPORT_LANES, opts(f, { budgetMs: 2000 }))));
  assert.equal(f.calls.length, SPORT_LANES.length, `upstream calls ${f.calls.length}`);
  assert.ok(f.maxActive <= UPSTREAM_CONCURRENCY);
  for (const b of bodies) assert.equal(b.lanes.filter((l) => l.state === 'ok').length, 10);
  assert.ok(stats.lane_coalesced >= 24 * 10 - 10);
});

test('fresh cache: no upstream read inside LANE_FRESH_MS; stale is served at once (with age) and refreshed once', async () => {
  _resetLaneState();
  let clock = 1_000_000;
  const now = () => clock;
  const f = fakeDesk({ delay: { nhl: 20 } });
  await loadLanes(['nhl'], opts(f, { now, budgetMs: 1000 }));
  assert.equal(f.calls.length, 1);
  clock += LANE_FRESH_MS - 1;
  const fresh = await loadLanes(['nhl'], opts(f, { now, budgetMs: 1000 }));
  assert.equal(f.calls.length, 1);
  assert.equal(fresh.lanes[0].source, 'fresh');
  clock += 60e3; // past fresh, inside stale
  const f2 = fakeDesk({ delay: { nhl: 2000 } }); // the refresh is slow: the caller must not wait for it
  const t = Date.now();
  const stale = await loadLanes(['nhl'], opts(f2, { now, budgetMs: 5000 }));
  assert.ok(Date.now() - t < 200, 'stale answer is immediate');
  assert.equal(stale.lanes[0].source, 'stale');
  assert.equal(stale.lanes[0].stale, true);
  assert.ok(stale.lanes[0].age_ms >= 60e3);
  assert.equal(stale.events.length, 2, 'previous good events stay on the board');
  await loadLanes(['nhl'], opts(f2, { now, budgetMs: 5000 }));
  assert.equal(f2.calls.length, 1, 'one background refresh, coalesced');
  clock += LANE_STALE_MS; // too old to serve
  await sleep(2100);
});

test('a failed refresh keeps the last good lane (stale) instead of emptying it', async () => {
  _resetLaneState();
  let clock = 5_000_000;
  const now = () => clock;
  await loadLanes(['nba'], opts(fakeDesk(), { now, budgetMs: 1000 }));
  clock += LANE_FRESH_MS + 1000;
  const bad = fakeDesk({ fail: { nba: true } });
  const b = await loadLanes(['nba'], opts(bad, { now, budgetMs: 1000 }));
  assert.equal(b.lanes[0].state, 'ok');
  assert.equal(b.lanes[0].source, 'stale');
  await sleep(50);
  const again = await loadLanes(['nba'], opts(bad, { now, budgetMs: 1000 }));
  assert.equal(again.lanes[0].state, 'ok', 'still the last good lane after the failure');
});

test('targeted: answered from the lane cache (no upstream); identical sets coalesce; results cached 30 s', async () => {
  _resetLaneState();
  const f = fakeDesk({ events: { nhl: [ev('1'), ev('2'), ev('3')] } });
  await loadLanes(['nhl'], opts(f, { budgetMs: 1000 }));
  const before = f.calls.length;
  const a = await loadTargeted('nhl', ['1', '9'], opts(f));
  assert.equal(a.source, 'lane_cache', 'uncapped lane = complete inventory');
  assert.deepEqual(a.found, ['1']);
  assert.deepEqual(a.missing, ['9']);
  assert.equal(f.calls.length, before);
  // capped lane without the id -> one targeted upstream read, shared by concurrent callers, then cached
  _resetLaneState();
  const g = fakeDesk({ delay: { nba: 50 }, events: { nba: Array.from({ length: 50 }, (_, i) => ev(i)).concat([ev('x')]) } });
  const capped = fakeDesk({ events: { nba: Array.from({ length: 50 }, (_, i) => ev(i)) } });
  await loadLanes(['nba'], opts(capped, { budgetMs: 1000 }));
  const rs = await Promise.all(Array.from({ length: 8 }, () => loadTargeted('nba', ['x'], opts(g))));
  assert.equal(g.calls.length, 1);
  assert.ok(rs.every((r) => r.state === 'ok' && r.found[0] === 'x'));
  const cached = await loadTargeted('nba', ['x'], opts(g));
  assert.equal(cached.source, 'cache');
  assert.equal(g.calls.length, 1);
});

test('targeted circuit breaker: repeated failures stop upstream reads; answers stay unavailable (never missing)', async () => {
  _resetLaneState();
  let clock = 9_000_000;
  const now = () => clock;
  const f = fakeDesk({ fail: { mlb: true } });
  for (let i = 0; i < TARGETED_BREAKER_FAILS; i++) {
    const r = await loadTargeted('mlb', [`g${i}`], opts(f, { now }));
    assert.equal(r.state, 'unavailable');
    assert.deepEqual(r.missing, []);
  }
  assert.equal(breakerState('mlb', clock).open, true);
  const calls = f.calls.length;
  for (let i = 0; i < 20; i++) {
    const r = await loadTargeted('mlb', [`h${i}`], opts(f, { now }));
    assert.equal(r.source, 'breaker');
    assert.equal(r.state, 'unavailable');
    assert.ok(r.retry_in_ms > 0);
  }
  assert.equal(f.calls.length, calls, 'no upstream reads while open');
  clock += 31e3;
  const ok = fakeDesk({ events: { mlb: [ev('z')] } });
  const r = await loadTargeted('mlb', ['z'], opts(ok, { now }));
  assert.equal(r.state, 'ok');
  assert.equal(breakerState('mlb', clock).open, false);
});

test('client keeps a good board on screen (carryDesk); a carried lane can never prove "no markets"', () => {
  const now = Date.parse('2026-10-07T02:30:00Z');
  const prev = { lanes: [{ lane: 'nhl', state: 'ok', events: 2, capped: false }, { lane: 'nba', state: 'ok', events: 1 }], events: [{ ...ev('a'), lane: 'nhl', sport: 'nhl' }, { ...ev('b'), lane: 'nhl', sport: 'nhl' }, { ...ev('c'), lane: 'nba', sport: 'nba' }] };
  const next = { lanes: [{ lane: 'nhl', state: 'unavailable', delayed: true, error: 'budget' }, { lane: 'nba', state: 'ok', events: 1 }], events: [{ ...ev('d'), lane: 'nba', sport: 'nba' }] };
  const m = carryDesk(prev, now - 60e3, next, now);
  assert.deepEqual(m.events.map((e) => e.canonical_event_id).sort(), ['a', 'b', 'd']);
  const nhl = m.lanes.find((l) => l.lane === 'nhl');
  assert.equal(nhl.state, 'unavailable', 'truthful lane state');
  assert.ok(nhl.cached_at);
  const st = liveMarketStates([{ sport: 'nhl', source_id: 'zz', title: 'SEA @ VAN', status: 'live' }], { events: [], lanes: m.lanes })[0];
  assert.notEqual(st.state, LIVE_MARKET.NONE);
});

test('server-stale lanes (ok + age) surface as the quiet "refresh delayed" status, never an outage banner', () => {
  const now = Date.parse('2026-10-07T02:30:00Z');
  const desk = { lanes: [{ lane: 'nhl', state: 'ok', stale: true, age_ms: 240e3, events: 1 }], events: [] };
  const events = [{ lane: 'nhl', sport: 'nhl', contracts: [{ priced: true }], live: true }];
  const n = screenNotices({ desk, deskStatus: 200, deskAt: now - 5e3, live: { items: [] }, liveStatus: 200, scope: 'sports', events, now });
  const q = n.find((x) => x.code === 'market_refresh_delayed');
  assert.ok(q, JSON.stringify(n));
  assert.equal(q.level, 'quiet');
  assert.ok(!n.some((x) => x.level === 'error'));
});
