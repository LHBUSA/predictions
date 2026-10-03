// Public read API. Every number served is either a stored venue observation or a stored, versioned PBE
// forecast; nothing is computed for display that is not in the ledger. Contracts without a model are
// returned as MARKET MONITORING with no PBE probability. SHADOW forecasts are stored but never served publicly.

const pct = (p) => (p === null || p === undefined ? null : Math.round(Number(p) * 100));

function latestBy(rows, key, time) {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k) || m.get(k)[time] < r[time]) m.set(k, r); }
  return m;
}

const inList = (ids) => `in.(${ids.map((i) => `"${String(i).replace(/"/g, '\\"')}"`).join(',')})`;

async function chunked(store, table, select, column, ids, extra = {}) {
  const out = [];
  for (let i = 0; i < ids.length; i += 80) out.push(...await store.select(table, { select, [column]: inList(ids.slice(i, i + 80)), ...extra }, { limit: 5000 }));
  return out;
}

export async function board(store, { domain = null, now = new Date().toISOString(), horizonDays = 3 } = {}) {
  const since = new Date(Date.parse(now) - horizonDays * 86400000).toISOString();
  const q = { select: 'event_id,canonical_question,domain,event_family,lifecycle,model_state,model_family,close_time,venue_event_id,metadata', close_time: `gte.${since}` };
  if (domain) q.domain = `eq.${domain}`;
  const events = await store.select('pred_events', q, { order: 'close_time.asc', limit: 500 });
  if (!events.length) return { generated_at: now, events: [] };
  const contracts = await chunked(store, 'pred_contracts', 'contract_id,event_id,market_id,normalization_status,status_reason,event_type,station_id,location,comparator,threshold_low,threshold_high,units,outcome_label,observation_start,observation_end,timezone,resolution_authority,verification_dataset,yes_condition,normalized_at', 'event_id', events.map((e) => e.event_id));
  const current = latestBy(contracts, 'market_id', 'normalized_at');
  const ids = [...current.values()].map((c) => c.contract_id);
  const forecasts = (ids.length ? await chunked(store, 'pred_forecasts', 'forecast_id,contract_id,model_id,model_version,model_state,probability,market_probability,divergence_points,confidence,captured_at,data_cutoff_at', 'contract_id', ids) : []).filter((f) => f.model_state !== 'SHADOW');
  const venue = ids.length ? await chunked(store, 'pred_venue_snapshots', 'contract_id,market_id,probability,bid,ask,last_price,volume,open_interest,market_status,lifecycle,captured_at,raw', 'contract_id', ids, { captured_at: `gte.${since}` }) : [];
  const lastF = latestBy(forecasts, 'contract_id', 'captured_at');
  const lastV = latestBy(venue, 'contract_id', 'captured_at');
  return {
    generated_at: now,
    events: events.map((e) => ({
      ...e,
      ...(e.model_state === 'SHADOW' ? { model_state: 'MARKET_MONITORING', model_family: null } : {}),
      kalshi_url: [...lastV.values()].find((v) => v.raw && [...current.values()].some((c) => c.event_id === e.event_id && c.contract_id === v.contract_id))?.raw?.kalshi_url ?? null,
      contracts: [...current.values()].filter((c) => c.event_id === e.event_id).map((c) => {
        const f = lastF.get(c.contract_id) || null;
        const v = lastV.get(c.contract_id) || null;
        return {
          contract_id: c.contract_id, market_id: c.market_id, label: c.outcome_label, status: c.normalization_status, status_reason: c.status_reason,
          event_type: c.event_type, station: c.station_id, station_name: c.location?.name ?? null, window: c.observation_start ? { start: c.observation_start, end: c.observation_end, timezone: c.timezone } : null,
          yes_condition: c.yes_condition, resolution_authority: c.resolution_authority,
          mode: f ? 'MODELED' : 'MARKET_MONITORING',
          pbe: f ? { probability_pct: pct(f.probability), model: `${f.model_id}@${f.model_version}`, model_state: f.model_state, confidence: f.confidence, published_at: f.captured_at, market_at_publication_pct: pct(f.market_probability), divergence_at_publication_pts: f.divergence_points === null ? null : Number(f.divergence_points) } : null,
          market: v ? { probability_pct: pct(v.probability), bid_pct: pct(v.bid), ask_pct: pct(v.ask), last_pct: pct(v.last_price), volume: v.volume, status: v.market_status, lifecycle: v.lifecycle, observed_at: v.captured_at, kalshi_url: v.raw?.kalshi_url ?? null } : null,
          divergence_pts: f && v && v.probability !== null ? pct(f.probability) - pct(v.probability) : null,
        };
      }),
    })),
  };
}

export function divergences(boardDoc, { limit = 25 } = {}) {
  const rows = [];
  for (const e of boardDoc.events) for (const c of e.contracts) if (c.divergence_pts !== null && c.market?.lifecycle !== 'CLOSED' && c.market?.lifecycle !== 'SETTLED') rows.push({ event_id: e.event_id, question: e.canonical_question, ...c });
  rows.sort((a, b) => Math.abs(b.divergence_pts) - Math.abs(a.divergence_pts));
  return rows.slice(0, limit);
}

