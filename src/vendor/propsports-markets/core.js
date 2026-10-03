// Kalshi prediction-market core: prices, normalisation, links, state, freshness, NBA matching.
// Pure functions only — no I/O — so every rule is unit-testable.

export const SOURCE = 'kalshi';
export const SOURCE_TYPE = 'prediction_market';
export const NORMALIZER_VERSION = 'kalshi-norm/2'; // /2: Kalshi lifecycle timestamps + settlement fields kept

// ---------------------------------------------------------------------------
// Prices. Kalshi sends dollar strings with 4 decimals ("0.5200"). We never go
// through floats: the string is parsed into integer basis points of a dollar
// (1 bp = $0.0001, so 52¢ = 5200 bp). Missing/blank stays null — never 0.

const DOLLARS_RE = /^(\d+)(?:\.(\d{1,4}))?$/;

export function dollarsToBp(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  const m = DOLLARS_RE.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] || '').padEnd(4, '0'));
  return whole * 10000 + frac;
}

export function bpToCentsLabel(bp) {
  if (bp === null || bp === undefined) return null;
  const cents = bp / 100;
  return Number.isInteger(cents) ? `${cents}¢` : `${cents.toFixed(1)}¢`;
}

// "5379.87" contract counts / dollar notionals. Kept as the raw string plus a
// number for sorting/display; blank stays null.
export function fpNumber(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// A resting bid of $0 means "no bid"; an ask of $1 means "no ask". Raw values are
// preserved untouched; these effective fields are what display rules use.
export function effectiveQuote(rawBidBp, rawAskBp) {
  const bid = rawBidBp !== null && rawBidBp > 0 ? rawBidBp : null;
  const ask = rawAskBp !== null && rawAskBp < 10000 ? rawAskBp : null;
  return { bid, ask };
}

// Mid-market rule (documented, deterministic): midpoint of best YES bid and best
// YES ask, only when both exist and the spread is at most MAX_MID_SPREAD_BP.
// Otherwise null — a 13¢/87¢ placeholder book has no meaningful midpoint.
export const MAX_MID_SPREAD_BP = 1000; // 10¢

export function midBp(bidBp, askBp) {
  if (bidBp === null || askBp === null) return null;
  if (askBp < bidBp) return null;
  if (askBp - bidBp > MAX_MID_SPREAD_BP) return null;
  return (bidBp + askBp) / 2;
}

// ---------------------------------------------------------------------------
// State. Kalshi market status -> our lifecycle.

export function marketState(status) {
  switch (status) {
    case 'active':
      return 'open';
    case 'initialized':
    case 'inactive':
      return 'paused';
    case 'closed':
      return 'closed';
    case 'determined':
    case 'amended':
    case 'finalized':
    case 'settled':
      return 'settled';
    case 'disputed':
      return 'disputed';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Freshness. Measured from OUR capture time (when we last read the quote from
// Kalshi), not Kalshi's updated_time (which only moves when the book changes).

export const LIVE_MS = 150 * 1000; // live lanes read every 1-2 min: <= 2.5 min is current
export const FRESH_MS = 6 * 60 * 1000; // beyond this the price is labelled stale
export const STALE_MS = 30 * 60 * 1000; // past this the price is not shown at all

// Cadence-aware: "delayed" means we are actually behind the lane's expected collection, never
// merely older than some global number. cadenceMs = how often this event is read (live 1, pregame
// / postgame 2, slate 5, idle 15 min); +60 s grace covers the 1-min cron tick, jitter and runtime.
//   current   age <= max(150 s, cadence x 1.25 + 60 s)
//   delayed   age <= max(6 min, cadence x 2 + 60 s)
//   stale     beyond that (labelled), withdrawn (unavailable) past STALE_MS = 30 min, always.
export const CADENCE_GRACE_MS = 60 * 1000;
export function freshnessWindows(cadenceMs = 60 * 1000) {
  return {
    currentMs: Math.max(LIVE_MS, cadenceMs * 1.25 + CADENCE_GRACE_MS),
    delayedMs: Math.max(FRESH_MS, cadenceMs * 2 + CADENCE_GRACE_MS),
  };
}

export function freshness(state, capturedAtIso, nowMs = Date.now(), cadenceMs = 60 * 1000) {
  if (state === 'settled') return 'settled';
  if (state === 'closed') return 'closed';
  if (state !== 'open') return 'unavailable';
  const t = Date.parse(capturedAtIso || '');
  if (!Number.isFinite(t)) return 'unavailable';
  const age = nowMs - t;
  if (age > STALE_MS) return 'unavailable';
  const w = freshnessWindows(cadenceMs);
  if (age <= w.currentMs) return 'live';
  if (age <= w.delayedMs) return 'delayed';
  return 'stale';
}

// ---------------------------------------------------------------------------
// Links. Canonical Kalshi market page, proven 2026-10-02 against live pages
// (KXNBAGAME "NBA Game" -> nba-game, KXNBASPREAD "NBA Spread" -> nba-spread):
//   https://kalshi.com/markets/{series_ticker}/{slug(series title)}/{event_ticker}
// all lower-case. NOTE: kalshi.com answers 200 with a generic "Odds & Predictions"
// title for events that do not exist, so the canary checks the page title, never
// only the status code.

export function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function kalshiEventUrl(seriesTicker, seriesTitle, eventTicker) {
  const series = String(seriesTicker || '').toLowerCase();
  const event = String(eventTicker || '').toLowerCase();
  const slug = slugify(seriesTitle);
  if (!series || !event || !slug) return null;
  if (!event.startsWith(`${series}-`)) return null; // event must belong to the series
  return `https://kalshi.com/markets/${series}/${slug}/${event}`;
}

// ---------------------------------------------------------------------------
// Normalisation of one Kalshi market (raw API object) into our record.

export function normalizeMarket(raw, { series, event, capturedAt }) {
  const yesBid = dollarsToBp(raw.yes_bid_dollars);
  const yesAsk = dollarsToBp(raw.yes_ask_dollars);
  const noBid = dollarsToBp(raw.no_bid_dollars);
  const noAsk = dollarsToBp(raw.no_ask_dollars);
  const last = dollarsToBp(raw.last_price_dollars);
  const volume = fpNumber(raw.volume_fp);
  const eff = effectiveQuote(yesBid, yesAsk);
  const state = marketState(raw.status);
  return {
    source: SOURCE,
    source_type: SOURCE_TYPE,
    normalizer: NORMALIZER_VERSION,
    series_ticker: series.ticker,
    event_ticker: raw.event_ticker,
    market_ticker: raw.ticker,
    title: raw.title ?? null,
    subtitle: raw.subtitle ?? null,
    yes_sub_title: raw.yes_sub_title ?? null,
    no_sub_title: raw.no_sub_title ?? null,
    event_title: event?.title ?? null,
    event_sub_title: event?.sub_title ?? null,
    market_type: raw.market_type ?? null,
    strike: raw.custom_strike ?? null,
    status_raw: raw.status ?? null,
    state,
    result: raw.result ? raw.result : null,
    // raw strings, untouched
    raw: {
      yes_bid_dollars: raw.yes_bid_dollars ?? null,
      yes_ask_dollars: raw.yes_ask_dollars ?? null,
      no_bid_dollars: raw.no_bid_dollars ?? null,
      no_ask_dollars: raw.no_ask_dollars ?? null,
      last_price_dollars: raw.last_price_dollars ?? null,
      volume_fp: raw.volume_fp ?? null,
      volume_24h_fp: raw.volume_24h_fp ?? null,
      open_interest_fp: raw.open_interest_fp ?? null,
      liquidity_dollars: raw.liquidity_dollars ?? null,
      open_time: raw.open_time ?? null,
      close_time: raw.close_time ?? null,
      settlement_ts: raw.settlement_ts ?? null,
      settlement_value_dollars: raw.settlement_value_dollars ?? null,
      expiration_value: raw.expiration_value ?? null,
    },
    // exact integer basis points ($0.0001)
    yes_bid_bp: yesBid,
    yes_ask_bp: yesAsk,
    no_bid_bp: noBid,
    no_ask_bp: noAsk,
    last_price_bp: last,
    best_yes_bid_bp: eff.bid,
    best_yes_ask_bp: eff.ask,
    mid_bp: midBp(eff.bid, eff.ask),
    traded: volume !== null && volume > 0,
    volume,
    volume_24h: fpNumber(raw.volume_24h_fp),
    open_interest: fpNumber(raw.open_interest_fp),
    liquidity: fpNumber(raw.liquidity_dollars),
    open_time: raw.open_time ?? null,
    close_time: raw.close_time ?? null,
    expected_expiration_time: raw.expected_expiration_time ?? null,
    // Kalshi's own lifecycle record: close_time is the ACTUAL close once closed early; settlement_ts and
    // settlement_value come from Kalshi (never inferred from the sports result).
    settlement_ts: raw.settlement_ts ?? null,
    settlement_value_bp: dollarsToBp(raw.settlement_value_dollars),
    expiration_value: raw.expiration_value ?? null,
    source_updated_at: raw.updated_time ?? null,
    captured_at: capturedAt,
    kalshi_url: kalshiEventUrl(series.ticker, series.title, raw.event_ticker),
  };
}

// Display eligibility. A market is shown only when it is open, linkable, has a
// two-sided book and has actually traded. Untraded placeholder books are stored
// (they are real observations) but never rendered.
export function displayable(m) {
  if (!m.kalshi_url) return false;
  if (m.state !== 'open') return false;
  if (m.best_yes_bid_bp === null || m.best_yes_ask_bp === null) return false;
  if (!m.traded) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Ticker identity: KXNBAGAME-26OCT03MIATOR -> { date: '2026-10-03', suffix: 'MIATOR' }

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

export function parseGameEventTicker(eventTicker, seriesTicker) {
  const prefix = `${seriesTicker}-`;
  if (!eventTicker || !eventTicker.startsWith(prefix)) return null;
  const m = /^(\d{2})([A-Z]{3})(\d{2})([A-Z]+)$/.exec(eventTicker.slice(prefix.length));
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (!month) return null;
  const day = Number(m[3]);
  if (day < 1 || day > 31) return null;
  const date = `20${m[1]}-${String(month).padStart(2, '0')}-${m[3]}`;
  return { date, suffix: m[4] };
}

// ---------------------------------------------------------------------------
// NBA game matching — kept as the original entry point; the shared fail-closed matcher
// for every head-to-head sport lives in src/match.js.
import { matchHeadToHead } from './match.js';

export function withTeamIds(teamsByKalshi) {
  return new Map([...teamsByKalshi].map(([k, t]) => [k, { ...t, teamId: String(t.teamId ?? t.espnId) }]));
}

export function matchGameEvent(event, canonicalGames, teamsByKalshi, seriesTicker) {
  return matchHeadToHead(event, canonicalGames, { series: seriesTicker, teams: withTeamIds(teamsByKalshi), strikeKey: 'basketball_team', order: 'away_home' });
}

// ---------------------------------------------------------------------------
// Outcome-equivalence gate for "PBE vs Kalshi". FAILS CLOSED: returns null unless
// the PBE output is from a production-approved model, describes the SAME
// proposition (team wins this game — never a spread/total), for the same
// canonical event and team, and a documented Kalshi mid exists from an
// observation within MAX_COMPARE_SKEW_MS of the PBE issue time.
export const MAX_COMPARE_SKEW_MS = 15 * 60 * 1000;

export function compareModelToKalshi(pbe, kalshi) {
  if (!pbe || !kalshi) return null;
  if (pbe.model_status !== 'production') return null;
  if (pbe.proposition !== 'team_wins_game' || kalshi.proposition !== 'team_wins_game') return null;
  if (!pbe.canonical_event_id || pbe.canonical_event_id !== kalshi.canonical_event_id) return null;
  if (!pbe.team_id || pbe.team_id !== kalshi.team_id) return null;
  if (typeof pbe.probability !== 'number' || pbe.probability < 0 || pbe.probability > 1) return null;
  if (kalshi.mid_bp === null || kalshi.mid_bp === undefined) return null;
  const skew = Math.abs(Date.parse(pbe.issued_at) - Date.parse(kalshi.observed_at));
  if (!Number.isFinite(skew) || skew > MAX_COMPARE_SKEW_MS) return null;
  const pbePts = pbe.probability * 100;
  const kalshiPts = kalshi.mid_bp / 100;
  return {
    label: 'Model-market difference',
    basis: 'PBE probability minus Kalshi mid-market (YES bid/ask midpoint), percentage points',
    pbe_pts: Math.round(pbePts * 10) / 10,
    kalshi_mid_pts: Math.round(kalshiPts * 10) / 10,
    difference_pts: Math.round((pbePts - kalshiPts) * 10) / 10,
    kalshi_observed_at: kalshi.observed_at,
    pbe_issued_at: pbe.issued_at,
  };
}
