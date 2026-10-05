// One expanded sports game = one composed read of two EXISTING public stored-observation routes:
//   Kalshi      propsports-markets /v1/market-intelligence/event/:sport/:id   (change rows, book, volume, OI)
//   Polymarket  propsports-markets /v1/market-desk?sport=&event=              (72 h stored change rows)
// Points are passed through as stored. Nothing is interpolated or reconstructed here.
import { MARKET_INTEL_URL, upstreamJson } from './access.js';
import { laneUrl } from './desk.js';

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const cid = (sport, id, teamId) => `sports_winner|${sport}:${id}|team:${teamId}`;

export function composeEvent(sport, id, intel, desk) {
  const k = intel.ok ? intel.body?.event?.kalshi : null;
  const kMove = intel.ok ? intel.body?.event?.movement?.kalshi || {} : {};
  const dEvent = desk.ok ? (desk.body?.events || []).find((e) => String(e.canonical_event_id) === String(id)) : null;
  const byId = new Map();
  const get = (key, seed) => { if (!byId.has(key)) byId.set(key, { canonical_contract_id: key, ...seed, kalshi: null, polymarket: null }); return byId.get(key); };
  for (const o of k?.outcomes || []) {
    if (!o.team_id) continue;
    const c = get(cid(sport, id, o.team_id), { label: o.abbr || o.kalshi_name || o.role, role: o.role });
    const pts = (kMove[o.role]?.points || []).filter((p) => p.state === 'open' && num(p.mid_bp) !== null).map((p) => ({ t: p.t, v: num(p.mid_bp) }));
    c.kalshi = {
      yes_bid_bp: num(o.yes_bid_bp), yes_ask_bp: num(o.yes_ask_bp), no_bid_bp: num(o.no_bid_bp), no_ask_bp: num(o.no_ask_bp),
      last_bp: num(o.last_price_bp), mid_bp: num(o.mid_bp), volume: num(o.volume), volume_24h: num(o.volume_24h), open_interest: num(o.open_interest),
      contract: o.contract || null, ticker: o.market_ticker || null, state: o.state || null, observed_at: k.observed_at || null,
      points: pts, points_rule: 'Stored change rows (a row when the book changes); value holds until the next row while the lane keeps reading.'
    };
  }
  for (const c0 of dEvent?.contracts || []) {
    const c = get(c0.canonical_contract_id, { label: c0.label, role: c0.role });
    const pm = (c0.venues || []).find((v) => v.venue === 'polymarket') || (c0.related || []).find((v) => v.venue === 'polymarket') || (c0.listed || []).find((v) => v.venue === 'polymarket');
    if (pm) c.polymarket = { match: pm.match || null, mid_bp: num(pm.mid_bp), observed_at: pm.observed_at || null, points: (pm.movement?.points || []).filter((p) => num(p.mid_bp) !== null).map((p) => ({ t: p.t, v: num(p.mid_bp) })), first_observed_at: pm.movement?.first_observed_at || null };
  }
  return {
    contract: 'compare-event/1',
    generated_at: new Date().toISOString(),
    sport, canonical_event_id: String(id),
    sources: {
      kalshi: { state: intel.ok ? 'ok' : intel.status === 404 ? 'not_found' : 'unavailable', upstream_status: intel.status, observed_at: k?.observed_at || null, freshness: k?.freshness || null, read_cadence_min: num(k?.read_cadence_min) },
      polymarket: { state: desk.ok ? (dEvent ? 'ok' : 'not_found') : 'unavailable', upstream_status: desk.status }
    },
    contracts: [...byId.values()]
  };
}

export async function loadEvent(sport, id, opts = {}) {
  const [intel, desk] = await Promise.all([
    upstreamJson(`${MARKET_INTEL_URL}/event/${encodeURIComponent(sport)}/${encodeURIComponent(id)}`, opts),
    upstreamJson(laneUrl(sport, { event: id }), opts)
  ]);
  return composeEvent(sport, id, intel, desk);
}
