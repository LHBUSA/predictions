import { requireAllAccess, send } from './_lib/access.js';
import { loadBoard, SPORTS } from './_lib/scores/adapters.js';

// GET /api/live?sports=nfl,nba (empty = all). Compare's requireAllAccess is the ONE entitlement decision; the
// score adapters (vendored from Members @ 59de9d2, see api/_lib/scores/adapters.js) run here directly: no second
// membership check, no proxy hop. Score data is not member-specific, so a short per-instance memo (after the
// entitlement check) keeps member polling from multiplying reads against the sport sites.
const MEMO_MS = 10e3;
const memo = new Map(); // key -> { at, promise }

export function boardFor(key, now = Date.now(), load = loadBoard) {
  const hit = memo.get(key);
  if (hit && now - hit.at < MEMO_MS) return hit.promise;
  const promise = load(key).catch((e) => { memo.delete(key); throw e; });
  memo.set(key, { at: now, promise });
  if (memo.size > 64) memo.delete(memo.keys().next().value);
  return promise;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const member = await requireAllAccess(req, res);
  if (!member) return;
  const raw = String(req.query?.sports || req.query?.sport || '').toLowerCase();
  const wanted = raw ? [...new Set(raw.split(',').filter(Boolean))].sort() : [...SPORTS].sort();
  if (wanted.some((s) => !SPORTS.includes(s))) return send(res, 400, { error: 'unknown_sport' });
  try {
    const body = await boardFor(wanted.join(','));
    return send(res, 200, { ...body, path: 'compare-adapters', adapters: 'members@59de9d2' });
  } catch {
    return send(res, 502, { error: 'score_feed_unavailable', sports: wanted });
  }
}
