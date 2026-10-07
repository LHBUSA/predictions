import { requireAllAccess, send } from './_lib/access.js';
import { loadLanes, parseScope, loadTargeted, parseTargetedIds, TARGETED_SPORTS } from './_lib/desk.js';

// GET /api/desk?scope=sports|nonsports|<sport>
// GET /api/desk?scope=<sport>&events=<id,...>   targeted live-market check (<=12 ids); see loadTargeted.
//   optional diag=<json>: the client's per-card join verdicts, logged only (never trusted for the response).
// 200 with per-lane states (a lane may be not_connected / unavailable while others are ok);
// 502 only when every requested lane is unavailable. The body always carries the lane states.
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const member = await requireAllAccess(req, res);
  if (!member) return;
  const scope = parseScope(req.query || {});
  if (!scope) return send(res, 400, { error: 'unknown_scope' });
  if (req.query?.events != null) return targeted(req, res, scope);
  const allSports = scope.scope === 'sports';
  const body = { scope: scope.scope, ...(await loadLanes(scope.lanes, {
    concurrency: allSports ? 4 : 1,
    timeoutMs: allSports ? 12000 : 10000
  })) };
  const failed = body.lanes.filter((l) => l.state === 'unavailable');
  if (failed.length) console.warn('[compare:desk] partial upstream failure', JSON.stringify({
    scope: scope.scope,
    failed: failed.map((l) => ({ lane: l.lane, error: l.error, status: l.upstream_status, ms: l.ms })),
    ok: body.lanes.filter((l) => l.state === 'ok').map((l) => ({ lane: l.lane, ms: l.ms }))
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
    sport, state: body.state, ms: body.ms, upstream_status: body.upstream_status, error: body.error || null,
    found: body.events.map((e) => ({ id: String(e.canonical_event_id), title: e.title || null, market_count: (e.contracts || []).length, venues: e.venues_listed || [] })),
    missing: body.missing, unavailable: body.unavailable, client: diag
  };
  (body.state === 'ok' ? console.info : console.warn)('[compare:live-markets]', JSON.stringify(line));
  return send(res, body.state === 'ok' ? 200 : 502, body);
}
