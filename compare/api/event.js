import { requireAllAccess, send } from './_lib/access.js';
import { SPORT_LANES } from './_lib/desk.js';
import { loadEvent } from './_lib/event.js';

// GET /api/event?sport=<sport>&event=<canonical id>: one game's stored Kalshi + Polymarket observations.
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const member = await requireAllAccess(req, res);
  if (!member) return;
  const sport = String(req.query?.sport || '').toLowerCase();
  const event = String(req.query?.event || '');
  if (!SPORT_LANES.includes(sport) || !/^[A-Za-z0-9_.:-]{1,80}$/.test(event)) return send(res, 400, { error: 'sport_and_event_required' });
  const body = await loadEvent(sport, event);
  const down = body.sources.kalshi.state === 'unavailable' && body.sources.polymarket.state === 'unavailable';
  return send(res, down ? 502 : 200, down ? { error: 'event_history_unavailable', ...body } : body);
}
