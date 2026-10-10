// All Non-Sports Markets explorer (#79) — pure helpers (no DOM, no network). Imported by explorer.js in the browser and by
// test/all-markets.test.js in Node. Contract: market-catalog/1 (LHBUSA/propbetedge-workers#37, docs/catalog/CONTRACT.md).
export const VENUES = Object.freeze(['all', 'kalshi', 'polymarket']);
export const VENUE_LABEL = Object.freeze({ all: 'All venues', kalshi: 'Kalshi', polymarket: 'Polymarket' });
export const CATEGORIES = Object.freeze(['weather', 'politics', 'economics', 'crypto', 'commodities', 'business', 'space-tech', 'geopolitics', 'culture', 'science', 'health', 'other']);
export const CATEGORY_LABEL = Object.freeze({ weather: 'Weather', politics: 'Politics', economics: 'Economics', crypto: 'Crypto', commodities: 'Commodities', business: 'Business',
  'space-tech': 'Space & Tech', geopolitics: 'Geopolitics', culture: 'Culture', science: 'Science', health: 'Health', other: 'Other' });
export const SORTS = Object.freeze([['closing', 'Closing soonest'], ['volume24h', '24h volume'], ['newest', 'Newest'], ['activity', 'Most active'], ['price_change', 'Biggest 24h move']]);
export const STATUSES = Object.freeze([['open', 'Open'], ['closing', 'Closing within 24h']]);
export const PAGE = 50;

// ---------- URL state (shareable, back/forward-safe) ----------
export function stateFromSearch(search) {
  const q = new URLSearchParams(search || '');
  const pick = (k, allowed, d) => (allowed.includes(q.get(k)) ? q.get(k) : d);
  return { venue: pick('venue', VENUES, 'all'), category: pick('category', CATEGORIES, null), status: pick('status', STATUSES.map((s) => s[0]), 'open'),
    sort: pick('sort', SORTS.map((s) => s[0]), 'closing'), search: (q.get('q') || '').trim().slice(0, 120) };
}
export function searchFromState(s) {
  const q = new URLSearchParams();
  if (s.venue !== 'all') q.set('venue', s.venue);
  if (s.category) q.set('category', s.category);
  if (s.status !== 'open') q.set('status', s.status);
  if (s.sort !== 'closing') q.set('sort', s.sort);
  if (s.search) q.set('q', s.search);
  const out = q.toString();
  return out ? `?${out}` : '';
}
// The API query for one page (the backend owns filtering, sorting, counts and cursors; the browser never calls a venue).
export function apiQuery(s, cursor = null, limit = PAGE) {
  const q = new URLSearchParams({ venue: s.venue, status: s.status, sort: s.sort, limit: String(limit) });
  if (s.category) q.set('category', s.category);
  if (s.search) q.set('search', s.search);
  if (cursor) q.set('cursor', cursor);
  return `/api/market-catalog?${q}`;
}

// ---------- coverage honesty ----------
// A venue is shown as complete ONLY when the backend says state COMPLETE and coverage.complete. The ALL view is "all"
// only when every displayed venue is complete; otherwise the page title and banner say PARTIAL.
export function coverage(venues, selected = 'all') {
  const names = selected === 'all' ? ['kalshi', 'polymarket'] : [selected];
  const rows = names.map((n) => {
    const v = venues?.[n];
    const state = !v ? 'UNAVAILABLE' : v.display === false ? 'DISABLED' : v.state || 'UNAVAILABLE';
    return { venue: n, label: VENUE_LABEL[n], state, complete: state === 'COMPLETE' && v?.coverage?.complete === true,
      contributes: state === 'COMPLETE' || state === 'PARTIAL' || state === 'DEGRADED',
      indexed_markets: v?.indexed_markets ?? null, indexed_events: v?.indexed_events ?? null, last_full_sync_at: v?.last_full_sync_at ?? null,
      last_quote_sync_at: v?.last_quote_sync_at ?? null, sweep: v?.sweep ?? null, excluded: v?.coverage?.excluded ?? null, error: v?.error ?? null };
  });
  const complete = rows.every((r) => r.complete);
  return { complete, rows, label: complete ? (selected === 'all' ? 'ALL NON-SPORTS MARKETS' : `ALL ${VENUE_LABEL[selected].toUpperCase()} NON-SPORTS MARKETS`) : 'PARTIAL CATALOG' };
}
export function stateText(r) {
  switch (r.state) {
    case 'COMPLETE': return 'Complete index';
    case 'BUILDING': return r.sweep?.in_progress ? `Building first index · ${r.sweep.phase || 'sweep'} · ${r.sweep.pages_done ?? 0} pages` : 'Building first index';
    case 'PARTIAL': return 'Partial index';
    case 'DEGRADED': return 'Source degraded · showing last good index';
    case 'DISABLED': return 'Paused · display disabled';
    default: return 'Unavailable';
  }
}