export async function contractRecord(store, contractId, { includeShadow = false } = {}) {
  const [c] = await store.select('pred_contracts', { select: '*', contract_id: `eq.${contractId}` });
  if (!c) return null;
  const [rawEvent] = await store.select('pred_events', { select: '*', event_id: `eq.${c.event_id}` });
  const event = rawEvent && rawEvent.model_state === 'SHADOW' && !includeShadow ? { ...rawEvent, model_state: 'MARKET_MONITORING', model_family: null } : rawEvent;
  const forecasts = (await store.select('pred_forecasts', { select: 'forecast_id,record_id,model_id,model_version,model_state,probability,market_probability,divergence_points,confidence,captured_at,data_cutoff_at,feature_snapshot_id,features_sha256,provenance,explanation,metadata,revision_of,revision_reason', contract_id: `eq.${contractId}` }, { order: 'captured_at.asc', limit: 1000 })).filter((f) => includeShadow || f.model_state !== 'SHADOW');
  const visible = new Set(forecasts.map((f) => f.forecast_id));
  const features = forecasts.length ? await chunked(store, 'pred_feature_snapshots', 'snapshot_id,cutoff_at,features,source_observation_keys,quality', 'snapshot_id', forecasts.map((f) => f.feature_snapshot_id)) : [];
  const market = await store.select('pred_venue_snapshots', { select: 'captured_at,probability,bid,ask,last_price,volume,open_interest,market_status,lifecycle,raw', market_id: `eq.${c.market_id}` }, { order: 'captured_at.asc', limit: 2000 });
  const designations = (await store.select('pred_forecast_designations', { select: 'designation,forecast_id,model_id,rule_version,reference_time,designated_at', contract_id: `eq.${contractId}` })).filter((d) => visible.has(d.forecast_id));
  const resolutions = await store.select('pred_resolutions', { select: '*', contract_id: `eq.${contractId}` });
  const scores = (await store.select('pred_scores', { select: 'designation,scoring_method,score,benchmark_score,improvement,outcome,market_probability,forecast_id', contract_id: `eq.${contractId}` })).filter((x) => visible.has(x.forecast_id));
  const featureById = new Map(features.map((f) => [f.snapshot_id, f]));
  const first = market[0] || null;
  const lastOpen = [...market].reverse().find((m) => m.market_status === 'active') || null;
  return {
    contract: c,
    event,
    forecasts: forecasts.map((f) => ({ ...f, probability_pct: pct(f.probability), market_probability_pct: pct(f.market_probability), feature_snapshot: featureById.get(f.feature_snapshot_id) || null })),
    market_path: market.map((m) => ({ t: m.captured_at, probability_pct: pct(m.probability), bid_pct: pct(m.bid), ask_pct: pct(m.ask), last_pct: pct(m.last_price), volume: m.volume, status: m.market_status, lifecycle: m.lifecycle })),
    market_summary: { first_observed: first ? { t: first.captured_at, probability_pct: pct(first.probability), note: 'first observed by PBE — not necessarily the opening price' } : null, last_tradable: lastOpen ? { t: lastOpen.captured_at, probability_pct: pct(lastOpen.probability) } : null, kalshi_url: market.at(-1)?.raw?.kalshi_url ?? null },
    designations,
    resolution: resolutions[0] || null,
    scores,
  };
}

export async function queue(store, { now = new Date().toISOString() } = {}) {
  const since = new Date(Date.parse(now) - 3 * 86400000).toISOString();
  const rows = await store.select('pred_contracts', { select: 'market_id,domain,normalization_status,status_reason,event_type,station_id,normalized_at', normalized_at: `gte.${since}` }, { limit: 5000 });
  const current = latestBy(rows, 'market_id', 'normalized_at');
  const counts = {};
  const holds = [];
  for (const c of current.values()) {
    const k = `${c.domain}:${c.normalization_status}${c.status_reason ? `:${c.status_reason}` : ''}`;
    counts[k] = (counts[k] || 0) + 1;
    if (c.normalization_status !== 'NORMALIZED') holds.push(c);
  }
  return { generated_at: now, counts, fail_closed: holds.slice(0, 200) };
}

export async function trackRecord(store) {
  // public track record = RESEARCH/VALIDATED/OFFICIAL forecasts only (shadow models are scored privately)
  const all = await store.select('pred_scores', { select: 'designation,scoring_method,score,benchmark_score,outcome,contract_id,forecast_id', designation: 'not.is.null' }, { limit: 10000 });
  const shadowIds = new Set((all.length ? await chunked(store, 'pred_forecasts', 'forecast_id,model_state', 'forecast_id', [...new Set(all.map((x) => x.forecast_id))]) : []).filter((f) => f.model_state === 'SHADOW').map((f) => f.forecast_id));
  const scores = all.filter((x) => !shadowIds.has(x.forecast_id));
  const groups = {};
  for (const s of scores) {
    const k = `${s.designation}|${s.scoring_method}`;
    const g = groups[k] || (groups[k] = { designation: s.designation, method: s.scoring_method, n: 0, pbe: 0, market_n: 0, market: 0 });
    g.n += 1; g.pbe += Number(s.score);
    if (s.benchmark_score !== null) { g.market_n += 1; g.market += Number(s.benchmark_score); }
  }
  return { resolved_contracts: new Set(scores.map((s) => s.contract_id)).size, groups: Object.values(groups).map((g) => ({ designation: g.designation, method: g.method, n: g.n, pbe_mean: +(g.pbe / g.n).toFixed(4), market_n: g.market_n, market_mean: g.market_n ? +(g.market / g.market_n).toFixed(4) : null })) };
}
