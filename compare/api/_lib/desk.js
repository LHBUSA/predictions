// Market-desk lanes for Compare. One upstream read per lane (propsports-markets /v1/market-desk, edge-cached
// 30 s upstream). Every lane reports its own state so the UI never turns a failure into an empty board.
//   ok             upstream 200 (events may genuinely be [])
//   not_connected  upstream 404 (no comparison lane for this sport yet: soccer / golf / f1 on 2026-10-05)
//   unavailable    anything else (5xx, timeout, bad JSON)
import { MARKET_DESK_URL, upstreamJson } from './access.js';
import { enrichUfc, enrichSoccer } from './media.js';

export const SPORT_LANES = ['nfl', 'nba', 'nhl', 'mlb', 'wnba', 'tennis', 'ufc', 'soccer', 'golf', 'f1'];
// Upstream contract: limit = events, capped at 50 (propsports-markets index.js). No offset/cursor exists, so
// Compare asks for exactly the cap and flags `capped` instead of pretending more pages exist.
export const DESK_PAGE_LIMIT = 50;

export function laneUrl(lane, { event = null, events = null } = {}) {
  const u = new URL(MARKET_DESK_URL);
  if (lane === 'nonsports') u.searchParams.set('domain', 'nonsports');
  else u.searchParams.set('sport', lane);
  if (event) u.searchParams.set('event', event);
  else if (events?.length) u.searchParams.set('events', events.join(','));
  else u.searchParams.set('limit', String(DESK_PAGE_LIMIT));
  return u.toString();
}

export function laneResult(lane, r) {
  if (r.ok && Array.isArray(r.body?.events)) {
    const events = r.body.events.map((e) => ({ ...e, sport: e.sport || (lane === 'nonsports' ? null : lane), lane }));
    return {
      lane: { lane, state: 'ok', upstream_status: r.status, generated_at: r.body.generated_at || null, events: events.length, capped: events.length >= DESK_PAGE_LIMIT, venues: r.body.venues || [], ms: r.ms },
      events, rules: r.body.rules || null, contract: r.body.contract || null
    };
  }
  const state = r.status === 404 ? 'not_connected' : 'unavailable';
  return { lane: { lane, state, upstream_status: r.status, error: r.error || r.body?.error || null, events: 0, capped: false, ms: r.ms }, events: [], rules: null, contract: null };
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Number(limit) || 1, items.length || 1)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Lane cache + single-flight (P0 2026-10-07). Before: every /api/desk?scope=sports ran ten fresh whole-sport desk
// reads (4 at a time, 12 s timeout each), so one request could take ~36 s when the desk was slow, every browser and
// tab added its own ten reads, and a slow desk was slowed further by Compare itself. Now, per server instance:
//   - one in-flight upstream read per lane (callers attach to it: "coalesced")
//   - at most UPSTREAM_CONCURRENCY whole-lane reads in flight across ALL requests
//   - a healthy lane is reused for LANE_FRESH_MS, then served stale (labelled with its age) for up to LANE_STALE_MS
//     while one background read refreshes it
//   - a request never waits more than its budget: lanes still loading answer `unavailable` + `delayed: true`
//     and the read keeps going in the background (Vercel waitUntil) to fill the cache for the next caller.
// The upstream timeout is unchanged (12 s); it is no longer in the request path.
export const LANE_FRESH_MS = 30e3;
export const LANE_STALE_MS = 10 * 60e3;
export const SPORTS_BUDGET_MS = 5000;
export const LANE_BUDGET_MS = 9000;
export const UPSTREAM_CONCURRENCY = 4;
export const LANE_TIMEOUT_MS = 12000;

export const stats = { since: new Date().toISOString(), lane_upstream: 0, lane_upstream_failed: 0, lane_coalesced: 0, lane_fresh_hits: 0, lane_stale_served: 0, lane_delayed: 0,
  targeted_requests: 0, targeted_upstream: 0, targeted_from_lane: 0, targeted_cache_hits: 0, targeted_coalesced: 0, targeted_breaker: 0, targeted_failed: 0, max_concurrent_upstream: 0 };
const laneCache = new Map(); // lane -> { at, result }
const laneInflight = new Map(); // lane -> Promise<result>
let active = 0;
const waiting = [];
const acquire = () => {
  if (active < UPSTREAM_CONCURRENCY) { active += 1; stats.max_concurrent_upstream = Math.max(stats.max_concurrent_upstream, active); return Promise.resolve(); }
  return new Promise((r) => waiting.push(r));
};
const release = () => { const next = waiting.shift(); if (next) next(); else active -= 1; };
export const upstreamActive = () => active;

// Keep a background read alive after the response is sent (Vercel Functions request context; no-op elsewhere).
export function keepAlive(p) {
  try { globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(p.catch(() => {})); } catch { /* best effort */ }
}

