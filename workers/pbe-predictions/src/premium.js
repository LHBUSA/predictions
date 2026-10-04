// Free / All Access boundary for event records.
//   PUBLIC (free, cacheable): current PBE + market, distribution, evidence, exact rules, model, the designated
//     scoring checkpoints (FIRST_PUBLISHED, T_MINUS_24H, FINAL_PRE_RESOLUTION) and the current snapshot, resolution,
//     scores — everything needed to audit the public prediction.
//   ALL ACCESS (private, no-store): every intermediate snapshot, the complete market path, the changed-input ledger,
//     CSV download, the full desk scanner.
// Public views are produced by REMOVING data on the server; premium data is never sent and hidden in the browser.

export const FREE_DESK_LIMIT = 12;

// prediction-decision-v1 is DRAFT until the owner freezes it: no public or member surface carries a non-official
// decision (admin routes only). Once official, the decision travels with the call on every surface.
export function withOfficialDecisionsOnly(o) {
  if (!o.call?.decision || o.call.decision.official) return o;
  const { decision, ...call } = o.call;
  return { ...o, call };
}

// Venue paths are archive depth (All Access); the public venue block keeps every checkpoint (first observed,
// at each public PBE checkpoint, final pre-close, resolution, current) and the stored path length.
const trimVenue = (v) => (v ? { ...v, path: [] } : v);

export function publicEventView(rec) {
  let snapshots = 0; let marketObs = 0;
  const outcomes = rec.outcomes.map((o) => {
    snapshots += o.history.length; marketObs += o.market_path.length + (o.venues?.polymarket?.path_n ?? 0);
    const latestId = o.history.at(-1)?.forecast_id;
    const history = o.history.filter((h) => h.roles.length || h.forecast_id === latestId).map(({ changed, sha, ...h }) => ({ ...h, checkpoint: true }));
    const lastMarket = o.market_path.filter((m) => m.pct !== null).at(-1);
    const venues = o.venues ? { kalshi: trimVenue(o.venues.kalshi), polymarket: trimVenue(o.venues.polymarket) } : o.venues;
    return withOfficialDecisionsOnly({ ...o, history, market_path: lastMarket ? [lastMarket] : [], venues });
  });
  return { ...rec, outcomes, access: { tier: 'free', archive: { snapshots, market_observations: marketObs, outcomes: rec.outcomes.length } } };
}

export function premiumEventView(rec) {
  return { ...rec, outcomes: rec.outcomes.map(withOfficialDecisionsOnly), access: { tier: 'all_access' } };
}

export function eventCsv(rec) {
  const q = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [['record', 'outcome', 'market_id', 'forecast_id', 'time_utc', 'model', 'pbe_pct', 'market_pct', 'data_cutoff_utc', 'scoring_roles'].join(',')];
  for (const o of rec.outcomes) {
    for (const h of o.history) rows.push(['forecast', o.label, o.market_id, h.forecast_id, h.t, h.model, h.pct, h.market_pct, h.cutoff, h.roles.join(' ')].map(q).join(','));
    for (const m of o.market_path) rows.push(['market', o.label, o.market_id, '', m.t, 'kalshi_mid', '', m.pct, '', ''].map(q).join(','));
  }
  return `${rows.join('\n')}\n`;
}

export function publicDesk(full) {
  const rank = (e) => (e.headline?.pbe_pct !== null && e.max_abs_divergence >= 0 ? 1000 + e.max_abs_divergence : 0);
  const events = [...full.events].sort((a, b) => rank(b) - rank(a)).slice(0, FREE_DESK_LIMIT);
  return { ...full, events, access: { tier: 'free', shown: events.length, total_events: full.events.length, total_contracts: full.events.reduce((a, e) => a + e.outcomes_total, 0) } };
}

export const ALL_ACCESS_REQUIRED = Object.freeze({ error: 'all_access_required', message: 'Included with PropBetEdge All Access — 10 sports + PropBetEdge Predictions · $29/month.', upgrade_url: 'https://propbetedge.ai/pro' });
