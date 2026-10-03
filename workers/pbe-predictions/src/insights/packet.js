// Evidence packets for Prediction Intelligence stories. A packet is a read of immutable ledger rows bounded by the
// story's as-of time: public forecast snapshots (RESEARCH/VALIDATED/OFFICIAL only — SHADOW never loads), the market
// observations stored up to that time, the exact contract versions those forecasts were made against, and any stored
// resolution/score (which may arrive later and is shown as a dated update, never rewritten into the original story).
import { PUBLIC_STATES, CATEGORY_LABEL } from '../../../../src/engine/registry.js';

const pct = (p) => (p === null || p === undefined ? null : Math.round(Number(p) * 100));

export async function loadEventPacket(store, slug, asOf) {
  const [event] = await store.select('pred_events', { select: '*', slug: `eq.${slug}` }, { limit: 1 });
  if (!event) return null;
  const contractRows = await store.select('pred_contracts', { select: '*', event_id: `eq.${event.event_id}` });
  const ids = contractRows.map((c) => c.contract_id);
  if (!ids.length) return null;
  const forecasts = (await store.selectIn('pred_forecasts', { select: 'forecast_id,contract_id,model_id,model_version,model_state,probability,market_probability,confidence,captured_at,data_cutoff_at,features_sha256,provenance,explanation', captured_at: `lte.${asOf}` }, 'contract_id', ids))
    .filter((f) => PUBLIC_STATES.includes(f.model_state));
  const market = await store.selectIn('pred_venue_snapshots', { select: 'contract_id,captured_at,probability,bid,ask', captured_at: `lte.${asOf}` }, 'contract_id', ids);
  const visible = new Set(forecasts.map((f) => f.forecast_id));
  const resolutions = await store.selectIn('pred_resolutions', { select: '*' }, 'contract_id', ids);
  const designations = (await store.selectIn('pred_forecast_designations', { select: 'contract_id,designation,forecast_id,reference_time,designated_at' }, 'contract_id', ids)).filter((d) => visible.has(d.forecast_id));
  const scores = (await store.selectIn('pred_scores', { select: 'contract_id,forecast_id,designation,scoring_method,score,benchmark_score,outcome' }, 'contract_id', ids)).filter((s) => visible.has(s.forecast_id));

  // one outcome per venue market: the contract version in force at the as-of time
  const byMarket = new Map();
  for (const c of contractRows) {
    if (Date.parse(c.normalized_at) > Date.parse(asOf)) continue;
    const cur = byMarket.get(c.market_id);
    if (!cur || cur.normalized_at < c.normalized_at) byMarket.set(c.market_id, c);
  }
  const contractIdsByMarket = new Map();
  for (const c of contractRows) { if (!contractIdsByMarket.has(c.market_id)) contractIdsByMarket.set(c.market_id, new Set()); contractIdsByMarket.get(c.market_id).add(c.contract_id); }
  const outcomes = [...byMarket.values()].map((c) => {
    const cids = contractIdsByMarket.get(c.market_id);
    const fs = forecasts.filter((f) => cids.has(f.contract_id)).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const ms = market.filter((m) => cids.has(m.contract_id)).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    return {
      contract: c, market_id: c.market_id, label: c.outcome_label,
      threshold_low: c.threshold_low === null ? null : Number(c.threshold_low), threshold_high: c.threshold_high === null ? null : Number(c.threshold_high),
      snapshots: fs.map((f) => ({
        id: f.forecast_id, t: f.captured_at, pbe: pct(f.probability), pbe_raw: Number(f.explanation?.raw_probability ?? f.probability), market: pct(f.market_probability),
        model: `${f.model_id}@${f.model_version}`, model_id: f.model_id, version: f.model_version, state: f.model_state, confidence: f.confidence, cutoff: f.data_cutoff_at,
        sha: f.features_sha256, evidence: f.explanation?.evidence ?? [], provenance: f.provenance ?? [], tier: f.explanation?.model_tier ?? null,
        roles: designations.filter((d) => d.forecast_id === f.forecast_id).map((d) => d.designation),
      })),
      market_path: ms.map((m) => ({ t: m.captured_at, mid: pct(m.probability), bid: pct(m.bid), ask: pct(m.ask) })),
      resolution: resolutions.filter((r) => cids.has(r.contract_id)).sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)))[0] || null,
      scores: scores.filter((s) => cids.has(s.contract_id)),
    };
  }).sort((a, b) => ((a.threshold_low ?? a.threshold_high ?? 0) - (b.threshold_low ?? b.threshold_high ?? 0)) || String(a.market_id).localeCompare(String(b.market_id)));
  return {
    as_of: asOf,
    event: { id: event.event_id, slug: event.slug, title: event.canonical_question, category: event.category, category_label: CATEGORY_LABEL[event.category] || event.category, close_time: event.close_time, venue_event_id: event.venue_event_id, model_family: event.model_family },
    outcomes,
  };
}

// Evidence-contract helpers: a module may render only if these hold.
export const latest = (o) => o?.snapshots.at(-1) ?? null;
export const latestMarket = (o) => o?.market_path.at(-1) ?? null;
export const hasSnapshots = (o, n = 1) => Boolean(o && o.snapshots.length >= n);
export const twoSided = (m) => Boolean(m && m.bid !== null && m.ask !== null && m.ask - m.bid <= 10 && m.mid !== null);
export const evidenceValue = (snap, label) => snap?.evidence.find((e) => e.label === label)?.value ?? null;
export const resolved = (o) => Boolean(o?.resolution && (o.resolution.venue_result || o.resolution.official_outcome));