export function _resetLaneState() { laneCache.clear(); laneInflight.clear(); targetedCache.clear(); targetedInflight.clear(); breakers.clear(); for (const k of Object.keys(stats)) if (typeof stats[k] === 'number') stats[k] = 0; }

function refreshLane(lane, opts) {
  if (laneInflight.has(lane)) { stats.lane_coalesced += 1; return laneInflight.get(lane); }
  const now = opts.now || Date.now;
  const p = (async () => {
    await acquire();
    try {
      stats.lane_upstream += 1;
      const r = laneResult(lane, await upstreamJson(laneUrl(lane), { timeoutMs: opts.timeoutMs || LANE_TIMEOUT_MS, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }));
      if (r.lane.state === 'unavailable') { stats.lane_upstream_failed += 1; return r; }
      if (!opts.noMedia && r.events.length) {
        if (lane === 'ufc') await enrichUfc(r.events, opts.media || {});
        if (lane === 'soccer') await enrichSoccer(r.events, opts.media || {});
      }
      laneCache.set(lane, { at: now(), result: r });
      return r;
    } finally { release(); }
  })().finally(() => laneInflight.delete(lane));
  laneInflight.set(lane, p);
  keepAlive(p);
  return p;
}

const served = (c, source, age) => ({ ...c.result, lane: { ...c.result.lane, source, age_ms: age, stale: source === 'stale' } });

export async function loadLanes(lanes, opts = {}) {
  const now = opts.now || Date.now;
  const t0 = now();
  const budget = Number.isFinite(opts.budgetMs) ? opts.budgetMs : SPORTS_BUDGET_MS;
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => r('__budget__'), budget); timer.unref?.(); });
  const results = await Promise.all(lanes.map(async (lane) => {
    const c = laneCache.get(lane);
    const age = c ? now() - c.at : Infinity;
    if (age < LANE_FRESH_MS) { stats.lane_fresh_hits += 1; return served(c, 'fresh', age); }
    const p = refreshLane(lane, opts);
    if (age < LANE_STALE_MS) { stats.lane_stale_served += 1; return served(c, 'stale', age); }
    const r = await Promise.race([p, deadline]);
    if (r === '__budget__') {
      stats.lane_delayed += 1;
      return { lane: { lane, state: 'unavailable', delayed: true, error: 'budget', source: 'pending', upstream_status: null, events: 0, capped: false, ms: now() - t0 }, events: [], rules: null, contract: null };
    }
    return { ...r, lane: { ...r.lane, source: 'upstream', age_ms: 0, stale: false } };
  }));
  clearTimeout(timer);
  return {
    contract: 'compare-desk/1',
    upstream_contract: results.find((x) => x.contract)?.contract || null,
    generated_at: new Date(now()).toISOString(),
    page_limit: DESK_PAGE_LIMIT,
    budget_ms: budget,
    wall_ms: now() - t0,
    lanes: results.map((x) => x.lane),
    rules: results.find((x) => x.rules)?.rules || null,
    events: results.flatMap((x) => x.events)
  };
}

export function parseScope(q = {}) {
  const scope = String(q.scope || q.sport || q.domain || 'sports').toLowerCase();
  if (scope === 'sports' || scope === 'all') return { lanes: SPORT_LANES, scope: 'sports' };
  if (scope === 'nonsports' || scope === 'predictions') return { lanes: ['nonsports'], scope: 'nonsports' };
  if (SPORT_LANES.includes(scope)) return { lanes: [scope], scope };
  return null;
}

