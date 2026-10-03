// One engine cycle: discover -> normalize -> observe market -> forecast (domain data only) -> designate ->
// resolve -> score. Idempotent: every write is an insert keyed so a re-run is a no-op.
import { normalizeContract } from '../../../src/engine/contracts.js';
import { normalizeMarket } from '../../../src/vendor/propsports-markets/core.js';
import { lifecycleOf } from '../../../src/vendor/propsports-markets/history.js';
import { forecastWeather, WEATHER_MODELS } from '../../../src/weather/engine.js';
import { fetchMosRun, runAvailableAt } from '../../../src/weather/mos.js';
import { fetchGridpoint } from '../../../src/weather/nws.js';
import { cliStation } from '../../../src/weather/stations.js';
import { cliDay, fetchCliYear, officialOutcome } from '../../../src/weather/cli.js';
import { sourceObservationKey } from '../../../src/source-observation.js';
import { assertMarketFree } from '../../../src/engine/leakage.js';
import { dueDesignations, scoreRows, DESIGNATION_RULES } from '../../../src/engine/designations.js';
import { sha256Hex } from '../../../src/engine/contracts.js';
import { MarketsService, MarketsBackoffError } from './markets.js';

export const USER_AGENT = 'PropBetEdgePredictions/1.0 (+https://predictions.propbetedge.ai; data@propbetedge.ai)';
const bpToProb = (bp) => (bp === null || bp === undefined ? null : bp / 10000);
const hourBucket = (iso) => iso.slice(0, 13);

export function contractRow(c, eventId) {
  return {
    contract_id: c.contract_id, event_id: eventId, venue: c.venue, market_id: c.market_id, venue_event_id: c.venue_event_id, venue_series_id: c.venue_series_id,
    normalizer_version: c.normalizer_version, rules_sha256: c.rules_sha256, rules_primary: c.rules_primary, rules_secondary: c.rules_secondary,
    normalization_status: c.normalization_status, status_reason: c.status_reason, domain: c.domain, event_type: c.event_type ?? null, subject: c.subject ?? null,
    comparator: c.comparator ?? null, threshold_low: c.threshold_low ?? null, threshold_high: c.threshold_high ?? null, units: c.units ?? null,
    location: c.location ?? null, station_id: c.station_id ?? null, station_source: c.station_source ?? null, observation_start: c.observation_start ?? null,
    observation_end: c.observation_end ?? null, timezone: c.timezone ?? null, resolution_authority: c.resolution_authority ?? null,
    resolution_dataset: c.resolution_dataset ?? null, verification_dataset: c.verification_dataset ?? null, measurement_definition: c.measurement_definition ?? null,
    rounding_rule: c.rounding_rule ?? null, exceptions: c.exceptions || [], yes_condition: c.yes_condition ?? null, no_condition: c.no_condition ?? null,
    outcome_label: c.outcome_label ?? null, close_time: c.close_time ?? null, expected_settlement_time: c.expected_settlement_time ?? null,
    detail: c.detail || {}, normalized_at: c.normalized_at,
  };
}

// Lifecycle via the canonical market-history/1 rule; "event start" = the contract observation window.
export function lifecycleFor(states, windowStart, nowMs) {
  const link = { match_status: 'matched', event_start_at: windowStart, current: { outcomes: Object.fromEntries(states.map((s, i) => [i, { role: `p:${i}`, obs: { state: s } }])) } };
  return lifecycleOf(link, nowMs);
}

function venueRow(n, contractId, eventId, lifecycle) {
  const prob = bpToProb(n.mid_bp);
  return {
    snapshot_key: `kalshi|${n.market_ticker}|${n.yes_bid_bp}|${n.yes_ask_bp}|${n.last_price_bp}|${n.status_raw}|${hourBucket(n.captured_at)}`,
    event_id: eventId, venue: 'kalshi', market_id: n.market_ticker, captured_at: n.captured_at, contract_id: contractId,
    probability: prob, bid: bpToProb(n.best_yes_bid_bp), ask: bpToProb(n.best_yes_ask_bp), no_bid: bpToProb(n.no_bid_bp), no_ask: bpToProb(n.no_ask_bp),
    last_price: bpToProb(n.last_price_bp), volume: n.volume, volume_24h: n.volume_24h, open_interest: n.open_interest, liquidity: n.liquidity,
    market_status: n.status_raw, lifecycle, close_time: n.close_time, source_updated_at: n.source_updated_at, normalizer: n.normalizer,
    raw: { ...n.raw, kalshi_url: n.kalshi_url, mid_rule: 'mid of best bid/ask when spread <= 10c (kalshi-norm/2)', result: n.result, expiration_value: n.expiration_value, settlement_ts: n.settlement_ts },
  };
}

