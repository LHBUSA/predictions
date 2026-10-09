// Homepage overview data: never the 60-event desk. (Issue #50 + owner P0 2026-10-09.)
//
// Member (All Access, gated route) — "largest model-vs-market gaps" may only be claimed for COMPARABLE events:
//   * headline PBE probability finite and within 0..100,
//   * headline market price finite and within 0..100 (the Kalshi quote of the SAME contract the forecast is for),
//   * divergence_pts finite and exactly PBE - market on that contract,
//   * the Kalshi venue comparison exists (venues.kalshi.divergence) and the quote is not stale.
// Ranked by |divergence| among eligible events only. If fewer than three qualify, the remaining slots are WATCH cards:
// modeled events without a comparable quote, labelled as such (never counted as a gap). Events pass through unchanged
// (same fields and semantics as /v1/desk). Every payload names its `audience` so a client can never render a preview
// payload as member data.
// Public preview: built ONLY from deskPreview() output (prices, close times, model coverage — never a PBE number).
export const FEATURED_N = 3;
const pctOk = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

export function comparableHeadline(e) {
  const h = e?.headline; const k = h?.venues?.kalshi;
  return !!(h && pctOk(h.pbe_pct) && pctOk(h.market_pct) && typeof h.divergence_pts === 'number' && Number.isFinite(h.divergence_pts)
    && h.divergence_pts === h.pbe_pct - h.market_pct && k && k.divergence && k.freshness !== 'stale');
}

export function featuredForMember(desk) {
  const all = desk?.events || [];
  const eligible = all.filter(comparableHeadline)
    .sort((a, b) => Math.abs(b.headline.divergence_pts) - Math.abs(a.headline.divergence_pts) || Date.parse(a.close_time) - Date.parse(b.close_time));
  const top = eligible.slice(0, FEATURED_N);
  const watch = all.filter((e) => !comparableHeadline(e) && pctOk(e.headline?.pbe_pct))
    .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))
    .slice(0, FEATURED_N - top.length);
  return {
    audience: 'member', generated_at: desk?.generated_at ?? null, basis: 'largest_comparable_divergence', comparable_count: eligible.length,
    events: top, watch, // watch = modeled, no comparable quote right now: shown as "watch", never as a gap
  };
}

export function featuredForPreview(preview) {
  const events = (preview?.events || []).filter((e) => e.outcomes_modeled > 0 && e.headline?.market_pct != null);
  events.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  return { audience: 'preview', generated_at: preview?.generated_at ?? null, events: events.slice(0, FEATURED_N), basis: 'closing_soonest_modeled' };
}

// Global Intelligence Pulse (public): per category, how many live events / modeled events, and ONE live observation —
// the soonest-closing event that has a market price (market favorite + price; PBE coverage as a yes/no only).
export const PULSE_CATEGORIES = ['WEATHER', 'RATES', 'MACRO'];
export function pulseFromPreview(preview) {
  const ev = preview?.events || [];
  const cats = PULSE_CATEGORIES.map((key) => {
    const list = ev.filter((e) => e.category === key);
    const priced = list.filter((e) => e.headline?.market_pct != null).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    const e = priced[0] || null;
    return {
      key, label: list[0]?.category_label || key[0] + key.slice(1).toLowerCase(), events: list.length, modeled_events: list.filter((x) => x.outcomes_modeled > 0).length,
      observation: e && { title: e.title, url: e.url, state: e.state, close_time: e.close_time, favorite: e.headline.label ?? null, market_pct: e.headline.market_pct, modeled: e.outcomes_modeled > 0 },
    };
  });
  return { generated_at: preview?.generated_at ?? null, categories: cats };
}

// Latest Insights headline for the homepage (title, link, date only). Read lazily by the page, edge-cached by the route.
export function latestInsight(items) {
  const i = (items || [])[0];
  return i ? { title: i.story.link_title || i.built?.title || null, url: `/insights/${i.story.slug}`, published_at: i.story.published_at, family: i.story.family_label || null } : null;
}
