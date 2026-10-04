// Public read API. Every number served is either a stored venue observation or a stored, versioned PBE forecast.
// Contracts without a public model are MARKET MONITORING (no PBE number). SHADOW forecasts are never served publicly.
import { FAMILIES, CATEGORY_LABEL, PUBLIC_STATES, MIN_RESOLVED_FOR_METRICS } from '../../../src/engine/registry.js';
import { buildEvidencePacket, driverSentence, driversFor } from '../../../src/engine/evidence.js';
import { decide, decisionInput } from '../../../src/engine/decision.js';
import { venueBlock, kalshiQuote, polymarketQuote, brier, logLoss, NO_OBSERVATION, semantics, divergence, freshness } from '../../../src/engine/venues.js';
import { polymarketForContracts, coverageFromTicks } from './venue-data.js';

// Per designation: PBE (stored score) vs Kalshi vs Polymarket at the SAME designated forecast timestamp. A venue
// is scored only when comparable and observed at or before that timestamp; otherwise its reason is recorded.
export function venueScores(rows, venues, outcome) {
  const byDes = new Map();
  for (const s of rows) { const g = byDes.get(s.designation) || { designation: s.designation, forecast_id: s.forecast_id }; g[s.scoring_method === 'brier' ? 'pbe_brier' : 'pbe_log_loss'] = Number(s.score); byDes.set(s.designation, g); }
  const venueScore = (v, fid) => {
    if (!v) return { status: 'VENUE_NOT_LISTED' };
    if (!v.comparable) return { status: 'NOT_COMPARABLE', semantic_class: v.semantic_class };
    const a = v.at_forecast.find((x) => x.forecast_id === fid);
    if (!a || a.benchmark === NO_OBSERVATION) return { status: NO_OBSERVATION };
    const bp = a.benchmark.mid_bp ?? null;
    if (bp === null) return { status: 'NO_TWO_SIDED_QUOTE' };
    return { status: 'SCORED', observed_at: a.benchmark.observed_at, mid_pct: a.benchmark.mid_pct, brier: brier(bp, outcome), log_loss: logLoss(bp, outcome) };
  };
  return [...byDes.values()].map((g) => ({ ...g, outcome, kalshi: venueScore(venues.kalshi, g.forecast_id), polymarket: venueScore(venues.polymarket, g.forecast_id) }));
}

const pct = (p) => (p === null || p === undefined ? null : Math.round(Number(p) * 100));
const isPublic = (f) => f && PUBLIC_STATES.includes(f.model_state);
const latestBy = (rows, key, time) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k) || m.get(k)[time] < r[time]) m.set(k, r); } return m; };
const ago = (now, ms) => new Date(Date.parse(now) - ms).toISOString();

