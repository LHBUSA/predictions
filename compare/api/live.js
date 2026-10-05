import { requireAllAccess, send, sessionCookie, upstreamJson } from '../lib/access.js';

// INTERIM (2026-10-05): proxies the Members live board until the score adapters run in Compare (item 8).
// Compare's own requireAllAccess is the entitlement decision for this request. If Members then disagrees
// (401/403), that is an authority mismatch between two services, not the member's state: it is reported as
// score_feed_auth_mismatch so the UI shows "score feed unavailable", never "sign in".
const LIVE_URL = 'https://members.propbetedge.ai/api/live';
const SPORTS = ['mlb', 'nfl', 'nba', 'wnba', 'nhl', 'ufc', 'tennis', 'soccer', 'golf', 'f1'];

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const member = await requireAllAccess(req, res);
  if (!member) return;
  const raw = String(req.query?.sports || req.query?.sport || '').toLowerCase();
  const wanted = raw ? raw.split(',').filter(Boolean) : SPORTS;
  if (wanted.some((s) => !SPORTS.includes(s))) return send(res, 400, { error: 'unknown_sport' });
  const url = new URL(LIVE_URL);
  url.searchParams.set('sports', wanted.join(','));
  const cookie = sessionCookie(req.headers?.cookie || '');
  const r = await upstreamJson(url.toString(), { headers: cookie ? { cookie } : {}, timeoutMs: 9000 });
  if (r.ok) return send(res, 200, { ...r.body, path: 'members-proxy' });
  if (r.status === 401 || r.status === 403) return send(res, 502, { error: 'score_feed_auth_mismatch', upstream_status: r.status, sports: wanted });
  return send(res, 502, { error: 'score_feed_unavailable', upstream_status: r.status, detail: r.error || null, sports: wanted });
}