// Targeted live-market check (2026-10-06). The whole-sport lane is capped at 50 events and can time out, so a live
// score card whose id is not on the loaded board is checked by id: /v1/market-desk?sport=X&events=<ids> filters
// market_venue_contract_map by canonical_event_id in the DB request (max 12 ids, propsports-markets DESK_MAX_EVENTS).
//   found        the desk returned the event (markets exist)
//   missing      the desk answered 200 and the id is absent = positively checked, no markets
//   unavailable  the read failed (never reported as "no markets")
export const TARGETED_MAX_EVENTS = 12;
export const TARGETED_SPORTS = new Set(['nfl', 'nba', 'nhl', 'mlb', 'wnba', 'soccer', 'tennis', 'golf']);
const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
export function parseTargetedIds(raw) {
  const ids = [...new Set(String(raw || '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (!ids.length || ids.length > TARGETED_MAX_EVENTS || ids.some((x) => !ID_RE.test(x))) return null;
  return ids;
}
export function targetedResult(sport, ids, r) {
  if (!(r.ok && Array.isArray(r.body?.events))) {
    return { contract: 'compare-live-markets/1', sport, state: 'unavailable', upstream_status: r.status, error: r.error || r.body?.error || null, ms: r.ms,
      requested: ids, found: [], missing: [], unavailable: ids, events: [] };
  }
  const events = r.body.events.filter((e) => ids.includes(String(e.canonical_event_id))).map((e) => ({ ...e, sport: e.sport || sport, lane: sport }));
  const found = new Set(events.map((e) => String(e.canonical_event_id)));
  return { contract: 'compare-live-markets/1', sport, state: 'ok', upstream_status: r.status, ms: r.ms, generated_at: r.body.generated_at || null,
    requested: ids, found: ids.filter((x) => found.has(x)), missing: ids.filter((x) => !found.has(x)), unavailable: [], events };
}
// Targeted reads share the same discipline (P0 2026-10-07), so a slow desk cannot turn live-rail checks into a
// retry storm:
//   1. answered from the whole-lane cache when it is <= TARGETED_LANE_MAX_AGE_MS old and either holds every id or is
//      complete (uncapped) - no upstream read at all
//   2. identical id sets are coalesced and their found/missing answer cached TARGETED_TTL_MS
//   3. a per-sport circuit breaker: after TARGETED_BREAKER_FAILS consecutive failures the sport answers
//      `unavailable` without an upstream read for 30 s, doubling per further failure (max 5 min)
// A failed or skipped read is always `unavailable`, never `missing`.
export const TARGETED_TTL_MS = 30e3;
export const TARGETED_LANE_MAX_AGE_MS = 120e3;
export const TARGETED_BREAKER_FAILS = 2;
const targetedCache = new Map(); // key -> { at, out }
const targetedInflight = new Map();
const breakers = new Map(); // sport -> { fails, openUntil }

export function breakerState(sport, now = Date.now()) {
  const b = breakers.get(sport);
  return b && b.openUntil > now ? { open: true, retry_in_ms: b.openUntil - now, fails: b.fails } : { open: false, fails: b?.fails || 0 };
}

export async function loadTargeted(sport, ids, opts = {}) {
  const now = opts.now || Date.now;
  stats.targeted_requests += 1;
  const lc = laneCache.get(sport);
  if (lc && now() - lc.at <= TARGETED_LANE_MAX_AGE_MS && lc.result.lane.state === 'ok') {
    const inLane = new Set(lc.result.events.map((e) => String(e.canonical_event_id)));
    // Only ids the cached lane actually contains are answered from it. An uncapped lane is NOT the whole inventory:
    // 2026-10-08 00:20Z the uncapped WNBA lane (7 events) omitted live NY @ ATL 401918297, which events=401918297
    // returned with Kalshi prices. Absent ids get the real targeted read (cached, single-flight, breaker).
    if (ids.every((x) => inLane.has(x))) {
      stats.targeted_from_lane += 1;
      return { ...targetedResult(sport, ids, { ok: true, status: 200, body: { events: lc.result.events, generated_at: lc.result.lane.generated_at }, ms: 0 }), source: 'lane_cache', age_ms: now() - lc.at };
    }
  }
  const key = `${sport}:${[...ids].sort().join(',')}`;
  const hit = targetedCache.get(key);
  if (hit && now() - hit.at < TARGETED_TTL_MS) { stats.targeted_cache_hits += 1; return { ...hit.out, source: 'cache', age_ms: now() - hit.at }; }
  if (targetedInflight.has(key)) { stats.targeted_coalesced += 1; return { ...(await targetedInflight.get(key)), source: 'coalesced' }; }
  const br = breakerState(sport, now());
  if (br.open) {
    stats.targeted_breaker += 1;
    return { ...targetedResult(sport, ids, { ok: false, status: 0, error: 'circuit_open', ms: 0 }), source: 'breaker', retry_in_ms: br.retry_in_ms };
  }
  const p = (async () => {
    stats.targeted_upstream += 1;
    const out = targetedResult(sport, ids, await upstreamJson(laneUrl(sport, { events: ids }), { timeoutMs: opts.timeoutMs || 8000, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }));
    if (out.state === 'ok') {
      breakers.delete(sport);
      if (!opts.noMedia && out.events.length) {
        if (sport === 'ufc') await enrichUfc(out.events, opts.media || {});
        if (sport === 'soccer') await enrichSoccer(out.events, opts.media || {});
      }
      targetedCache.set(key, { at: now(), out });
      if (targetedCache.size > 200) targetedCache.delete(targetedCache.keys().next().value);
    } else {
      stats.targeted_failed += 1;
      const b = breakers.get(sport) || { fails: 0, openUntil: 0 };
      b.fails += 1;
      if (b.fails >= TARGETED_BREAKER_FAILS) b.openUntil = now() + Math.min(5 * 60e3, 30e3 * 2 ** (b.fails - TARGETED_BREAKER_FAILS));
      breakers.set(sport, b);
    }
    return out;
  })().finally(() => targetedInflight.delete(key));
  targetedInflight.set(key, p);
  keepAlive(p);
  return { ...(await p), source: 'upstream' };
}

