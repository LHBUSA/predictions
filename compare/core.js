// Compare core: pure functions shared by the browser (app.js) and node tests. No DOM, no fetch.
// Every number keeps its source timestamp; nothing is interpolated; absence is labelled, never zero.

export const SPORTS = [
  { key: 'nfl', label: 'NFL' }, { key: 'nba', label: 'NBA' }, { key: 'nhl', label: 'NHL' }, { key: 'mlb', label: 'MLB' },
  { key: 'wnba', label: 'WNBA' }, { key: 'soccer', label: 'Soccer' }, { key: 'tennis', label: 'Tennis' }, { key: 'ufc', label: 'UFC' },
  { key: 'golf', label: 'Golf' }, { key: 'f1', label: 'F1' }
];
export const SPORT_KEYS = SPORTS.map((s) => s.key);

// Score <-> market joins are ID-ONLY. These sports' market canonical_event_id is the same provider id the
// score feed publishes (ESPN event id for NFL/NBA, MLB gamePk, NHL gamePk), proven 2026-10-05.
// Every other sport is UNMATCHED until a deterministic crosswalk exists (UFC: desk = bouts, feed = cards).
export const ID_JOIN_SPORTS = new Set(['nfl', 'nba', 'mlb', 'nhl']);

export const BADGES = {
  COMPARABLE: 'Both venues list this outcome and their settlement rules were approved as comparable. The gap is a real price difference on the same question.',
  EXACT: 'Both venues settle this contract under identical rules (rule hashes re-checked at read time).',
  RULE_MISMATCH: 'Both venues list a market on this game, but their settlement rules differ, so the prices are shown side by side and never compared.',
  WITHDRAWN: 'The comparison was withdrawn because the game is no longer scheduled normally (final, postponed or start moved). Prices are not compared.',
  SINGLE_VENUE: 'Only one venue lists this contract right now. There is nothing to compare against.',
  UNMATCHED: 'No deterministic link between this market and a score-feed event, so no score is attached. We never guess by team name.',
  NOT_ALIGNED: 'Both venues are quoted, but the observations are stale or more than 120 seconds apart, so no spread is computed.'
};

export const REASON_TEXT = {
  exceptions_differs: 'Postponement / cancellation / tie settlement rules differ between venues.',
  window_tz_differs: 'The measurement window or time zone differs.',
  resolution_source_differs: 'The venues resolve from different official sources.',
  measurement_unknown: 'One venue does not state how the value is measured.',
  rounding_unknown: 'One venue does not state its rounding rule.',
  venue_start_disagrees: 'The venues list different start times for this event.',
  canonical_state_not_scheduled: 'The game is no longer scheduled or in progress.'
};
export const reasonText = (code) => REASON_TEXT[String(code).split(':')[0]] || null;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const cents = (bp) => (bp == null ? null : bp / 100);
export const fmtCents = (bp) => (bp == null ? '—' : `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}¢`);
export const fmtPct = (p) => (p == null ? '—' : `${(p * 100).toFixed(Math.abs(p * 100 - Math.round(p * 100)) > 0.05 ? 1 : 0)}%`);

export function ageText(iso, now = Date.now()) {
  const ms = now - Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  if (ms < 0) return 'just now';
  if (ms < 60e3) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3600e3) return `${Math.round(ms / 60e3)}m ago`;
  if (ms < 86400e3) return `${Math.round(ms / 3600e3)}h ago`;
  return `${Math.round(ms / 86400e3)}d ago`;
}

// ---------------------------------------------------------------------------------------------------------
// Venue quote -> display price. YES = mid of the stored best bid/ask; NO = 100¢ − YES (binary contract).
export function venuePrice(v) {
  if (!v) return null;
  const mid = num(v.mid_bp);
  return {
    venue: v.venue, match: v.match || null, mid_bp: mid, yes_bp: mid, no_bp: mid == null ? null : 10000 - mid,
    bid_bp: num(v.bid_bp), ask_bp: num(v.ask_bp), spread_bp: num(v.spread_bp), observed_at: v.observed_at || null,
    freshness: String(v.freshness || 'unknown').toLowerCase(), market_url: v.market_url || null, disclosure: v.disclosure || null,
    venue_market_id: v.venue_market_id || null
  };
}

