// VENUE BENCHMARKS (pbe-venues/1). Kalshi and Polymarket as INDEPENDENT, first-class benchmarks of a PBE forecast.
// Pure functions over stored observations only (pred_venue_snapshots for Kalshi; market_venue_quotes_v2 /
// market_venue_observations for Polymarket, written by propsports-markets). Rules:
//  - venues are never averaged; there is no consensus number;
//  - a PBE-vs-venue divergence exists only when the venue contract is semantically comparable to the contract PBE
//    models (Kalshi = the defining contract; Polymarket = EXACT_MATCH, or COMPARABLE_EXCEPT_EXCEPTIONS for an
//    approved exception family). RULE_MISMATCH shows the native price as a related market; UNVERIFIED shows no inference;
//  - a benchmark at time T is the latest stored observation AT OR BEFORE T, never a later one. If none exists (or the
//    observer was not running), the benchmark is permanently NO_OBSERVATION_AT_PBE_FORECAST;
//  - nothing here feeds a model or a decision (venue values are attached beside the frozen PBE forecast).

export const VENUES_SCHEMA = 'pbe-venues/1';
export const AGREEMENT_PTS = 2; // |PBE - venue| <= 2 pts -> PBE / MARKET AGREEMENT (pbe-vs-venue/1)
// Exception families whose COMPARABLE_EXCEPT_EXCEPTIONS pairs may be compared numerically (owner-approved). The only
// approved family (sports postponement/cancellation) never applies to Predictions contracts.
export const APPROVED_EXCEPTION_FAMILIES = Object.freeze(new Set(['sports_postponement_cancellation']));
export const VENUE_LABEL = Object.freeze({ kalshi: 'Kalshi', polymarket: 'Polymarket' });
export const NO_OBSERVATION = 'NO_OBSERVATION_AT_PBE_FORECAST';

const pctBp = (bp) => (bp === null || bp === undefined ? null : Math.round(Number(bp) / 100));
const pct = (p) => (p === null || p === undefined ? null : Math.round(Number(p) * 100));
const t = (s) => Date.parse(s);

// Normalize a stored row to one quote shape (basis points; mid = comparable two-sided mid or null).
export function kalshiQuote(r) {
  return { observed_at: r.captured_at, bid_bp: r.bid === null || r.bid === undefined ? null : Math.round(Number(r.bid) * 10000), ask_bp: r.ask === null || r.ask === undefined ? null : Math.round(Number(r.ask) * 10000), mid_bp: r.probability === null || r.probability === undefined ? null : Math.round(Number(r.probability) * 10000), state: r.lifecycle || r.market_status || null, ref: r.snapshot_key || r.venue_snapshot_id || null, resolution_bp: null };
}
export function polymarketQuote(r) {
  return { observed_at: r.observed_at, bid_bp: r.bid_bp ?? null, ask_bp: r.ask_bp ?? null, mid_bp: r.comparable_mid_bp === null || r.comparable_mid_bp === undefined ? null : Number(r.comparable_mid_bp), state: r.market_state || null, ref: r.observation_ref ?? null, archive: r.archive_object_key ?? null, resolution_bp: r.resolution_value_bp ?? null };
}

// owner rule: 'live' = observation <= 2.5 min old
export function freshness(observedAt, now, { liveS = 150, delayedS = 7200 } = {}) {
  if (!observedAt) return null;
  const age = (t(now) - t(observedAt)) / 1000;
  return { age_s: Math.max(0, Math.round(age)), label: age <= liveS ? 'live' : age <= delayedS ? 'delayed' : 'stale' };
}

// Latest quote with observed_at <= T (quotes sorted ascending). `coverageFrom` = when PBE's observer for this venue
// market started; before it nothing can be claimed. `coverageAt(T)` (optional) = was the observer reading at T.
export function quoteAtOrBefore(quotes, T, { coverageFrom = null, coverageAt = null } = {}) {
  if (!T) return null;
  const tt = t(T);
  if (coverageFrom && tt < t(coverageFrom)) return null;
  let best = null;
  for (const q of quotes) { if (t(q.observed_at) <= tt) best = q; else break; }
  if (!best) return null;
  if (coverageAt && coverageAt(T) === false) return null;
  return best;
}

export function divergence(pbePct, venueMidBp) {
  if (pbePct === null || pbePct === undefined || venueMidBp === null || venueMidBp === undefined) return null;
  const d = pbePct - pctBp(venueMidBp);
  return { pts: d, label: Math.abs(d) <= AGREEMENT_PTS ? 'PBE_MARKET_AGREEMENT' : d > 0 ? 'PBE_ABOVE_MARKET' : 'PBE_BELOW_MARKET' };
}