// ---------- formatting ----------
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
export function pct(p, dp = 0) { if (!fin(p)) return '—'; const v = p * 100; return `${v < 1 && v > 0 ? '<1' : v > 99 && v < 100 ? '>99' : v.toFixed(dp)}%`; }
export function signedPts(d) { if (!fin(d) || d === 0) return d === 0 ? '0 pts' : '—'; const v = Math.round(d * 1000) / 10; return `${v > 0 ? '+' : '−'}${Math.abs(v)} pts`; }
export function compact(n) {
  if (!fin(n)) return '—';
  const a = Math.abs(n); const f = (v, u) => `${(Math.round(v * 10) / 10).toString().replace(/\.0$/, '')}${u}`;
  return a >= 1e9 ? f(n / 1e9, 'B') : a >= 1e6 ? f(n / 1e6, 'M') : a >= 1e3 ? f(n / 1e3, 'K') : String(Math.round(n));
}
export function ago(iso, nowMs = Date.now()) {
  const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
export function closesIn(iso, nowMs = Date.now()) {
  const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return null;
  const s = Math.round((t - nowMs) / 1000);
  if (s <= 0) return 'closed';
  return s < 3600 ? `closes in ${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `closes in ${Math.round(s / 3600)} h` : `closes in ${Math.round(s / 86400)} d`;
}
// The price line for one market, exactly as the venue supplied it (no YES/NO or multi-outcome conversion).
export function priceView(q) {
  if (!q) return { kind: 'none', text: 'No price in the listing' };
  if (Array.isArray(q.outcomes) && q.outcomes.length) return { kind: 'outcomes', items: q.outcomes.slice(0, 4).map((o) => ({ label: o.label, text: pct(o.price) })), more: Math.max(0, q.outcomes.length - 4) };
  if (fin(q.last)) return { kind: 'yes', text: pct(q.last), detail: fin(q.yes_bid) && fin(q.yes_ask) ? `bid ${pct(q.yes_bid)} · ask ${pct(q.yes_ask)}` : null };
  if (fin(q.yes_bid) || fin(q.yes_ask)) return { kind: 'yes', text: fin(q.yes_bid) && fin(q.yes_ask) ? `${pct(q.yes_bid)}–${pct(q.yes_ask)}` : pct(fin(q.yes_bid) ? q.yes_bid : q.yes_ask), detail: 'bid–ask' };
  return { kind: 'none', text: 'No price in the listing' };
}
export function freshness(q, nowMs = Date.now()) {
  if (!q?.observed_at) return null;
  return `${q.tier === 'hot' ? 'refreshed' : 'as of last sweep'} ${ago(q.observed_at, nowMs)}`;
}
// Merge a later page into the list without duplicates (stable by id; a row already shown keeps its position).
export function mergeRows(existing, incoming) {
  const seen = new Set(existing.map((r) => r.id));
  return [...existing, ...incoming.filter((r) => !seen.has(r.id))];
}
export const venueLink = (m) => (m && /^https:\/\/(www\.)?(kalshi\.com|polymarket\.com)\//.test(m.url || '') ? m.url : null);
