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

export function laneUrl(lane, { event = null } = {}) {
  const u = new URL(MARKET_DESK_URL);
  if (lane === 'nonsports') u.searchParams.set('domain', 'nonsports');
  else u.searchParams.set('sport', lane);
  if (event) u.searchParams.set('event', event);
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

export async function loadLanes(lanes, opts = {}) {
  const results = await Promise.all(lanes.map(async (lane) => laneResult(lane, await upstreamJson(laneUrl(lane), opts))));
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