// Largest-remainder rounding so a displayed distribution sums to exactly 100.
export function roundTo100(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return values.map(() => 0);
  const scaled = values.map((v) => (v / total) * 100);
  const floors = scaled.map(Math.floor);
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  const order = scaled.map((v, i) => [v - floors[i], i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (rest <= 0) break; floors[i] += 1; rest -= 1; }
  return floors;
}

export { distributionKindOf as distributionKind } from '../../../src/engine/distribution.js';
import { distributionKindOf as distributionKind } from '../../../src/engine/distribution.js';

// Live slate: events closing in the future (or within the last day), latest contract/forecast/market per outcome.
async function liveSlate(store, now) {
  const events = await store.select('pred_events', { select: 'event_id,slug,canonical_question,category,domain,event_family,lifecycle,model_state,model_family,close_time,venue_event_id,metadata,updated_at', close_time: `gte.${ago(now, 86400000)}` });
  if (!events.length) return { events: [], contracts: [], forecasts: new Map(), market: new Map() };
  const contracts = [...latestBy(await store.selectIn('pred_contracts', { select: 'contract_id,event_id,market_id,normalization_status,status_reason,event_type,station_id,location,comparator,threshold_low,threshold_high,units,outcome_label,observation_start,observation_end,close_time,detail,normalized_at' }, 'event_id', events.map((e) => e.event_id)), 'market_id', 'normalized_at').values()];
  const ids = contracts.map((c) => c.contract_id);
  const forecasts = (await store.selectIn('pred_forecasts', { select: 'forecast_id,contract_id,model_id,model_version,model_state,probability,market_probability,confidence,captured_at,data_cutoff_at,explanation,feature_snapshot_id', captured_at: `gte.${ago(now, 4 * 86400000)}` }, 'contract_id', ids)).filter(isPublic);
  const market = await store.selectIn('pred_venue_snapshots', { select: 'contract_id,probability,bid,ask,last_price,volume,market_status,lifecycle,captured_at,raw', captured_at: `gte.${ago(now, 75 * 60000)}` }, 'contract_id', ids);
  return { events, contracts, forecasts: latestBy(forecasts, 'contract_id', 'captured_at'), market: latestBy(market, 'contract_id', 'captured_at') };
}

function outcomeSummary(c, f, v) {
  const pbe = f ? pct(f.probability) : null;
  const mkt = v ? pct(v.probability) : null;
  return {
    contract_id: c.contract_id, market_id: c.market_id, label: c.outcome_label, status: c.normalization_status, reason: c.status_reason, event_type: c.event_type,
    pbe_pct: pbe, pbe_raw: f ? Number(f.explanation?.raw_probability ?? f.probability) : null, model: f ? `${f.model_id}@${f.model_version}` : null, model_state: f?.model_state ?? null,
    confidence: f?.confidence ?? null, published_at: f?.captured_at ?? null, data_cutoff_at: f?.data_cutoff_at ?? null,
    market_pct: mkt, bid_pct: v ? pct(v.bid) : null, ask_pct: v ? pct(v.ask) : null, market_status: v?.market_status ?? null, market_lifecycle: v?.lifecycle ?? null, market_observed_at: v?.captured_at ?? null,
    kalshi_url: v?.raw?.kalshi_url ?? null,
    divergence_pts: pbe !== null && mkt !== null ? pbe - mkt : null,
  };
}

export async function desk(store, { now = new Date().toISOString(), venues = false } = {}) {
  const s = await liveSlate(store, now);
  const out = [];
  for (const e of s.events) {
    const cs = s.contracts.filter((c) => c.event_id === e.event_id);
    const outcomes = cs.map((c) => outcomeSummary(c, s.forecasts.get(c.contract_id), s.market.get(c.contract_id))).filter((o) => o.market_lifecycle && !['CLOSED', 'SETTLED'].includes(o.market_lifecycle));
    if (!outcomes.length) continue;
    const modeled = outcomes.filter((o) => o.pbe_pct !== null);
    if (e.model_state === 'RESEARCH' && !modeled.length) continue; // modeled family, window already open: v1 publishes pre-window only
    const headline = [...modeled].filter((o) => o.divergence_pts !== null).sort((a, b) => Math.abs(b.divergence_pts) - Math.abs(a.divergence_pts))[0] || modeled[0] || outcomes[0];
    out.push({
      slug: e.slug, url: `/events/${e.slug}`, title: e.canonical_question, category: e.category, category_label: CATEGORY_LABEL[e.category] || e.category,
      state: modeled.length ? (modeled[0].model_state || 'RESEARCH') : 'MARKET_MONITORING', model_family: modeled.length ? e.model_family : null,
      close_time: e.close_time, kind: distributionKind(e, cs), outcomes_total: outcomes.length, outcomes_modeled: modeled.length,
      max_abs_divergence: modeled.reduce((m, o) => (o.divergence_pts === null ? m : Math.max(m, Math.abs(o.divergence_pts))), -1),
      headline, outcomes: outcomes.slice(0, 40).map((o) => ({ label: o.label, market_id: o.market_id, pbe_pct: o.pbe_pct, market_pct: o.market_pct, divergence_pts: o.divergence_pts })), updated_at: e.updated_at, kalshi_url: outcomes.find((o) => o.kalshi_url)?.kalshi_url ?? null,
    });
  }
  if (venues && out.length) await enrichDesk(store, s, out, now);
  return { generated_at: now, events: out };
}

// Desk rows (V4): strongest factual driver of the headline forecast (frozen feature snapshot) and BOTH venues
// independently for the headline outcome. Venue values never touch the PBE number or the ranking.
async function enrichDesk(store, s, out, now) {
  const heads = out.map((e) => e.headline).filter(Boolean);
  const fids = heads.map((h) => s.forecasts.get(h.contract_id)?.feature_snapshot_id).filter(Boolean);
  const snaps = fids.length ? await store.selectIn('pred_feature_snapshots', { select: 'snapshot_id,features' }, 'snapshot_id', fids, { chunkSize: 20 }).catch(() => []) : [];
  const snapById = new Map(snaps.map((x) => [x.snapshot_id, x.features]));
  const pm = await polymarketForContracts(store, [...new Set(heads.map((h) => h.market_id))], null, { since: ago(now, 7 * 86400000), coverage: false }).catch(() => ({ byTicker: new Map() }));
  for (const e of out) {
    const h = e.headline; if (!h) continue;
    const f = s.forecasts.get(h.contract_id);
    const d = f ? driversFor(f.model_id, snapById.get(f.feature_snapshot_id) || {})[0] : null;
    h.driver = d ? { label: d.label, display: d.display, unit: d.unit } : null;
    h.evidence_age_h = h.data_cutoff_at ? +((Date.parse(now) - Date.parse(h.data_cutoff_at)) / 3600000).toFixed(1) : null;
    const k = h.market_pct === null ? null : { mid_pct: h.market_pct, observed_at: h.market_observed_at, freshness: freshness(h.market_observed_at, now)?.label ?? null, url: h.kalshi_url, divergence: h.pbe_pct === null ? null : divergence(h.pbe_pct, h.market_pct * 100) };
    const v = pm.byTicker.get(h.market_id);
    const last = v?.rows.at(-1);
    const sem = v ? semantics(v.state, v.family) : null;
    const p = v && last && sem.display !== 'omit' ? { mid_pct: last.comparable_mid_bp === null ? null : Math.round(Number(last.comparable_mid_bp) / 100), observed_at: last.observed_at, freshness: freshness(last.observed_at, now)?.label ?? null, url: v.url, semantic_class: v.state, comparable: sem.comparable, divergence: sem.comparable && h.pbe_pct !== null && last.comparable_mid_bp !== null ? divergence(h.pbe_pct, Number(last.comparable_mid_bp)) : null } : null;
    h.venues = { kalshi: k, polymarket: p };
    h.venue_gap_pts = k?.mid_pct != null && p?.comparable && p.mid_pct !== null ? Math.abs(k.mid_pct - p.mid_pct) : null;
  }
}

export async function trackRecord(store) {
  const all = await store.select('pred_scores', { select: 'designation,scoring_method,score,benchmark_score,outcome,contract_id,forecast_id', designation: 'not.is.null' });
  const states = all.length ? await store.selectIn('pred_forecasts', { select: 'forecast_id,model_state' }, 'forecast_id', [...new Set(all.map((x) => x.forecast_id))], { chunkSize: 60 }) : [];
  const shadow = new Set(states.filter((f) => f.model_state === 'SHADOW').map((f) => f.forecast_id));
  const scores = all.filter((x) => !shadow.has(x.forecast_id));
  const groups = {};
  for (const s of scores) {
    const k = `${s.designation}|${s.scoring_method}`;
    const g = groups[k] || (groups[k] = { designation: s.designation, method: s.scoring_method, n: 0, pbe: 0, market_n: 0, market: 0 });
    g.n += 1; g.pbe += Number(s.score);
    if (s.benchmark_score !== null) { g.market_n += 1; g.market += Number(s.benchmark_score); }
  }
  return { resolved_contracts: new Set(scores.map((s) => s.contract_id)).size, min_for_claims: MIN_RESOLVED_FOR_METRICS, groups: Object.values(groups).map((g) => ({ designation: g.designation, method: g.method, n: g.n, pbe_mean: +(g.pbe / g.n).toFixed(4), market_n: g.market_n, market_mean: g.market_n ? +(g.market / g.market_n).toFixed(4) : null })) };
}

export async function summary(store, { now = new Date().toISOString() } = {}) {
  const d = await desk(store, { now });
  const outcomes = d.events.flatMap((e) => e.outcomes);
  const lastCycle = (await store.select('pred_events', { select: 'updated_at' }, { limit: 1, order: 'updated_at.desc' }))[0]?.updated_at ?? null;
  const tr = await trackRecord(store);
  const byCategory = {};
  for (const e of d.events) { const k = e.category; byCategory[k] ||= { label: e.category_label, events: 0, contracts: 0, modeled: 0 }; byCategory[k].events += 1; byCategory[k].contracts += e.outcomes_total; byCategory[k].modeled += e.outcomes_modeled; }
  return {
    generated_at: now, last_engine_cycle: lastCycle,
    live_events: d.events.length, live_contracts: outcomes.length, modeled_contracts: outcomes.filter((o) => o.pbe_pct !== null).length,
    monitoring_contracts: outcomes.filter((o) => o.pbe_pct === null).length, resolved_scored: tr.resolved_contracts,
    models_live: FAMILIES.filter((f) => PUBLIC_STATES.includes(f.state)).length, models_shadow: FAMILIES.filter((f) => f.state === 'SHADOW').length,
    by_category: byCategory,
  };
}

export async function calendar(store, { now = new Date().toISOString(), days = 21 } = {}) {
  const d = await desk(store, { now });
  const until = Date.parse(now) + days * 86400000;
  return { generated_at: now, events: d.events.filter((e) => Date.parse(e.close_time) >= Date.parse(now) && Date.parse(e.close_time) <= until).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time)).map((e) => ({ slug: e.slug, url: e.url, title: e.title, category: e.category, category_label: e.category_label, close_time: e.close_time, state: e.state, outcomes_total: e.outcomes_total })) };
}

