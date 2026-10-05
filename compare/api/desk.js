import { requireAllAccess, send } from '../lib/access.js';
import { loadLanes, parseScope } from '../lib/desk.js';

// GET /api/desk?scope=sports|nonsports|<sport>
// 200 with per-lane states (a lane may be not_connected / unavailable while others are ok);
// 502 only when every requested lane is unavailable. The body always carries the lane states.
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const member = await requireAllAccess(req, res);
  if (!member) return;
  const scope = parseScope(req.query || {});
  if (!scope) return send(res, 400, { error: 'unknown_scope' });
  const body = { scope: scope.scope, ...(await loadLanes(scope.lanes)) };
  const allDown = body.lanes.every((l) => l.state === 'unavailable');
  return send(res, allDown ? 502 : 200, allDown ? { error: 'market_desk_unavailable', ...body } : body);
}
