import { requireAllAccess, send, upstreamJson } from '../lib/access.js';

// Prediction-market (non-sports) stored series. Sports games use /api/event (composed stored observations).
const UPSTREAM = 'https://propsports-markets.sales-fd3.workers.dev/v1/market-desk/series';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const member = await requireAllAccess(req, res);
  if (!member) return;
  const event = typeof req.query.event === 'string' ? req.query.event : '';
  const market = typeof req.query.market === 'string' ? req.query.market : '';
  const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24));
  if (!event || !market) return send(res, 400, { error: 'event_and_market_required' });
  const url = new URL(UPSTREAM);
  url.searchParams.set('event', event); // URLSearchParams encodes '|' as %7C
  url.searchParams.set('market', market);
  url.searchParams.set('hours', String(hours));
  const r = await upstreamJson(url.toString());
  if (r.ok) return send(res, 200, r.body);
  if (r.status === 404) return send(res, 404, { error: 'no_stored_series', upstream_status: 404 });
  return send(res, 502, { error: 'series_unavailable', upstream_status: r.status, detail: r.error || r.body?.error || null });
}