export async function models(store, { now = new Date().toISOString() } = {}) {
  const f = await store.select('pred_forecasts', { select: 'forecast_id,model_id,model_state,captured_at,contract_id', captured_at: `gte.${ago(now, 60 * 86400000)}` });
  const scores = await store.select('pred_scores', { select: 'forecast_id,designation,scoring_method,score,benchmark_score,contract_id', designation: 'eq.FINAL_PRE_RESOLUTION' });
  const modelOf = new Map(f.map((x) => [x.forecast_id, x.model_id]));
  return {
    generated_at: now, min_resolved_for_metrics: MIN_RESOLVED_FOR_METRICS,
    families: FAMILIES.map((fam) => {
      const mine = f.filter((x) => x.model_id === fam.id);
      const sc = scores.filter((x) => modelOf.get(x.forecast_id) === fam.id);
      const resolved = new Set(sc.map((x) => x.contract_id)).size;
      const brier = sc.filter((x) => x.scoring_method === 'brier'); const ll = sc.filter((x) => x.scoring_method === 'log_loss');
      const showMetrics = fam.state !== 'SHADOW' && resolved >= MIN_RESOLVED_FOR_METRICS;
      return {
        id: fam.id, name: fam.name, category: fam.category, category_label: CATEGORY_LABEL[fam.category], state: fam.state, versions: fam.versions, inputs: fam.inputs, limitations: fam.limitations,
        contracts_tracked: new Set(mine.map((x) => x.contract_id)).size, live_forecasts: mine.length,
        first_live: mine.length ? mine.reduce((a, x) => (x.captured_at < a ? x.captured_at : a), mine[0].captured_at) : null,
        last_run: mine.length ? mine.reduce((a, x) => (x.captured_at > a ? x.captured_at : a), mine[0].captured_at) : null,
        resolved: fam.state === 'SHADOW' ? null : resolved,
        metrics: showMetrics ? { n: brier.length, brier: +(brier.reduce((a, x) => a + Number(x.score), 0) / brier.length).toFixed(4), log_loss: +(ll.reduce((a, x) => a + Number(x.score), 0) / ll.length).toFixed(4), market_brier: +(brier.reduce((a, x) => a + Number(x.benchmark_score ?? 0), 0) / brier.length).toFixed(4) } : null,
        calibration_state: fam.state === 'MONITORING' ? 'not modeled' : fam.state === 'SHADOW' ? 'scored privately' : resolved >= MIN_RESOLVED_FOR_METRICS ? 'measurable' : `insufficient sample (${resolved}/${MIN_RESOLVED_FOR_METRICS} resolved)`,
      };
    }),
  };
}