async function cachedJson(fetchImpl, url, init, ttl) {
  const res = await fetchImpl(url, { ...init, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// Domain-source capture for one station, cached at the edge (MOS 30 min, NWS grid 60 min).
async function weatherSources(st, { fetchImpl, now }) {
  const cachingFetch = (url, init) => fetchImpl(url, { ...init, cf: { cacheTtl: 1800, cacheEverything: true } });
  const mos = await fetchMosRun({ icao: st.icao }, { fetchImpl: cachingFetch, userAgent: USER_AGENT });
  let grid = null;
  try { grid = await fetchGridpoint({ lat: st.lat, lon: st.lon }, { fetchImpl: (u, i) => fetchImpl(u, { ...i, cf: { cacheTtl: 3600, cacheEverything: true } }), userAgent: USER_AGENT }); } catch (e) { grid = { error: e.message }; }
  const mosObs = {
    provider: 'NWS GFS MOS (MAV) via IEM', sourceId: `mos:GFS:${st.icao}:${mos.runtime}`, sourceClass: 'official',
    observedAt: mos.runtime, availableAt: runAvailableAt(mos.runtime) < now ? runAvailableAt(mos.runtime) : now, capturedAt: now, revision: mos.runtime,
    data: { runtime: mos.runtime, rows: mos.rows.map((r) => ({ ftime: r.ftime, n_x: r.n_x, p06: r.p06, p12: r.p12, q06: r.q06, tmp: r.tmp, dpt: r.dpt })) },
    units: 'percent / degF', geography: { icao: st.icao, cli: st.cli }, provenance: { url: mos.url, archive: 'Iowa Environmental Mesonet MOS archive', product: 'GFS MOS MAV' },
  };
  const out = { mos: { ...mos, observationKey: sourceObservationKey(mosObs) }, observations: [mosObs], grid: null };
  if (grid?.body) {
    const updated = grid.body.properties?.updateTime || now;
    const gridObs = {
      provider: 'NWS api.weather.gov gridpoint', sourceId: `nws-grid:${grid.gridId}/${grid.gridX},${grid.gridY}`, sourceClass: 'official',
      observedAt: updated, availableAt: Date.parse(updated) <= Date.parse(now) ? updated : now, capturedAt: now, revision: updated,
      data: { probabilityOfPrecipitation: grid.body.properties?.probabilityOfPrecipitation?.values?.slice(0, 120) ?? [], quantitativePrecipitation: grid.body.properties?.quantitativePrecipitation?.values?.slice(0, 60) ?? [], maxTemperature: grid.body.properties?.maxTemperature?.values ?? [] },
      units: 'percent / mm / degC', geography: { icao: st.icao, grid: `${grid.gridId}/${grid.gridX},${grid.gridY}` }, provenance: { url: grid.url },
    };
    out.grid = { url: grid.url, body: grid.body, observationKey: sourceObservationKey(gridObs) };
    out.observations.push(gridObs);
  }
  return out;
}

function observationRow(o) {
  return {
    observation_key: sourceObservationKey(o), provider: o.provider, source_id: o.sourceId, source_class: o.sourceClass,
    observed_at: o.observedAt, available_at: o.availableAt, captured_at: o.capturedAt, value: o.value ?? null, data: o.data ?? null,
    units: o.units ?? null, geography: o.geography ?? null, vintage: null, revision: o.revision ?? null, provenance: o.provenance || {},
  };
}

export async function runCycle(env, { store, markets = null, fetchImpl = globalThis.fetch, now = new Date().toISOString(), dryRun = false } = {}) {
  const mkt = markets || new MarketsService({ binding: env.MARKETS, token: env.MARKETS_READ_TOKEN });
  const nowMs = Date.parse(now);
  const summary = { now, dry_run: dryRun, series: {}, events: 0, contracts: { NORMALIZED: 0, UNMODELABLE: 0, HOLD_RESOLUTION_AMBIGUOUS: 0, UNSUPPORTED_DOMAIN: 0 }, venue_snapshots: 0, forecasts: 0, forecast_skips: {}, designations: 0, resolutions: 0, scores: 0, errors: [] };
  const writes = { events: [], contracts: [], venue: [], observations: [], features: [], forecasts: [] };
  const seriesList = String(env.WEATHER_SERIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const stationSources = new Map();

  for (const seriesTicker of seriesList) {
    try {
      const series = await mkt.series(seriesTicker);
      const { events } = await mkt.openEvents(seriesTicker);
      summary.series[seriesTicker] = events.length;
      for (const ev of events) {
        const eventId = `PBE-${ev.event_ticker}`;
        const contracts = [];
        for (const m of ev.markets || []) contracts.push(await normalizeContract({ series, event: ev, market: m }, { now }));
        const normalized = contracts.filter((c) => c.normalization_status === 'NORMALIZED');
        for (const c of contracts) summary.contracts[c.normalization_status] += 1;
        const domain = contracts[0]?.domain || 'OTHER';
        const states = (ev.markets || []).map((m) => normalizeMarket(m, { series, event: ev, capturedAt: now }).state);
        const lifecycle = lifecycleFor(states, normalized[0]?.observation_start || null, nowMs) || 'DISCOVERED';
        const modelFamily = normalized[0] ? (WEATHER_MODELS[normalized[0].event_type]?.id ?? null) : null;
        writes.events.push({
          event_id: eventId, canonical_question: ev.title, category: domain.toLowerCase(), status: 'open', domain, event_family: seriesTicker, venue: 'kalshi',
          venue_event_id: ev.event_ticker, venue_series_id: seriesTicker, model_family: modelFamily, model_state: modelFamily ? 'RESEARCH' : 'MARKET_MONITORING', lifecycle,
          close_time: ev.markets?.[0]?.close_time ?? null, resolution_authority: normalized[0]?.resolution_authority ?? null,
          resolution_rule: normalized[0]?.rules_primary ?? null, resolution_time: ev.markets?.[0]?.expected_expiration_time ?? null,
          metadata: { series_title: series?.title ?? null, settlement_sources: series?.settlement_sources ?? [], strike_date: ev.strike_date ?? null, sub_title: ev.sub_title ?? null },
        });
        for (const c of contracts) writes.contracts.push(contractRow(c, eventId));
        for (const m of ev.markets || []) {
          const n = normalizeMarket(m, { series, event: ev, capturedAt: now });
          const c = contracts.find((x) => x.market_id === m.ticker);
          writes.venue.push(venueRow(n, c.contract_id, eventId, lifecycleFor([n.state], c.observation_start || null, nowMs)));
        }
        summary.events += 1;

        // forecasts: domain data only; the market row captured above is attached as the benchmark afterwards
        for (const c of normalized) {
          const st = cliStation(c.station_id);
          if (!stationSources.has(st.cli)) {
            try { stationSources.set(st.cli, await weatherSources(st, { fetchImpl, now })); } catch (e) { stationSources.set(st.cli, { error: e.message }); }
          }
          const src = stationSources.get(st.cli);
          if (src.error) { summary.forecast_skips.SOURCE_ERROR = (summary.forecast_skips.SOURCE_ERROR || 0) + 1; continue; }
          const f = forecastWeather(c, src, { now });
          if (f.status !== 'OK') { summary.forecast_skips[f.status] = (summary.forecast_skips[f.status] || 0) + 1; continue; }
          assertMarketFree(f.features);
          const featuresSha = await sha256Hex(JSON.stringify({ model: f.model, features: f.features }));
          const recordId = `${c.contract_id}|${f.model.id}@${f.model.version}|${featuresSha.slice(0, 16)}`;
          const snapshotId = `fs|${recordId}`;
          const v = writes.venue.find((x) => x.contract_id === c.contract_id);
          writes.features.push({ snapshot_id: snapshotId, event_id: eventId, model_id: f.model.id, cutoff_at: f.dataCutoffAt, created_at: now, features: f.features, source_classes: [...new Set(f.featureSources.map((x) => x.sourceClass))], source_observation_keys: [...new Set(f.featureSources.map((s) => s.observationKey).filter(Boolean))], context: { contract_id: c.contract_id, inputs: f.inputs }, quality: { grade: f.confidence, rules: f.explanation.quality_rules } });
          writes.forecasts.push({
            record_id: recordId, event_id: eventId, model_id: f.model.id, model_version: f.model.version, probability: f.probability, captured_at: now,
            feature_snapshot_id: snapshotId, record_type: 'live', contract_id: c.contract_id, market_id: c.market_id,
            market_probability: v?.probability ?? null, market_snapshot_key: v?.snapshot_key ?? null, market_observed_at: v?.captured_at ?? null,
            data_cutoff_at: f.dataCutoffAt, model_state: f.model.state, confidence: f.confidence, features_sha256: featuresSha,
            provenance: f.provenance, explanation: { ...f.explanation, evidence: f.evidence, raw_probability: f.rawProbability },
            metadata: { domain: 'WEATHER', event_type: c.event_type, station_id: c.station_id, observation_start: c.observation_start },
          });
        }
      }
    } catch (e) {
      summary.errors.push({ series: seriesTicker, error: e.message });
      if (e instanceof MarketsBackoffError) break;
    }
  }
  for (const s of stationSources.values()) if (s.observations) writes.observations.push(...s.observations.map(observationRow));

  // A forecast is only new when its feature hash is new for the contract (same inputs -> no duplicate record).
  if (writes.forecasts.length) {
    const ids = writes.forecasts.map((f) => f.record_id);
    const existing = dryRun || !store ? [] : await store.select('pred_forecasts', { select: 'record_id', record_id: `in.(${ids.map((i) => `"${i.replace(/"/g, '\\"')}"`).join(',')})` });
    const have = new Set(existing.map((r) => r.record_id));
    writes.forecasts = writes.forecasts.filter((f) => !have.has(f.record_id));
    const keep = new Set(writes.forecasts.map((f) => f.feature_snapshot_id));
    writes.features = writes.features.filter((f) => keep.has(f.snapshot_id));
  }
  summary.venue_snapshots = writes.venue.length;
  summary.forecasts = writes.forecasts.length;
  summary.observations = writes.observations.length;
  summary.market_requests = mkt.requests;
  if (dryRun || !store) return { summary, writes };

  for (const e of writes.events) await store.upsertEventRow(e);
  await store.insertContracts(writes.contracts);
  await store.insertVenueSnapshots(writes.venue);
  await store.insertObservations(writes.observations);
  await store.insertFeatureRows(writes.features);
  await store.insertForecastRows(writes.forecasts);

  const post = await designateResolveScore(env, { store, mkt, fetchImpl, now });
  Object.assign(summary, post);
  return { summary };
}

// Designations, resolution (official CLI + venue settlement, independently) and scoring.
export async function designateResolveScore(env, { store, mkt, fetchImpl, now }) {
  const out = { designations: 0, resolutions: 0, scores: 0 };
  const since = new Date(Date.parse(now) - 10 * 86400000).toISOString();
  const contracts = await store.select('pred_contracts', { select: '*', normalization_status: 'eq.NORMALIZED', observation_start: `gte.${since}` }, { limit: 2000 });
  if (!contracts.length) return out;
  const latestById = new Map();
  for (const c of contracts) { const prev = latestById.get(c.market_id); if (!prev || prev.normalized_at < c.normalized_at) latestById.set(c.market_id, c); }
  const forecasts = await store.select('pred_forecasts', { select: 'forecast_id,contract_id,model_id,probability,market_probability,captured_at', contract_id: `in.(${contracts.map((c) => `"${c.contract_id}"`).join(',')})` }, { limit: 5000 });
  const designations = await store.select('pred_forecast_designations', { select: '*', contract_id: `in.(${contracts.map((c) => `"${c.contract_id}"`).join(',')})` }, { limit: 5000 });
  const newDes = [];
  for (const c of contracts) {
    const fs = forecasts.filter((f) => f.contract_id === c.contract_id);
    const byModel = new Map();
    for (const f of fs) { if (!byModel.has(f.model_id)) byModel.set(f.model_id, []); byModel.get(f.model_id).push(f); }
    for (const [modelId, list] of byModel) {
      const existing = designations.filter((d) => d.contract_id === c.contract_id && d.model_id === modelId);
      for (const d of dueDesignations({ contract: c, forecasts: list, existing, now })) {
        newDes.push({ contract_id: c.contract_id, model_id: modelId, designation: d.designation, forecast_id: d.forecast.forecast_id, rule_version: DESIGNATION_RULES, reference_time: d.reference_time, detail: { captured_at: d.forecast.captured_at } });
      }
    }
  }
  for (const d of newDes) { try { await store.write('pred_forecast_designations', d, {}); out.designations += 1; } catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; } }

  // resolution: contracts whose window ended, not yet resolved; venue settlement read through the canonical service
  const resolved = await store.select('pred_resolutions', { select: 'resolution_id,contract_id', contract_id: `in.(${contracts.map((c) => `"${c.contract_id}"`).join(',')})` }, { limit: 5000 });
  const resolvedSet = new Set(resolved.map((r) => r.contract_id));
  const due = contracts.filter((c) => !resolvedSet.has(c.contract_id) && Date.parse(c.observation_end) + 3600000 < Date.parse(now) && forecasts.some((f) => f.contract_id === c.contract_id));
  if (due.length) {
    const venue = new Map();
    for (let i = 0; i < due.length; i += 50) {
      for (const m of await mkt.marketsByTicker(due.slice(i, i + 50).map((c) => c.market_id))) venue.set(m.ticker, m);
    }
    const cliCache = new Map();
    const newRes = [];
    for (const c of due) {
      const m = venue.get(c.market_id);
      if (!m || !['yes', 'no'].includes(m.result)) continue; // venue not settled yet
      const st = cliStation(c.station_id);
      const year = c.detail.climate_date.slice(0, 4);
      const key = `${st.icao}:${year}`;
      if (!cliCache.has(key)) { try { cliCache.set(key, await fetchCliYear({ icao: st.icao, year }, { fetchImpl, userAgent: USER_AGENT })); } catch (e) { cliCache.set(key, { error: e.message, rows: [] }); } }
      const day = cliDay(cliCache.get(key).rows, c.detail.climate_date);
      const official = officialOutcome(c, day);
      newRes.push({
        event_id: c.event_id, resolved_at: m.settlement_ts || now, authority: c.resolution_authority, source_url: day?.product_url ?? null,
        outcome: { venue_result: m.result, official: official ?? null, scored_outcome: m.result === 'yes' ? 1 : 0, scored_on: 'venue settlement (the contract authority value as settled)' },
        contract_id: c.contract_id, market_id: c.market_id, official_outcome: official?.outcome ?? null, official_value: official?.value ?? null, official_units: official?.units ?? null,
        official_source: day ? `NWS CLI ${c.station_id} product ${day.product_id}` : null, official_observation_key: day?.product_id ?? null,
        venue_result: m.result, venue_settlement_value: m.settlement_value_dollars != null ? Number(m.settlement_value_dollars) : null, venue_expiration_value: m.expiration_value ?? null,
        venue_settled_at: m.settlement_ts ?? null, sources_agree: official ? official.outcome === m.result.toUpperCase() : null,
        metadata: { resolution_rule: c.rules_primary, verification: c.verification_dataset },
      });
    }
    const inserted = await store.insertReturning('pred_resolutions', newRes);
    out.resolutions = inserted.length;
  }

  // scoring: every designation whose contract is resolved and not yet scored
  const allRes = await store.select('pred_resolutions', { select: 'resolution_id,contract_id,outcome,venue_result', contract_id: `in.(${contracts.map((c) => `"${c.contract_id}"`).join(',')})` }, { limit: 5000 });
  if (allRes.length) {
    const allDes = await store.select('pred_forecast_designations', { select: '*', contract_id: `in.(${allRes.map((r) => `"${r.contract_id}"`).join(',')})` }, { limit: 5000 });
    const scored = await store.select('pred_scores', { select: 'forecast_id,designation', contract_id: `in.(${allRes.map((r) => `"${r.contract_id}"`).join(',')})` }, { limit: 10000 });
    const done = new Set(scored.map((s) => `${s.forecast_id}|${s.designation}`));
    const fById = new Map(forecasts.map((f) => [f.forecast_id, f]));
    const rows = [];
    for (const d of allDes) {
      if (done.has(`${d.forecast_id}|${d.designation}`)) continue;
      const r = allRes.find((x) => x.contract_id === d.contract_id);
      const f = fById.get(d.forecast_id);
      if (!r || !f || !['yes', 'no'].includes(r.venue_result)) continue;
      rows.push(...scoreRows({ designation: d.designation, forecast: f, resolution: r, outcome: r.venue_result === 'yes' ? 1 : 0 }));
    }
    for (const row of rows) { try { await store.write('pred_scores', row, {}); out.scores += 1; } catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; } }
  }
  return out;
}
