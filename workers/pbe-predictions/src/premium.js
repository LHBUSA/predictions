// PropBetEdge Predictions access boundary (owner contract 2026-10-05). Predictions is a premium product included with
// PropBetEdge All Access ($29/month). There is NO free Predictions tier.
//   PUBLIC (cacheable, anyone): the product shell of an event — its title, category, venue, close time, outcome labels,
//     the exact resolution rules, the model family's public methodology (state, inputs, limitations) and the settled
//     resolution. No PBE probability, no market comparison, no evidence, no forecast history, no scores.
//   ALL ACCESS / OWNER (private, no-store): every PBE probability and market comparison, the desk and divergence
//     scanner, evidence ledger, forecast history, the complete market path, live event regions, CSV download.
// The public shell is built by WHITELIST (new record fields never leak by default). Premium data is never sent and
// hidden in the browser: anything not entitled gets 401/403/503 with no payload.

// prediction-decision-v1 is DRAFT until the owner freezes it: no public or member surface carries a non-official
// decision (admin routes only). Once official, the decision travels with the call on every surface.
export function withOfficialDecisionsOnly(o) {
  if (!o.call?.decision || o.call.decision.official) return o;
  const { decision, ...call } = o.call;
  return { ...o, call };
}

const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : null);
const EVENT_KEYS = ['event_id', 'slug', 'title', 'sub_title', 'category', 'category_label', 'state', 'lifecycle', 'close_time', 'venue', 'venue_event_id', 'series_title', 'kalshi_url', 'created_at', 'date_modified', 'kind'];
const CONTRACT_KEYS = ['resolution_authority', 'resolution_dataset', 'verification_dataset', 'measurement_definition', 'rounding_rule', 'exceptions', 'timezone', 'observation_start', 'observation_end', 'station_id', 'location', 'rules_primary_example', 'normalizer', 'normalization_status', 'status_reason'];
const MODEL_KEYS = ['id', 'name', 'state', 'inputs', 'limitations'];
const RESOLUTION_KEYS = ['venue_result', 'venue_value', 'settled_at', 'official_outcome', 'official_value', 'official_units', 'official_source', 'source_url', 'sources_agree'];

// The public event page / OG card source. Whitelisted fields only.
export function publicEventShell(rec) {
  return {
    generated_at: rec.generated_at,
    event: pick(rec.event, EVENT_KEYS),
    contract: pick(rec.contract, CONTRACT_KEYS),
    model: pick(rec.model, MODEL_KEYS),
    outcomes: rec.outcomes.map((o) => ({ label: o.label, status: o.status, reason: o.reason ?? null, resolution: pick(o.resolution, RESOLUTION_KEYS) })),
    modeled: rec.outcomes.some((o) => o.pbe_pct !== null && o.pbe_pct !== undefined),
    access: { tier: 'public', required: 'all_access' },
  };
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

// PUBLIC homepage preview of the desk (owner 2026-10-05: visitors see what is going on; PBE numbers are blurred).
// Built by whitelist from the full desk: what is tracked, when it closes, the venue's own public price and WHETHER a PBE
// model covers it. Never the PBE probability, divergence, confidence, evidence or history; the headline outcome is the
// one the market prices highest and rows are ordered by close time, so neither choice reveals where PBE disagrees.
export function deskPreview(full) {
  const events = full.events.map((e) => {
    const quoted = (e.outcomes || []).filter((o) => o.market_pct !== null && o.market_pct !== undefined).sort((a, b) => b.market_pct - a.market_pct)[0] || null;
    return {
      ...pick(e, ['slug', 'url', 'title', 'category', 'category_label', 'state', 'close_time', 'resolves_at', 'outcomes_total', 'outcomes_modeled', 'kalshi_url', 'updated_at']),
      headline: quoted ? { label: quoted.label, market_pct: quoted.market_pct, modeled: quoted.pbe_pct !== null && quoted.pbe_pct !== undefined } : null,
    };
  }).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time) || a.slug.localeCompare(b.slug));
  return { generated_at: full.generated_at, events, access: { tier: 'preview', required: 'all_access' } };
}

export const ALL_ACCESS_PRICE = '$29/month';
export const ALL_ACCESS_REQUIRED = Object.freeze({ error: 'all_access_required', message: `Predictions is included with PropBetEdge All Access · ${ALL_ACCESS_PRICE}.`, upgrade_url: 'https://propbetedge.ai/pro' });
export const ENTITLEMENT_UNAVAILABLE = Object.freeze({ error: 'entitlement_unavailable', message: 'Your membership could not be verified right now. Please retry shortly.', retry: true });