export async function eventRecord(store, slug, { now = new Date().toISOString(), includeShadow = false } = {}) {
  const [e] = await store.select('pred_events', { select: '*', slug: `eq.${slug}` }, { limit: 1 });
  if (!e) return null;
  const contracts = [...latestBy(await store.select('pred_contracts', { select: '*', event_id: `eq.${e.event_id}` }), 'market_id', 'normalized_at').values()]
    .sort((a, b) => (Number(a.threshold_low ?? a.threshold_high ?? 0) - Number(b.threshold_low ?? b.threshold_high ?? 0)) || String(a.market_id).localeCompare(String(b.market_id)));
  const ids = contracts.map((c) => c.contract_id);
  const forecasts = (await store.selectIn('pred_forecasts', { select: 'forecast_id,event_id,contract_id,market_id,model_id,model_version,model_state,probability,market_probability,market_snapshot_key,market_observed_at,divergence_points,confidence,captured_at,data_cutoff_at,feature_snapshot_id,features_sha256,provenance,explanation,metadata' }, 'contract_id', ids)).filter((f) => includeShadow || isPublic(f));
  const visible = new Set(forecasts.map((f) => f.forecast_id));
  // complete stored Kalshi path (benchmark only); the public view trims it to checkpoints (premium boundary)
  const market = await store.selectIn('pred_venue_snapshots', { select: 'contract_id,snapshot_key,captured_at,probability,bid,ask,last_price,volume,market_status,lifecycle,raw' }, 'contract_id', ids);
  const designations = (await store.selectIn('pred_forecast_designations', { select: 'contract_id,designation,forecast_id,reference_time,designated_at' }, 'contract_id', ids)).filter((d) => visible.has(d.forecast_id));
  const resolutions = await store.selectIn('pred_resolutions', { select: '*' }, 'contract_id', ids);
  const scores = (await store.selectIn('pred_scores', { select: 'contract_id,forecast_id,designation,scoring_method,score,benchmark_score,outcome,market_probability' }, 'contract_id', ids)).filter((s) => visible.has(s.forecast_id));
  const features = forecasts.length ? await store.selectIn('pred_feature_snapshots', { select: 'snapshot_id,features,cutoff_at,source_observation_keys' }, 'snapshot_id', forecasts.map((f) => f.feature_snapshot_id), { chunkSize: 20 }) : [];
  const featById = new Map(features.map((x) => [x.snapshot_id, x]));
  const pm = await polymarketForContracts(store, [...new Set(contracts.map((c) => c.market_id))], e.event_id);
  const pmCoverage = coverageFromTicks(pm.ticks);
  const famRow = FAMILIES.find((f) => f.id === e.model_family) || null;
  const exclusiveEvent = distributionKind(e, contracts) === 'exclusive';
  const latestPublic = new Map();
  for (const f of forecasts) { const cur = latestPublic.get(f.contract_id); if (!cur || cur.captured_at < f.captured_at) latestPublic.set(f.contract_id, f); }
  const modalP = Math.max(-1, ...[...latestPublic.values()].map((f) => Number(f.probability)));
  const outcomes = await Promise.all(contracts.map(async (c) => {
    const fs = forecasts.filter((f) => f.contract_id === c.contract_id).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const ms = market.filter((m) => m.contract_id === c.contract_id).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const lf = fs.at(-1) || null; const lm = ms.at(-1) || null;
    const res = resolutions.find((r) => r.contract_id === c.contract_id) || null;
    const roleOf = (f) => designations.filter((d) => d.forecast_id === f.forecast_id).map((d) => d.designation);
    // venue checkpoints are computed for the PUBLIC checkpoints only (designated snapshots + current)
    const checkpoints = fs.filter((f) => roleOf(f).length || f === lf).map((f) => ({ forecast_id: f.forecast_id, captured_at: f.captured_at, probability: f.probability, roles: roleOf(f) }));
    const resOutcome = res ? (String(res.venue_result).toLowerCase() === 'yes' ? 1 : String(res.venue_result).toLowerCase() === 'no' ? 0 : null) : null;
    const kalshi = venueBlock({ venue: 'kalshi', quotes: ms.map(kalshiQuote), state: 'DEFINING_VENUE', marketId: c.market_id, url: lm?.raw?.kalshi_url ?? ms.find((m) => m.raw?.kalshi_url)?.raw?.kalshi_url ?? null, rulesSha256: c.rules_sha256 ?? null, closeTime: c.close_time, forecasts: checkpoints, now, resolution: resOutcome === null ? null : { value_pct: resOutcome * 100, settled_at: res.venue_settled_at || res.resolved_at } });
    const pmv = pm.byTicker.get(c.market_id);
    const polymarket = pmv ? venueBlock({ venue: 'polymarket', quotes: pmv.rows.map(polymarketQuote), state: pmv.state, family: pmv.family, reasons: pmv.reasons, marketId: pmv.market_id, url: pmv.url, rulesSha256: pmv.rules_sha256, coverageFrom: pmv.coverage_from, coverageAt: pmCoverage, lastCheckedAt: pm.ticks.length ? new Date(pm.ticks.at(-1)).toISOString() : null, closeTime: c.close_time, forecasts: checkpoints, now }) : null;
    let call = null;
    if (lf) {
      const { packet, sha256 } = await buildEvidencePacket({ event: e, contract: c, forecast: lf, snapshot: featById.get(lf.feature_snapshot_id) || null, limitations: famRow?.limitations ?? [] });
      const decision = decide(decisionInput({ forecast: lf, contract: c, integrityOk: packet.integrity.ok, asOf: now, isModal: exclusiveEvent ? Number(lf.probability) >= modalP : null, exclusive: exclusiveEvent }));
      call = { forecast_id: lf.forecast_id, pbe_pct: pct(lf.probability), confidence: lf.confidence, model: `${lf.model_id}@${lf.model_version}`, model_state: lf.model_state, published_at: lf.captured_at, data_cutoff_at: lf.data_cutoff_at, evidence_sha256: sha256, evidence: packet, summary: driverSentence(packet), decision };
    }
    return {
      ...outcomeSummary(c, lf, lm),
      venues: { kalshi, polymarket },
      call,
      yes_condition: c.yes_condition, threshold_low: c.threshold_low, threshold_high: c.threshold_high, comparator: c.comparator,
      evidence: lf?.explanation?.evidence ?? [], provenance: lf?.provenance ?? [], data_cutoff_at: lf?.data_cutoff_at ?? null, tier: lf?.explanation?.model_tier ?? null,
      history: fs.map((f, i) => {
        const prev = fs[i - 1];
        const fa = featById.get(f.feature_snapshot_id)?.features || {}; const fb = prev ? featById.get(prev.feature_snapshot_id)?.features || {} : {};
        const changed = prev ? Object.keys(fa).filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]) && !/periods/.test(k)).map((k) => ({ feature: k, from: fb[k] ?? null, to: fa[k] })) : [];
        return { forecast_id: f.forecast_id, t: f.captured_at, pct: pct(f.probability), market_pct: pct(f.market_probability), model: `${f.model_id}@${f.model_version}`, state: f.model_state, confidence: f.confidence, cutoff: f.data_cutoff_at, sha: f.features_sha256, roles: designations.filter((d) => d.forecast_id === f.forecast_id).map((d) => d.designation), changed };
      }),
      market_path: ms.map((m) => ({ t: m.captured_at, pct: pct(m.probability), bid: pct(m.bid), ask: pct(m.ask) })),
      resolution: res ? { venue_result: res.venue_result, venue_value: res.venue_expiration_value, settled_at: res.venue_settled_at || res.resolved_at, official_outcome: res.official_outcome, official_value: res.official_value, official_units: res.official_units, official_source: res.official_source, source_url: res.source_url, sources_agree: res.sources_agree } : null,
      scores: scores.filter((s) => s.contract_id === c.contract_id).map((s) => ({ designation: s.designation, method: s.scoring_method, pbe: Number(s.score), market: s.benchmark_score === null ? null : Number(s.benchmark_score) })),
      // same contract, same outcome, same designated timestamp: PBE vs each venue's at-or-before observation
      venue_scores: resOutcome === null ? [] : venueScores(scores.filter((s) => s.contract_id === c.contract_id), { kalshi, polymarket }, resOutcome),
    };
  }));
  const kind = distributionKind(e, contracts);
  const modeled = outcomes.filter((o) => o.pbe_pct !== null);
  let distribution = null;
  if (kind === 'exclusive' && outcomes.length > 1 && modeled.length === outcomes.length) {
    const mRaw = outcomes.map((o) => o.market_pct);
    const mOk = mRaw.every((v) => v !== null);
    distribution = { kind, labels: outcomes.map((o) => o.label), pbe: roundTo100(outcomes.map((o) => o.pbe_raw)), market_raw: mRaw, market_raw_sum: mOk ? mRaw.reduce((a, b) => a + b, 0) : null, market_normalized: mOk ? roundTo100(mRaw) : null,
      note: 'PBE distribution = the stored per-outcome probabilities normalized to 100% (individual snapshots differ only by rounding and bounds). Market = raw contract mids from independent order books; the normalized market distribution rescales them to 100%.' };
  } else if (kind === 'threshold') {
    distribution = { kind, labels: outcomes.map((o) => o.label), pbe: outcomes.map((o) => o.pbe_pct), market_raw: outcomes.map((o) => o.market_pct), note: 'Each threshold is its own nested contract (not mutually exclusive): the probability that the published path crosses that level.' };
  }
  const common = contracts.find((c) => c.normalization_status === 'NORMALIZED') || contracts[0];
  const fam = FAMILIES.find((f) => f.id === e.model_family) || null;
  const anyPublic = modeled.length > 0;
  const lastF = forecasts.reduce((a, f) => (f.captured_at > a ? f.captured_at : a), '');
  const lastM = market.reduce((a, m) => (m.captured_at > a ? m.captured_at : a), '');
  return {
    generated_at: now,
    event: {
      event_id: e.event_id, slug: e.slug, title: e.canonical_question, sub_title: e.metadata?.sub_title ?? null, category: e.category, category_label: CATEGORY_LABEL[e.category] || e.category,
      state: anyPublic ? (modeled[0].model_state || 'RESEARCH') : 'MARKET_MONITORING', model_family: anyPublic ? e.model_family : null, lifecycle: e.lifecycle, close_time: e.close_time,
      // `venue` / `kalshi_url` kept for existing consumers (Kalshi = the venue whose contract PBE models); new
      // consumers read `venues_available` + per-outcome `venues.kalshi` / `venues.polymarket`.
      venue: 'Kalshi', venue_event_id: e.venue_event_id, series_title: e.metadata?.series_title ?? null, kalshi_url: outcomes.find((o) => o.kalshi_url)?.kalshi_url ?? null,
      venues_available: ['kalshi', ...(outcomes.some((o) => o.venues.polymarket) ? ['polymarket'] : [])],
      venue_urls: { kalshi: outcomes.find((o) => o.kalshi_url)?.kalshi_url ?? null, polymarket: outcomes.find((o) => o.venues.polymarket?.url)?.venues.polymarket.url ?? pm.related[0]?.url ?? null },
      related_venue_markets: pm.related,
      created_at: e.created_at, date_modified: [lastF, lastM, e.updated_at].filter(Boolean).sort().at(-1) || e.updated_at, latest_forecast_at: lastF || null, latest_market_at: lastM || null,
      fail_closed: e.metadata?.fail_closed ?? [], kind,
    },
    model: anyPublic && fam ? { id: fam.id, name: fam.name, state: fam.state, inputs: fam.inputs, limitations: fam.limitations, versions: [...new Set(forecasts.map((f) => f.model_version))] } : null,
    contract: common ? {
      resolution_authority: common.resolution_authority, resolution_dataset: common.resolution_dataset, verification_dataset: common.verification_dataset, measurement_definition: common.measurement_definition,
      rounding_rule: common.rounding_rule, exceptions: common.exceptions, timezone: common.timezone, observation_start: common.observation_start, observation_end: common.observation_end, station_id: common.station_id, location: common.location,
      rules_primary_example: common.rules_primary, rules_secondary: common.rules_secondary, normalizer: common.normalizer_version, normalization_status: common.normalization_status, status_reason: common.status_reason,
    } : null,
    distribution, outcomes,
  };
}