// One contract (one outcome of one event) -> normalized row with its comparability badge.
export function normalizeContract(c) {
  const venues = c.venues || [];
  const k = venuePrice(venues.find((v) => v.venue === 'kalshi'));
  const p = venuePrice(venues.find((v) => v.venue === 'polymarket'));
  const related = (c.related || []).map((r) => ({ ...venuePrice(r), match: r.match, reason: r.reason || null, reasons: (r.reasons || []).filter((x) => !String(x).startsWith('comparable_approval')), withdrawn: r.comparison_withdrawn || null, title: r.title || null, summary: r.summary || null }));
  const listed = (c.listed || []).map(venuePrice);
  const cmp = c.comparison || null;
  let badge, note = null;
  if (cmp) { badge = 'COMPARABLE'; note = cmp.match_class === 'EXACT_MATCH' ? 'EXACT' : null; }
  else if (k?.mid_bp != null && p?.mid_bp != null) { badge = 'COMPARABLE'; note = 'NOT_ALIGNED'; }
  else if (related.some((r) => r.withdrawn)) badge = 'WITHDRAWN';
  else if (related.some((r) => r.match === 'RULE_MISMATCH' || r.match === 'COMPARABLE_EXCEPT_EXCEPTIONS')) badge = 'RULE_MISMATCH';
  else badge = 'SINGLE_VENUE';
  const gap = cmp ? num(cmp.venue_gap_pts) : null;
  const priced = [k, p, ...related, ...listed].filter((x) => x && x.mid_bp != null);
  const pbe = c.pbe && num(c.pbe.probability) != null ? { probability: num(c.pbe.probability), state: c.pbe.state || null, issued_at: c.pbe.issued_at || null, model: c.pbe.model || null, selection: c.pbe.selection || null } : null;
  return {
    id: c.canonical_contract_id || c.label, label: c.label || null, role: c.role || null,
    kalshi: k, polymarket: p, related, listed, comparison: cmp, badge, note,
    gap_pts: gap, gap_rel_pct: gap != null && k?.mid_bp != null && p?.mid_bp != null ? (gap * 100) / ((k.mid_bp + p.mid_bp) / 200) : null,
    pbe, pbe_vs_venues: cmp?.pbe_vs_venues_pts || null, pbe_position: cmp?.pbe_position || null,
    priced: priced.length > 0, all_stale: priced.length > 0 && priced.every((x) => x.freshness === 'stale'),
    freshest_at: priced.map((x) => x.observed_at).filter(Boolean).sort().at(-1) || null
  };
}

// ---------------------------------------------------------------------------------------------------------
// Score feed index + deterministic join.
export function scoreIndex(items = []) {
  const m = new Map();
  for (const it of items) if (it?.sport && it.source_id != null) m.set(`${it.sport}:${String(it.source_id)}`, it);
  return m;
}
export function joinScore(event, index) {
  const sport = event.sport;
  if (!sport) return { state: 'NOT_APPLICABLE', score: null };
  if (!ID_JOIN_SPORTS.has(sport)) return { state: 'UNMATCHED', score: null, reason: sport === 'ufc' ? 'Market lists bouts; the score feed lists cards. No deterministic bout crosswalk yet.' : 'No proven id crosswalk between this sport\'s market and score feed.' };
  const hit = index.get(`${sport}:${String(event.canonical_event_id)}`);
  return hit ? { state: 'LINKED', score: hit } : { state: 'NO_SCORE', score: null };
}

// ---------------------------------------------------------------------------------------------------------
// Event normalization + ranking. Primary view = actionable price discrepancy:
//   tier 0  comparable, aligned, gap > 0 (sorted by gap)      tier 1  comparable aligned, gap 0
//   tier 2  both quoted but not aligned / rule mismatch / single venue (fresh)
//   tier 3  stale, withdrawn, final, nothing priced
export function normalizeEvent(e, index = new Map()) {
  const contracts = (e.contracts || []).map(normalizeContract);
  const join = joinScore(e, index);
  const status = join.score?.status || null;
  const best = contracts.filter((c) => c.gap_pts != null).sort((a, b) => b.gap_pts - a.gap_pts)[0] || null;
  const anyPriced = contracts.some((c) => c.priced);
  const allStale = anyPriced && contracts.filter((c) => c.priced).every((c) => c.all_stale);
  const withdrawn = contracts.length > 0 && contracts.every((c) => c.badge === 'WITHDRAWN' || !c.priced);
  let tier;
  if (status === 'final' || !anyPriced || allStale || withdrawn) tier = 3;
  else if (best && best.gap_pts > 0) tier = 0;
  else if (best) tier = 1;
  else tier = 2;
  const badges = [...new Set(contracts.map((c) => c.badge))];
  return {
    key: `${e.sport || 'nonsports'}:${e.canonical_event_id}`, sport: e.sport || null, lane: e.lane || e.sport || 'nonsports',
    canonical_event_id: String(e.canonical_event_id), title: e.title || e.question || 'Market', start_at: e.start_at || e.close_time || null,
    destination: e.destination?.url || null, contracts, join, status, tier, best_gap: best?.gap_pts ?? null, best,
    badge: badges.includes('COMPARABLE') ? 'COMPARABLE' : badges.includes('RULE_MISMATCH') ? 'RULE_MISMATCH' : badges.includes('WITHDRAWN') ? 'WITHDRAWN' : 'SINGLE_VENUE',
    badge_note: contracts.some((c) => c.comparison) ? null : contracts.some((c) => c.note === 'NOT_ALIGNED') ? 'NOT_ALIGNED' : null,
    has_pbe: contracts.some((c) => c.pbe), active: anyPriced && status !== 'final' && !withdrawn,
    live: status === 'live', freshest_at: contracts.map((c) => c.freshest_at).filter(Boolean).sort().at(-1) || null
  };
}

