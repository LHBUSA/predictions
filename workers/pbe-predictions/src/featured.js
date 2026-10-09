// Homepage overview: exactly three featured events, so the landing page never downloads the 60-event desk.
// Member (All Access, gated route): the same rule the homepage always used — the three largest model-vs-market
// divergences among events whose headline carries both a PBE probability and a market price. Events are passed through
// unchanged (same fields and semantics as /v1/desk, including per-venue comparability).
// Public preview: built ONLY from deskPreview() output (prices, close times, model coverage — never a PBE number):
// the three soonest-closing modeled events that have a market price.
export const FEATURED_N = 3;

export function featuredForMember(desk) {
  const events = (desk?.events || []).filter((e) => e.headline && e.headline.pbe_pct != null && e.headline.divergence_pts != null);
  events.sort((a, b) => Math.abs(b.headline.divergence_pts) - Math.abs(a.headline.divergence_pts) || Date.parse(a.close_time) - Date.parse(b.close_time));
  return { generated_at: desk?.generated_at ?? null, events: events.slice(0, FEATURED_N), basis: 'largest_divergence' };
}

export function featuredForPreview(preview) {
  const events = (preview?.events || []).filter((e) => e.outcomes_modeled > 0 && e.headline?.market_pct != null);
  events.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  return { generated_at: preview?.generated_at ?? null, events: events.slice(0, FEATURED_N), basis: 'closing_soonest_modeled' };
}