export async function contractToSlug(store, contractId) {
  const [c] = await store.select('pred_contracts', { select: 'event_id,market_id', contract_id: `eq.${contractId}` }, { limit: 1 });
  if (!c) return null;
  const [e] = await store.select('pred_events', { select: 'slug', event_id: `eq.${c.event_id}` }, { limit: 1 });
  return e?.slug ? { slug: e.slug, market_id: c.market_id } : null;
}

export async function contractRecord(store, contractId, { includeShadow = false } = {}) {
  const ref = await contractToSlug(store, contractId);
  if (!ref) return null;
  const rec = await eventRecord(store, ref.slug, { includeShadow });
  return rec ? { ...rec, outcomes: rec.outcomes.filter((o) => o.contract_id === contractId || o.market_id === ref.market_id) } : null;
}

export async function sitemapEntries(store, { now = new Date().toISOString() } = {}) {
  return store.select('pred_events', { select: 'slug,updated_at,close_time', close_time: `gte.${ago(now, 45 * 86400000)}`, slug: 'not.is.null' });
}

export async function queue(store, { now = new Date().toISOString() } = {}) {
  const rows = await store.select('pred_contracts', { select: 'market_id,domain,normalization_status,status_reason,event_type,normalized_at,detail', normalized_at: `gte.${ago(now, 3 * 86400000)}` });
  const current = latestBy(rows, 'market_id', 'normalized_at');
  const counts = {}; const holds = [];
  for (const c of current.values()) {
    const k = `${c.detail?.category || c.domain}:${c.normalization_status}${c.status_reason ? `:${c.status_reason}` : ''}`;
    counts[k] = (counts[k] || 0) + 1;
    if (c.normalization_status !== 'NORMALIZED') holds.push({ market_id: c.market_id, status: c.normalization_status, reason: c.status_reason });
  }
  return { generated_at: now, counts, fail_closed: holds.slice(0, 300) };
}