export function rankEvents(events) {
  return [...events].sort((a, b) => a.tier - b.tier
    || (b.best_gap ?? -1) - (a.best_gap ?? -1)
    || String(a.start_at || '9').localeCompare(String(b.start_at || '9')));
}

export const VIEWS = {
  top: { label: 'TOP SPREADS', filter: (e) => e.active },
  live: { label: 'LIVE NOW', filter: (e) => e.live },
  pbe: { label: 'PBE CALLS', filter: (e) => e.has_pbe },
  rules: { label: 'RULE DIFFERENCES', filter: (e) => e.contracts.some((c) => c.badge === 'RULE_MISMATCH' || c.badge === 'WITHDRAWN' || c.comparison?.disclosure) },
  all: { label: 'ALL MARKETS', filter: () => true }
};

// ---------------------------------------------------------------------------------------------------------
// Movement over a window from STORED points (step semantics: a stored value holds until the next stored row).
// Requires an observation at or before (now − window); otherwise "not enough observations" (null), never 0.
export const WINDOWS = [{ key: '1m', ms: 60e3 }, { key: '5m', ms: 5 * 60e3 }, { key: '15m', ms: 15 * 60e3 }, { key: '60m', ms: 3600e3 }, { key: '24h', ms: 86400e3 }];
export function moveOver(points, windowMs, now = Date.now()) {
  const pts = (points || []).map((p) => ({ t: Date.parse(p.t), v: num(p.v) })).filter((p) => Number.isFinite(p.t) && p.v !== null).sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const from = now - windowMs;
  let base = null;
  for (const p of pts) { if (p.t <= from) base = p; else break; }
  if (!base) return null;
  const last = pts[pts.length - 1];
  return { delta_bp: last.v - base.v, from_v: base.v, to_v: last.v, from_t: new Date(base.t).toISOString(), to_t: new Date(last.t).toISOString(), n: pts.filter((p) => p.t >= base.t).length };
}
export function moves(points, now = Date.now()) {
  return Object.fromEntries(WINDOWS.map((w) => [w.key, moveOver(points, w.ms, now)]));
}
export const fmtMove = (m) => (m == null ? 'Not enough observations' : `${m.delta_bp > 0 ? '▲ +' : m.delta_bp < 0 ? '▼ −' : '■ '}${(Math.abs(m.delta_bp) / 100).toFixed(1)}¢`);

// ---------------------------------------------------------------------------------------------------------
// Screen state. Every failure has its own state; "empty" only when every source answered and there is nothing.
export function membershipState(status, body) {
  if (status === 0) return 'network_error';
  if (status === 401) return 'anonymous';
  if (status === 403) return 'forbidden';
  if (status === 503 || status >= 500) return 'unverified';
  const mm = body?.membership || {};
  if (mm.entitled === true && (mm.state === 'all_access' || mm.state === 'owner')) return 'entitled';
  if (mm.state === 'anonymous') return 'anonymous';
  if (mm.state === 'unverified') return 'unverified';
  return 'forbidden';
}

export const SCORE_DELAY_MS = 120e3;
export function scoreSourceState(src, now = Date.now()) {
  if (!src) return 'not_requested';
  if (src.state !== 'ok') return 'unavailable';
  if (src.fetched_at && now - Date.parse(src.fetched_at) > SCORE_DELAY_MS) return 'delayed';
  return 'ok';
}

