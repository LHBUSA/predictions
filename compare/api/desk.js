import { requireAllAccess, send } from './_lib/access.js';
import { loadLanes, parseScope, loadTargeted, parseTargetedIds, TARGETED_SPORTS, SPORTS_BUDGET_MS, LANE_BUDGET_MS, stats, upstreamActive } from './_lib/desk.js';

// GET /api/desk?scope=sports|nonsports|<sport>
// GET /api/desk?scope=<sport>&events=<id,...>   targeted live-market check (<=12 ids); see loadTargeted.
//   optional diag=<json>: the client's per-card join verdicts, logged only (never trusted for the response).
// 200 with per-lane states (a lane may be not_connected / unavailable while others are ok);
// 502 only when every requested lane is unavailable. The body always carries the lane states.
// Wall-clock budget: ALL SPORTS 5 s, one sport 9 s. Lanes come from the per-instance lane cache (fresh / stale with
// age / coalesced in-flight read); a lane that is still loading answers unavailable + delayed (see _lib/desk.js).
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const member = await requireAllAccess(req, res);
  if (!member) return;
  const scope = parseScope(req.query || {});
  if (!scope) return send(res, 400, { error: 'unknown_scope' });
  if (req.query?.events != null) return targeted(req, res, scope);
  const allSports = scope.scope === 'sports';
  const body = { scope: scope.scope, ...(await loadLanes(scope.lanes, { budgetMs: allSports ? SPORTS_BUDGET_MS : LANE_BUDGET_MS })) };
  const failed = body.lanes.filter((l) => l.state === 'unavailable');
  (failed.length ? console.warn : console.info)('[compare:desk]', JSON.stringify({
    scope: scope.scope, wall_ms: body.wall_ms, budget_ms: body.budget_ms, upstream_active: upstreamActive(),
    lanes: body.lanes.map((l) => ({ lane: l.lane, state: l.state, source: l.source, age_ms: l.age_ms ?? null, ms: l.ms ?? null, delayed: l.delayed || undefined, error: l.error || undefined })),
    stats
  }));
  const allDown = body.lanes.every((l) => l.state === 'unavailable');
  return send(res, allDown ? 502 : 200, allDown ? { error: 'market_desk_unavailable', ...body } : body);
}

// One log line per check, so production can tell discovery (desk has no row) from association (same matchup under
// another id) from availability (read failed). The response never turns a failed read into "no markets".
async function targeted(req, res, scope) {
  const sport = scope.scope;
  if (!TARGETED_SPORTS.has(sport)) return send(res, 400, { error: 'targeted_check_unsupported', sport });
  const ids = parseTargetedIds(req.query.events);
  if (!ids) return send(res, 400, { error: 'bad_events' });
  const body = await loadTargeted(sport, ids);
  let diag = null;
  try { diag = req.query.diag ? JSON.parse(String(req.query.diag)).slice(0, 24) : null; } catch { diag = 'unparseable'; }
  const line = {
    sport, state: body.state, source: body.source, ms: body.ms, upstream_status: body.upstream_status, error: body.error || null, retry_in_ms: body.retry_in_ms,
    found: body.events.map((e) => ({ id: String(e.canonical_event_id), title: e.title || null, market_count: (e.contracts || []).length, venues: e.venues_listed || [] })),
    missing: body.missing, unavailable: body.unavailable, client: diag, stats
  };
  (body.state === 'ok' ? console.info : console.warn)('[compare:live-markets]', JSON.stringify(line));
  return send(res, body.state === 'ok' ? 200 : 502, body);
}
