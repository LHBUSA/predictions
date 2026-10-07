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

export async function loadLanes(lanes, opts = {}) {
  // ALL SPORTS used to fire ten expensive market-desk reads into the same Worker/Supabase backend at once.
  // As the soccer/F1/golf/tennis venue maps grew, that burst started pushing otherwise healthy lanes beyond
  // Compare's 8 s upstream timeout. Bound the fanout; individual sport tabs still remain a single read.
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || lanes.length || 1, lanes.length || 1));
  const upstreamOpts = { ...opts };
  delete upstreamOpts.concurrency; delete upstreamOpts.noMedia; delete upstreamOpts.media;
  const results = await mapLimit(lanes, concurrency, async (lane) => laneResult(lane, await upstreamJson(laneUrl(lane), upstreamOpts)));
  const ufc = results.find((x) => x.lane.lane === 'ufc' && x.lane.state === 'ok');
  const soccer = results.find((x) => x.lane.lane === 'soccer' && x.lane.state === 'ok');
  if (!opts.noMedia) await Promise.all([ufc ? enrichUfc(ufc.events, opts.media || {}) : null, soccer ? enrichSoccer(soccer.events, opts.media || {}) : null]);
  return {
    contract: 'compare-desk/1',
    upstream_contract: results.find((x) => x.contract)?.contract || null,
    generated_at: new Date().toISOString(),
    page_limit: DESK_PAGE_LIMIT,
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
export const TARGETED_SPORTS = new Set(['nfl', 'nba', 'nhl', 'mlb', 'wnba', 'soccer', 'tennis']);
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
export async function loadTargeted(sport, ids, opts = {}) {
  const { noMedia, media, ...upstreamOpts } = opts;
  const out = targetedResult(sport, ids, await upstreamJson(laneUrl(sport, { events: ids }), { timeoutMs: 8000, ...upstreamOpts }));
  if (!noMedia && out.events.length) {
    if (sport === 'ufc') await enrichUfc(out.events, media || {});
    if (sport === 'soccer') await enrichSoccer(out.events, media || {});
  }
  return out;
}
