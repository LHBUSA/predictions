// Market history — one venue-neutral lifecycle + market path for every sport (owner 2026-10-03).
// Built ONLY from what we stored: the append-only snapshot rows and the observation path carried on the
// link. Nothing is interpolated, back-dated or inferred from the sports result.
//
// Lifecycle (event level):
//   DISCOVERED  matched, but no tradable two-sided market observed yet (Kalshi initialized/paused)
//   UPCOMING    tradable; the event has not started
//   ACTIVE      tradable; the event is in progress (or past its start)
//   CLOSED      trading closed, settlement not yet observed  -> "MARKET CLOSED · AWAITING SETTLEMENT"
//   SETTLED     every contract settled by the venue (result from the venue, never from our score)
// A FINAL sports event is not a SETTLED market; first observed is not the open; last observed is not
// the close unless the venue says the market closed.
import { orderOutcomes } from './api-order.js';
import { effectiveQuote, midBp } from './core.js';

const midOf = (bid, ask) => { const e = effectiveQuote(bid ?? null, ask ?? null); return midBp(e.bid, e.ask); };

export const HISTORY_VERSION = 'market-history/1';
export const LIFECYCLE = ['DISCOVERED', 'UPCOMING', 'ACTIVE', 'CLOSED', 'SETTLED'];
const START_EVIDENCE_MS = 15 * 60 * 1000; // a pre-start quote older than this is not "at start"
const FIELD_TOP = 12;

const outsOf = (link) => Object.values(link?.current?.outcomes || {}).filter((o) => o && o.role && o.obs);

export function lifecycleOf(link, nowMs = Date.now()) {
  const outs = outsOf(link);
  if (!link || link.match_status !== 'matched' || !outs.length) return null;
  const states = outs.map((o) => o.obs.state);
  if (states.includes('open')) {
    const start = Date.parse(link.event_start_at || '');
    const begun = link.event_state === 'in' || link.event_state === 'post' || (Number.isFinite(start) && nowMs >= start);
    return begun ? 'ACTIVE' : 'UPCOMING';
  }
  if (states.every((s) => s === 'settled')) return 'SETTLED';
  if (states.some((s) => s === 'closed' || s === 'settled')) return 'CLOSED';
  return 'DISCOVERED';
}

const price = (p) => (p ? { t: p.t, state: p.state ?? null, bid_bp: p.bid_bp ?? null, ask_bp: p.ask_bp ?? null, mid_bp: p.mid_bp ?? null, last_bp: p.last_bp ?? null } : null);
const fromSnap = (s) => ({ t: s.observed_at, state: s.state, milestone: s.milestone, bid_bp: s.yes_bid_bp ?? null, ask_bp: s.yes_ask_bp ?? null, mid_bp: midOf(s.yes_bid_bp, s.yes_ask_bp), last_bp: s.last_price_bp ?? null, volume: s.volume ?? null, raw: s.raw || null, result: s.result ?? null });
const fromObs = (o) => ({ t: o.observed_at, state: o.state, milestone: 'current', bid_bp: o.yes_bid_bp ?? null, ask_bp: o.yes_ask_bp ?? null, mid_bp: o.mid_bp ?? null, last_bp: o.last_price_bp ?? null, volume: o.volume ?? null, raw: null, result: o.result ?? null });
const ts = (p) => Date.parse(p?.t || '');