// Semantic class -> presentation (owner rules 2026-10-03/04).
export function semantics(state, family = null) {
  if (state === 'DEFINING_VENUE' || state === 'EXACT_MATCH') return { comparable: true, display: 'numbers', label: state === 'EXACT_MATCH' ? 'Exact match' : 'Defining contract' };
  if (state === 'COMPARABLE_EXCEPT_EXCEPTIONS') return APPROVED_EXCEPTION_FAMILIES.has(family) ? { comparable: true, display: 'numbers_with_disclosure', label: 'Comparable except stated exceptions' } : { comparable: false, display: 'native_price_related', label: 'Related market · exception set not approved for comparison' };
  if (state === 'RULE_MISMATCH') return { comparable: false, display: 'native_price_related', label: 'Related market · rules differ' };
  if (state === 'UNVERIFIED') return { comparable: false, display: 'native_price_unverified', label: 'Unverified · not compared' };
  return { comparable: false, display: 'omit', label: null };
}

const checkpoint = (q) => (q ? { observed_at: q.observed_at, mid_bp: q.mid_bp, mid_pct: pctBp(q.mid_bp), bid_pct: pctBp(q.bid_bp), ask_pct: pctBp(q.ask_bp), ref: q.ref ?? null } : null);

// One venue block for one contract.
// forecasts: PBE public forecasts for the contract (ascending), each {forecast_id, captured_at, probability, roles[]}.
// lastCheckedAt: latest observer read of this venue (change-only storage: an unchanged price writes no new row, so
// the quote is current as of the last read, not as of its row time).
export function venueBlock({ venue, quotes, state, family = null, reasons = [], marketId, url = null, rulesSha256 = null, coverageFrom = null, coverageAt = null, lastCheckedAt = null, closeTime = null, forecasts = [], now, resolution = null }) {
  const qs = [...quotes].sort((a, b) => t(a.observed_at) - t(b.observed_at));
  const sem = semantics(state, family);
  if (sem.display === 'omit') return null;
  const last = qs.at(-1) || null;
  const finalQ = closeTime ? quoteAtOrBefore(qs, closeTime) : null;
  const closed = closeTime && t(now) >= t(closeTime);
  const atForecast = forecasts.map((f) => {
    const q = quoteAtOrBefore(qs, f.captured_at, { coverageFrom, coverageAt });
    const pbe = pct(f.probability);
    if (!q) return { forecast_id: f.forecast_id, pbe_at: f.captured_at, roles: f.roles || [], pbe_pct: pbe, benchmark: NO_OBSERVATION };
    const div = sem.comparable ? divergence(pbe, q.mid_bp) : null;
    return { forecast_id: f.forecast_id, pbe_at: f.captured_at, roles: f.roles || [], pbe_pct: pbe, benchmark: { ...checkpoint(q), observation_age_s: Math.round((t(f.captured_at) - t(q.observed_at)) / 1000) }, divergence: div };
  });
  const latestF = forecasts.at(-1) || null;
  const checked = lastCheckedAt && last && t(lastCheckedAt) >= t(last.observed_at) ? lastCheckedAt : null;
  const current = last ? { ...checkpoint(last), freshness: freshness(checked || last.observed_at, now), checked_at: checked, state: last.state } : null;
  return {
    venue, venue_label: VENUE_LABEL[venue] || venue, market_id: marketId, url, rules_sha256: rulesSha256,
    semantic_class: state, comparable: sem.comparable, display: sem.display, display_label: sem.label, reasons,
    current,
    divergence_now: sem.comparable && latestF && current ? divergence(pct(latestF.probability), last.mid_bp) : null,
    first_observed: checkpoint(qs[0] || null),
    at_forecast: atForecast,
    final_pre_close: closed ? checkpoint(finalQ) : null,
    resolution: resolution ?? (last?.resolution_bp !== null && last?.resolution_bp !== undefined ? { value_pct: pctBp(last.resolution_bp), observed_at: last.observed_at } : null),
    path: qs.map((q) => ({ t: q.observed_at, mid: pctBp(q.mid_bp), bid: pctBp(q.bid_bp), ask: pctBp(q.ask_bp) })),
    path_n: qs.length,
    coverage_from: coverageFrom,
  };
}

// Brier of a venue mid as a benchmark at the same designated timestamp as the PBE forecast.
export function brier(pBp, outcome) { return pBp === null || pBp === undefined ? null : +((Number(pBp) / 10000 - outcome) ** 2).toFixed(6); }
export function logLoss(pBp, outcome) {
  if (pBp === null || pBp === undefined) return null;
  const p = Math.min(1 - 1e-4, Math.max(1e-4, Number(pBp) / 10000));
  return +(-(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p))).toFixed(6);
}