// Returns banners (ordered, most severe first) + the board state for the requested scope.
export function screenNotices({ desk, deskStatus, live, liveStatus, scope, events, now = Date.now() }) {
  const n = [];
  if (deskStatus === 'loading') n.push({ level: 'info', code: 'loading', text: 'Loading market desk…' });
  else if (deskStatus === 401) n.push({ level: 'auth', code: 'auth_expired', text: 'Your session ended. Sign in again to load the comparison desk.' });
  else if (deskStatus === 403) n.push({ level: 'auth', code: 'forbidden', text: 'Compare is part of PropBetEdge All Access. This account does not include it.' });
  else if (deskStatus === 503) n.push({ level: 'error', code: 'access_check', text: 'We could not verify your membership right now. Nothing is shown until access is verified; retrying automatically.' });
  else if (deskStatus === 0) n.push({ level: 'error', code: 'network', text: 'Network error reaching Compare. Retrying automatically.' });
  for (const l of desk?.lanes || []) {
    const name = l.lane === 'nonsports' ? 'Prediction markets' : l.lane.toUpperCase();
    if (l.state === 'unavailable') n.push({ level: 'error', code: 'lane_unavailable', lane: l.lane, text: `${name} market feed unavailable (upstream ${l.upstream_status || l.error || 'error'}). Its markets are missing from this board until it recovers.` });
    else if (l.state === 'not_connected' && scope !== 'sports') n.push({ level: 'info', code: 'lane_not_connected', lane: l.lane, text: `${name} comparison lane is not connected yet. No Kalshi ↔ Polymarket desk exists for this sport.` });
    else if (l.capped && scope !== 'sports') n.push({ level: 'info', code: 'lane_capped', lane: l.lane, text: `${name}: showing the first ${desk.page_limit} events (upstream page limit; no further pages exist yet).` });
  }
  const ok = (desk?.lanes || []).some((l) => l.state === 'ok');
  if (ok && events?.length && !events.some((e) => e.badge === 'COMPARABLE')) {
    const liveN = (live?.items || []).filter((x) => x.status === 'live').length;
    n.push({ level: 'info', code: 'no_comparable', text: `${liveN ? `${liveN} game${liveN > 1 ? 's are' : ' is'} live, but no` : 'No'} market in this scope has an approved Kalshi ↔ Polymarket comparable contract right now. Single-venue and rule-mismatch markets are shown below with their own prices.` });
  }
  if (scope !== 'nonsports') {
    if (liveStatus === 0 || (liveStatus >= 500)) n.push({ level: 'warn', code: 'score_feed_down', text: 'Score feed unavailable. Markets are shown without live game state.' });
    for (const s of live?.sources || []) {
      const st = scoreSourceState(s, now);
      if (st === 'unavailable') n.push({ level: 'warn', code: 'score_source_down', sport: s.key, text: `${s.key.toUpperCase()} score feed unavailable (${s.error || 'error'}). ${s.key.toUpperCase()} markets show without game state.` });
      else if (st === 'delayed') n.push({ level: 'warn', code: 'score_delayed', sport: s.key, text: `${s.key.toUpperCase()} score feed delayed (last update ${ageText(s.fetched_at, now)}).` });
    }
  }
  return n;
}

// Board-level empty state, only when every requested source answered.
export function boardEmpty({ desk, viewKey, events, scope, liveItems = [] }) {
  if (!desk) return null;
  const okLanes = (desk.lanes || []).filter((l) => l.state === 'ok');
  if (!okLanes.length) {
    if ((desk.lanes || []).every((l) => l.state === 'not_connected')) return { code: 'not_connected', text: 'This comparison lane is not connected yet. No Kalshi ↔ Polymarket desk exists for this sport.' };
    return { code: 'upstream_error', failure: true, text: 'The market feed for this scope did not answer. This is a feed failure, not an empty market; retrying every 60 seconds.' };
  }
  if (events.length) return null;
  const live = liveItems.filter((x) => x.status === 'live').length;
  if (viewKey === 'live') return { code: 'no_live', text: live ? `${live} game${live > 1 ? 's are' : ' is'} live, but none has a deterministically linked market on this board.` : 'No games with linked markets are live right now.' };
  if (viewKey === 'pbe') return { code: 'no_pbe', text: 'No active PBE calls in this scope right now.' };
  if (viewKey === 'top') return { code: 'no_active', text: 'Every lane answered: no active markets in this scope right now.' };
  return { code: 'zero', text: 'Every lane answered with zero markets for this scope.' };
}