// One outcome's path. snaps: this outcome's snapshot rows (any order). o: the link outcome.
export function outcomePath(o, snaps, link) {
  const pts = snaps.map(fromSnap);
  if (o.obs?.observed_at && !pts.some((p) => p.t === o.obs.observed_at)) pts.push(fromObs(o.obs));
  pts.sort((a, b) => ts(a) - ts(b));
  const firstSnap = pts.find((p) => p.milestone === 'first_observed') || pts[0] || null;
  const first = o.first ? { ...o.first } : firstSnap ? { t: firstSnap.t, state: firstSnap.state, bid_bp: firstSnap.bid_bp, ask_bp: firstSnap.ask_bp, mid_bp: firstSnap.mid_bp, last_bp: firstSnap.last_bp, volume: firstSnap.volume } : null;
  const open = pts.filter((p) => p.state === 'open');
  const lastOpenPt = open[open.length - 1] || null;
  const lastOpen = o.last_open && (!lastOpenPt || ts({ t: o.last_open.t }) >= ts(lastOpenPt)) ? o.last_open : lastOpenPt;
  // At start: the venue quote we actually observed just before the event began (milestone 'start', or
  // the last open observation within START_EVIDENCE_MS before the start time). Otherwise none.
  const startMs = Date.parse(link?.event_start_at || '');
  let atStart = pts.find((p) => p.milestone === 'start') || (o.last_pre ? { ...o.last_pre } : null);
  if (!atStart && Number.isFinite(startMs)) {
    const before = open.filter((p) => ts(p) <= startMs);
    const cand = before[before.length - 1];
    if (cand && startMs - ts(cand) <= START_EVIDENCE_MS) atStart = cand;
  }
  const obs = o.obs || {};
  const closed = obs.state === 'closed' || obs.state === 'settled';
  const closeObs = pts.find((p) => p.state === 'closed' || p.state === 'settled') || null;
  const settledObs = pts.find((p) => p.state === 'settled') || null;
  const settledRaw = settledObs?.raw || {};
  const kalshiClose = obs.close_time || settledRaw.close_time || closeObs?.raw?.close_time || null;
  const settlementAt = obs.settlement_ts || settledRaw.settlement_ts || null;
  const close = closed ? {
    // the venue's actual close time when it reported one; otherwise only the time we first SAW it closed
    at: kalshiClose, at_basis: kalshiClose ? 'venue_close_time' : 'first_observed_closed',
    observed_at: closeObs?.t ?? obs.observed_at ?? null,
    final_trade_bp: (closeObs?.last_bp ?? obs.last_price_bp) ?? null, // the venue's last traded price at close
  } : null;
  const settlement = obs.state === 'settled' ? {
    result: obs.result ?? settledObs?.result ?? null,
    at: settlementAt || settledObs?.t || obs.observed_at || null, at_basis: settlementAt ? 'venue_settlement_ts' : 'first_observed_settled',
    value_bp: obs.settlement_value_bp ?? (settledRaw.settlement_value_dollars != null ? Math.round(Number(settledRaw.settlement_value_dollars) * 10000) : null),
    expiration_value: obs.expiration_value ?? settledRaw.expiration_value ?? null,
  } : null;
  // How complete is what we hold? (never dressed up as more complete than it is)
  let history;
  if (!first) history = settlement ? 'settlement_only' : close ? 'close_only' : 'latest_only';
  else if (first.state === 'settled') history = 'settlement_only';
  else if (first.state === 'closed') history = 'close_only';
  else if (open.length + (o.last_open ? 1 : 0) < 2) history = 'latest_only';
  else history = first.volume === 0 ? 'full' : 'partial';
  const chart = open.filter((p) => p.mid_bp != null || p.last_bp != null).map((p) => ({ t: p.t, mid_bp: p.mid_bp, last_bp: p.last_bp }));
  return {
    role: o.role, team_id: o.team_id ?? null, abbr: o.abbr ?? null, kalshi_name: o.kalshi_name ?? null, contract: o.title ?? null,
    market_ticker: obs.market_ticker ?? null, state: obs.state ?? null,
    first_observed: first ? { ...price(first), before_first_trade: first.volume === 0, label: first.volume === 0 ? 'Observed before the first trade' : 'First observed' } : null,
    venue_open_time: obs.open_time ?? null,
    at_start: price(atStart),
    last_tradable: price(lastOpen),
    close, settlement, history, chart,
  };
}

