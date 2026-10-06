import { requireAllAccess, send } from './_lib/access.js';
import { loadLanes, parseScope } from './_lib/desk.js';

// GET /api/desk?scope=sports|nonsports|<sport>
// 200 with per-lane states (a lane may be not_connected / unavailable while others are ok);
// 502 only when every requested lane is unavailable. The body always carries the lane states.
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const member = await requireAllAccess(req, res);
  if (!member) return;
  const scope = parseScope(req.query || {});
  if (!scope) return send(res, 400, { error: 'unknown_scope' });
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