const RANK = { full: 4, partial: 3, latest_only: 2, close_only: 1, settlement_only: 0 };
// Full market history for one matched event. snaps: every snapshot row for the event.
export function historyView(link, snaps = [], nowMs = Date.now()) {
  const lifecycle = lifecycleOf(link, nowMs);
  if (!lifecycle) return null;
  const by = {};
  for (const s of snaps) if (s.source_type === 'prediction_market' && s.outcome_role) (by[s.outcome_role] ||= []).push(s);
  const outs = outsOf(link);
  let ordered = orderOutcomes(outs);
  if (!ordered) return null;
  const isField = ordered[0]?.role?.startsWith('p:');
  let outcomes = ordered.map((o) => outcomePath(o, by[o.role] || [], link));
  let more = 0;
  if (isField) {
    // ranked: venue winner(s) first, then by final trade / last tradable price
    const key = (x) => (x.settlement?.result === 'yes' ? 1e6 : 0) + (x.close?.final_trade_bp ?? x.last_tradable?.mid_bp ?? x.last_tradable?.last_bp ?? -1);
    outcomes.sort((a, b) => key(b) - key(a));
    more = Math.max(0, outcomes.length - FIELD_TOP);
    outcomes = outcomes.slice(0, FIELD_TOP);
  }
  const closeAts = outcomes.map((x) => x.close?.at).filter(Boolean).sort();
  const settleAts = outcomes.map((x) => x.settlement?.at).filter(Boolean).sort();
  const history = outcomes.reduce((m, x) => (RANK[x.history] < RANK[m] ? x.history : m), 'full');
  return {
    version: HISTORY_VERSION,
    label: 'Market history',
    venue: link.source || 'kalshi',
    venue_label: 'Kalshi',
    market_type: 'prediction_market',
    lifecycle,
    status_label: { DISCOVERED: 'Market listed', UPCOMING: 'Market open', ACTIVE: 'Market trading', CLOSED: 'Market closed · awaiting settlement', SETTLED: 'Market settled' }[lifecycle],
    proposition: link.current?.proposition ?? null,
    market_url: link.market_url ?? null,
    event_ticker: link.source_event_id ?? null,
    shape: isField ? 'field' : outcomes.length === 3 ? 'three_way' : 'two_way',
    outcomes,
    more_outcomes: more,
    markers: {
      event_start: link.event_start_at ?? null,
      market_close: closeAts[closeAts.length - 1] ?? null,
      settlement: settleAts[settleAts.length - 1] ?? null,
    },
    history,
    note: 'Observed prices only. "First observed" is when we first recorded the market, not its opening price, unless marked as observed before the first trade. Settlement is the venue\'s, not our result.',
  };
}

// Compact first -> close summary for result cards (board). No snapshot query: uses the path carried on
// the link. Only for CLOSED / SETTLED events.
export function closeSummary(link, nowMs = Date.now()) {
  const lifecycle = lifecycleOf(link, nowMs);
  if (lifecycle !== 'CLOSED' && lifecycle !== 'SETTLED') return null;
  const ordered = orderOutcomes(outsOf(link));
  if (!ordered) return null;
  const rows = ordered.map((o) => ({
    role: o.role, abbr: o.abbr ?? null,
    first_bp: o.first ? (o.first.mid_bp ?? o.first.last_bp ?? null) : null,
    first_label: o.first ? (o.first.volume === 0 ? 'before_first_trade' : 'first_observed') : null,
    last_tradable_bp: o.last_open ? (o.last_open.mid_bp ?? o.last_open.last_bp ?? null) : null,
    before_start_bp: o.last_pre ? (o.last_pre.mid_bp ?? o.last_pre.last_bp ?? null) : null,
    before_start_at: o.last_pre?.t ?? null,
    final_trade_bp: o.obs?.last_price_bp ?? null,
    result: o.obs?.state === 'settled' ? (o.obs.result ?? null) : null,
  }));
  const field = ordered[0]?.role?.startsWith('p:');
  const top = field ? rows.filter((r) => r.result === 'yes').concat(rows.filter((r) => r.result !== 'yes').sort((a, b) => (b.last_tradable_bp ?? -1) - (a.last_tradable_bp ?? -1))).slice(0, 3) : rows;
  return { lifecycle, shape: field ? 'field' : rows.length === 3 ? 'three_way' : 'two_way', outcomes: top };
}
