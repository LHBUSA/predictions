// One engine cycle: discover -> normalize -> observe market -> forecast (domain data only) -> designate ->
// resolve -> score. Idempotent: every write is an insert keyed so a re-run is a no-op.
import { normalizeContract } from '../../../src/engine/contracts.js';
import { normalizeMarket } from '../../../src/vendor/propsports-markets/core.js';
import { lifecycleOf } from '../../../src/vendor/propsports-markets/history.js';
import { forecastWeather, WEATHER_MODELS } from '../../../src/weather/engine.js';
import { fetchUsableRun, runAvailableAt } from '../../../src/weather/mos.js';
import { fetchGridpoint } from '../../../src/weather/nws.js';
import { cliStation } from '../../../src/weather/stations.js';
import { cliDay, fetchCliYear, officialOutcome } from '../../../src/weather/cli.js';
import { sourceObservationKey } from '../../../src/source-observation.js';
import { assertMarketFree } from '../../../src/engine/leakage.js';
import { dueDesignations, scoreRows, DESIGNATION_RULES } from '../../../src/engine/designations.js';
import { sha256Hex } from '../../../src/engine/contracts.js';
import { MarketsService, MarketsBackoffError } from './markets.js';
import { forecastFed, fetchFredSeries, FED_INPUT_SERIES, FED_CONTEXT_SERIES, FED_MODEL } from '../../../src/macro/engine.js';
import { valueAsOf } from '../../../src/macro/fed-model.js';
import { forecastRates, ratesOfficialOutcome, parseTreasuryCsv, TREASURY_CSV, RATES_MODEL } from '../../../src/rates/engine.js';
import { chunk } from '../../../src/engine/store.js';
import { slugify } from '../../../src/vendor/propsports-markets/core.js';
import { scoringReference } from '../../../src/engine/designations.js';
import { writeDecisions } from './decision-ledger.js';

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
export async function weatherSources(st, { fetchImpl, now }) {
  const cachingFetch = (url, init) => fetchImpl(url, { ...init, cf: { cacheTtl: 1800, cacheEverything: true } });
  const mos = await fetchUsableRun({ icao: st.icao, now }, { fetchImpl: cachingFetch, userAgent: USER_AGENT });
  if (!mos.runtime) throw new Error(`no usable GFS MOS run for ${st.icao}`);
  let grid = null;
  try { grid = await fetchGridpoint({ lat: st.lat, lon: st.lon }, { fetchImpl: (u, i) => fetchImpl(u, { ...i, cf: { cacheTtl: 3600, cacheEverything: true } }), userAgent: USER_AGENT }); } catch (e) { grid = { error: e.message }; }
  const mosObs = {
    provider: 'NWS GFS MOS (MAV) via IEM', sourceId: `mos:GFS:${st.icao}:${mos.runtime}`, sourceClass: 'official',
    observedAt: mos.runtime, availableAt: runAvailableAt(mos.runtime) < now ? runAvailableAt(mos.runtime) : now, capturedAt: now, revision: mos.runtime,
    data: { runtime: mos.runtime, rows: mos.rows.map((r) => ({ ftime: r.ftime, n_x: r.n_x, p06: r.p06, p12: r.p12, q06: r.q06, tmp: r.tmp, dpt: r.dpt })) },
    units: 'percent / degF', geography: { icao: st.icao, cli: st.cli }, provenance: { url: mos.url, archive: 'Iowa Environmental Mesonet MOS archive', product: 'GFS MOS MAV' },
  };
  const out = { mos: { ...mos, observationKey: sourceObservationKey(mosObs) }, observations: [mosObs], grid: null, nbm: null };
  try {
    const nbm = await fetchUsableRun({ icao: st.icao, model: 'NBS', now }, { fetchImpl: cachingFetch, userAgent: USER_AGENT });
    if (nbm.runtime) {
      const nbmObs = {
        provider: 'NWS National Blend of Models (NBS) via IEM', sourceId: `mos:NBS:${st.icao}:${nbm.runtime}`, sourceClass: 'official',
        observedAt: nbm.runtime, availableAt: runAvailableAt(nbm.runtime) < now ? runAvailableAt(nbm.runtime) : now, capturedAt: now, revision: nbm.runtime,
        data: { runtime: nbm.runtime, rows: nbm.rows.map((r) => ({ ftime: r.ftime, n_x: r.n_x, p06: r.p06, p12: r.p12, q06: r.q06, tmp: r.tmp })) },
        units: 'percent / degF', geography: { icao: st.icao, cli: st.cli }, provenance: { url: nbm.url, archive: 'Iowa Environmental Mesonet MOS archive', product: 'NBM NBS' },
      };
      out.nbm = { ...nbm, observationKey: sourceObservationKey(nbmObs) };
      out.observations.push(nbmObs);
    }
  } catch (e) {
    // A transient NBM fetch error must not publish a downgraded GFS-only snapshot over a current v1.1 one
    // (seen 2026-10-03 19:15Z: v1.1 -> v1.0 -> v1.1 flip on the same data cutoff). Hold the station this cycle.
    // The GFS-only tier still applies when IEM genuinely has no usable NBM run (no exception, runtime null).
    throw new Error(`NBM fetch failed for ${st.icao}; holding station (no tier downgrade): ${e.message}`);
  }
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

// Canonical event slug: readable title; tickers appended only when the title carries no year (uniqueness).
export function eventSlug(ev) {
  const base = slugify(ev.title || ev.event_ticker).slice(0, 90).replace(/-+$/, '');
  return /\b(19|20)\d{2}\b/.test(ev.title || '') ? base : `${base}-${slugify(ev.event_ticker)}`;
}

// Official Treasury par curve (current + previous year CSV; the settlement source itself).
async function treasuryInputs({ fetchImpl, now }) {
  const year = Number(now.slice(0, 4));
  const urls = [TREASURY_CSV(year - 1), TREASURY_CSV(year)];
  const rows = [];
  for (const url of urls) {
    const res = await fetchImpl(url, { headers: { accept: 'text/csv', 'user-agent': USER_AGENT }, cf: { cacheTtl: 1800, cacheEverything: true } });
    const text = await res.text();
    const parsed = res.ok ? parseTreasuryCsv(text) : [];
    if (!res.ok || parsed.length < 20) throw new Error(`Treasury par curve ${res.status} ${res.headers.get('content-type')} ${parsed.length} rows: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    rows.push(...parsed);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const last = rows.at(-1);
  const o = { provider: 'U.S. Treasury Daily Par Yield Curve Rates', sourceId: 'treasury-par:5,7,10,30', sourceClass: 'official', observedAt: `${last.date}T20:00:00.000Z`, availableAt: now, capturedAt: now,
    revision: `${last.date}:${last[5]}/${last[7]}/${last[10]}/${last[30]}`, value: { 5: last[5], 7: last[7], 10: last[10], 30: last[30] }, data: { rows: rows.slice(-60) }, units: 'percent', geography: { country: 'US' }, provenance: { urls } };
  return { rows, urls, observations: [o], observationKey: sourceObservationKey(o) };
}

// Official macro inputs (FRED public CSV; daily H.15 never revised; context series = latest vintage at capture).
async function fredInputs({ fetchImpl, now }) {
  const since = new Date(Date.parse(now) - 500 * 86400000).toISOString().slice(0, 10);
  const cached = (url, init) => fetchImpl(url, { ...init, cf: { cacheTtl: 3600, cacheEverything: true } });
  const fred = await fetchFredSeries([...FED_INPUT_SERIES, ...FED_CONTEXT_SERIES], { fetchImpl: cached, userAgent: USER_AGENT, since });
  const observations = []; const observationKeys = {};
  for (const [id, s] of Object.entries(fred)) {
    const last = s.rows.at(-1);
    const o = { provider: 'FRED', sourceId: `fred:${id}`, sourceClass: 'official', observedAt: `${last[0]}T00:00:00.000Z`, availableAt: now, capturedAt: now, revision: `${last[0]}:${last[1]}`,
      value: last[1], data: { rows: s.rows.slice(-90) }, units: null, geography: { country: 'US' }, provenance: { url: s.url, note: 'public fredgraph.csv; no API key' } };
    observations.push(o); observationKeys[id] = sourceObservationKey(o);
  }
  return { fred, observations, observationKeys };
}

export async function runCycle(env, { store, markets = null, fetchImpl = globalThis.fetch, now = new Date().toISOString(), dryRun = false } = {}) {
  const mkt = markets || new MarketsService({ binding: env.MARKETS, token: env.MARKETS_READ_TOKEN });
  const nowMs = Date.parse(now);
  const summary = { now, dry_run: dryRun, series: {}, events: 0, contracts: { NORMALIZED: 0, UNMODELABLE: 0, HOLD_RESOLUTION_AMBIGUOUS: 0, UNSUPPORTED_DOMAIN: 0 }, venue_snapshots: 0, forecasts: 0, forecast_skips: {}, skipped: {}, designations: 0, resolutions: 0, scores: 0, errors: [] };
  const writes = { events: [], contracts: [], venue: [], observations: [], features: [], forecasts: [] };
  const seriesList = [env.WEATHER_SERIES, env.MACRO_SERIES, env.RATES_SERIES, env.MONITOR_SERIES].filter(Boolean).join(',').split(',').map((s) => s.trim()).filter(Boolean);
  const stationSources = new Map();
  let fredSources = null;
  let treasurySources = null;

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
        const modelFamily = normalized[0] ? (WEATHER_MODELS[normalized[0].event_type]?.id ?? (normalized[0].event_type === 'FOMC_DECISION_BUCKET' ? FED_MODEL.id : /^YIELD_PATH_/.test(normalized[0].event_type) ? RATES_MODEL.id : null)) : null;
        const category = contracts[0]?.category || domain;
        writes.events.push({
          event_id: eventId, slug: eventSlug(ev), canonical_question: ev.title, category, status: 'open', domain, event_family: seriesTicker, venue: 'kalshi',
          venue_event_id: ev.event_ticker, venue_series_id: seriesTicker, model_family: modelFamily, model_state: modelFamily ? (domain === 'MACRO' ? 'SHADOW' : 'RESEARCH') : 'MARKET_MONITORING', lifecycle,
          close_time: (ev.markets || []).map((m) => m.close_time).filter(Boolean).sort().at(-1) ?? null, resolution_authority: normalized[0]?.resolution_authority ?? null,
          resolution_rule: normalized[0]?.rules_primary ?? null, resolution_time: ev.markets?.[0]?.expected_expiration_time ?? null,
          metadata: { series_title: series?.title ?? null, series_category: series?.category ?? null, settlement_sources: series?.settlement_sources ?? [], strike_date: ev.strike_date ?? null, sub_title: ev.sub_title ?? null, mutually_exclusive: ev.mutually_exclusive ?? null, category, fail_closed: contracts.filter((c) => c.normalization_status !== 'NORMALIZED').map((c) => c.status_reason).filter((v, i, a) => a.indexOf(v) === i) },
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
          let f;
          if (c.category === 'RATES') {
            if (!treasurySources) {
              try { treasurySources = await treasuryInputs({ fetchImpl, now }); } catch (e) { treasurySources = { error: e.message }; }
            }
            if (treasurySources.error) { summary.forecast_skips.SOURCE_ERROR = (summary.forecast_skips.SOURCE_ERROR || 0) + 1; summary.errors.push({ source: 'treasury', error: treasurySources.error }); noteSkip(summary, 'source:treasury', 'SOURCE_ERROR', treasurySources.error); continue; }
            f = forecastRates(c, { treasury: treasurySources }, { now });
          } else if (c.domain === 'MACRO') {
            if (!fredSources) {
              try { fredSources = await fredInputs({ fetchImpl, now }); } catch (e) { fredSources = { error: e.message }; }
            }
            if (fredSources.error) { summary.forecast_skips.SOURCE_ERROR = (summary.forecast_skips.SOURCE_ERROR || 0) + 1; summary.errors.push({ source: 'fred', error: fredSources.error }); continue; }
            f = forecastFed(c, fredSources, { now });
          } else {
            const st = cliStation(c.station_id);
            if (!stationSources.has(st.cli)) {
              try { stationSources.set(st.cli, await weatherSources(st, { fetchImpl, now })); } catch (e) { stationSources.set(st.cli, { error: e.message }); }
            }
            const src = stationSources.get(st.cli);
            if (src.error) { summary.forecast_skips.SOURCE_ERROR = (summary.forecast_skips.SOURCE_ERROR || 0) + 1; noteSkip(summary, `station:${st.cli}`, 'SOURCE_ERROR', src.error); continue; }
            f = forecastWeather(c, src, { now });
          }
          if (f.status !== 'OK') { summary.forecast_skips[f.status] = (summary.forecast_skips[f.status] || 0) + 1; continue; }
          assertMarketFree(f.features);
          const featuresSha = await sha256Hex(JSON.stringify({ model: f.model, features: f.features }));
          const recordId = `${c.contract_id}|${f.model.id}@${f.model.version}|${featuresSha.slice(0, 16)}|${now}`;
          const snapshotId = `fs|${recordId}`;
          const v = writes.venue.find((x) => x.contract_id === c.contract_id);
          writes.features.push({ snapshot_id: snapshotId, event_id: eventId, model_id: f.model.id, cutoff_at: f.dataCutoffAt, created_at: now, features: f.features, source_classes: [...new Set(f.featureSources.map((x) => x.sourceClass))], source_observation_keys: [...new Set(f.featureSources.map((s) => s.observationKey).filter(Boolean))], context: { contract_id: c.contract_id, inputs: f.inputs }, quality: { grade: f.confidence, rules: f.explanation.quality_rules } });
          writes.forecasts.push({
            record_id: recordId, event_id: eventId, model_id: f.model.id, model_version: f.model.version, probability: f.probability, captured_at: now,
            feature_snapshot_id: snapshotId, record_type: 'live', contract_id: c.contract_id, market_id: c.market_id,
            market_probability: v?.probability ?? null, market_snapshot_key: v?.snapshot_key ?? null, market_observed_at: v?.captured_at ?? null,
            data_cutoff_at: f.dataCutoffAt, model_state: f.model.state, confidence: f.confidence, features_sha256: featuresSha,
            provenance: f.provenance, explanation: { ...f.explanation, evidence: f.evidence, raw_probability: f.rawProbability },
            metadata: { domain: c.domain, category: c.category, event_type: c.event_type, station_id: c.station_id, observation_start: c.observation_start, ...(f.distribution ? { distribution: f.distribution } : {}) },
          });
        }
      }
    } catch (e) {
      summary.errors.push({ series: seriesTicker, error: e.message });
      if (e instanceof MarketsBackoffError) break;
    }
  }
  for (const s of stationSources.values()) if (s.observations) writes.observations.push(...s.observations.map(observationRow));
  if (fredSources?.observations) writes.observations.push(...fredSources.observations.map(observationRow));
  if (treasurySources?.observations) writes.observations.push(...treasurySources.observations.map(observationRow));

  // Publish a new snapshot only when the inputs differ from the LATEST snapshot for that contract + model
  // (an A -> B -> A sequence publishes A again; identical consecutive inputs publish nothing).
  if (writes.forecasts.length) {
    const contractIds = [...new Set(writes.forecasts.map((f) => f.contract_id))];
    const prior = dryRun || !store ? [] : await store.selectIn('pred_forecasts', { select: 'contract_id,model_id,features_sha256,captured_at', captured_at: `gte.${new Date(Date.parse(now) - 10 * 86400000).toISOString()}` }, 'contract_id', contractIds, { chunkSize: 30 });
    const latest = new Map();
    for (const r of prior) { const k = `${r.contract_id}|${r.model_id}`; if (!latest.has(k) || latest.get(k).captured_at < r.captured_at) latest.set(k, r); }
    writes.forecasts = writes.forecasts.filter((f) => latest.get(`${f.contract_id}|${f.model_id}`)?.features_sha256 !== f.features_sha256);
    const keep = new Set(writes.forecasts.map((f) => f.feature_snapshot_id));
    writes.features = writes.features.filter((f) => keep.has(f.snapshot_id));
  }
  summary.venue_snapshots = writes.venue.length;
  summary.forecasts = writes.forecasts.length;
  summary.observations = writes.observations.length;
  summary.market_requests = mkt.requests;
  if (treasurySources?.rows) summary.treasury = { rows: treasurySources.rows.length, first: treasurySources.rows[0]?.date, last: treasurySources.rows.at(-1)?.date, last10y: treasurySources.rows.at(-1)?.[10] };
  if (dryRun || !store) return { summary, writes };

  for (const e of writes.events) {
    try { await store.upsertEventRow(e); } catch (err) {
      if (!/slug|duplicate|unique/i.test(err.message)) throw err;
      await store.upsertEventRow({ ...e, slug: `${e.slug}-${slugify(e.venue_event_id)}` }); // title collision with another event
    }
  }
  await store.insertContracts(writes.contracts);
  await store.insertVenueSnapshots(writes.venue);
  await store.insertObservations(writes.observations);
  await store.insertFeatureRows(writes.features);
  await store.insertForecastRows(writes.forecasts);

  const post = await designateResolveScore(env, { store, mkt, fetchImpl, now });
  Object.assign(summary, post);
  // Diagnostic record of skipped publications (expected input unavailable -> skip, never substitute).
  // Persisted once sql/003 is applied and NEWSROOM_DB=true; always present in the logged cycle summary.
  if (env.NEWSROOM_DB === 'true' && Object.keys(summary.skipped).length) {
    try { await store.insertReturning('pred_cycle_diagnostics', Object.entries(summary.skipped).map(([scope, v]) => ({ cycle_at: now, kind: 'FORECAST_SKIP', scope, reason: v.reason, contracts: v.contracts, detail: { error: v.detail } }))); } catch (e) { summary.errors.push({ source: 'diagnostics', error: e.message }); }
  }
  return { summary };
}

export function noteSkip(summary, scope, reason, detail) {
  const cur = summary.skipped[scope] || { reason, contracts: 0, detail: String(detail || '').slice(0, 240) };
  cur.contracts += 1;
  summary.skipped[scope] = cur;
}

// Official FOMC outcome: change in the target upper bound across the meeting (FRED DFEDTARU), bucketed.
export function fedOfficialOutcome(c, upperRows) {
  const d = c.detail.meeting_date;
  const shiftD = (n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const before = valueAsOf(upperRows, shiftD(-1));
  const after = valueAsOf(upperRows, shiftD(2));
  if (!before || !after || after.date <= d) return null;
  const bps = Math.round((after.value - before.value) * 100);
  const o = c.detail.outcome;
  const yes = o === 'hold' ? bps === 0 : o === 'cut_25' ? bps === -25 : o === 'hike_25' ? bps === 25 : o === 'cut_gt_25' ? bps < -25 : bps > 25;
  return { outcome: yes ? 'YES' : 'NO', value: bps, units: 'bps', basis: 'target upper bound change', before_date: before.date, after_date: after.date };
}

// Resolution (official source + venue settlement, independently), then designations (fixed by rule, reference =
// scoring reference or the venue settlement if earlier), then scoring. Every list read is chunked and paged.
export async function designateResolveScore(env, { store, mkt, fetchImpl, now }) {
  const out = { designations: 0, resolutions: 0, scores: 0 };
  const since = new Date(Date.parse(now) - 10 * 86400000).toISOString();
  const contracts = await store.select('pred_contracts', { select: '*', normalization_status: 'eq.NORMALIZED', observation_end: `gte.${since}` });
  if (!contracts.length) return out;
  const ids = contracts.map((c) => c.contract_id);
  const forecasts = await store.selectIn('pred_forecasts', { select: 'forecast_id,contract_id,model_id,probability,market_probability,captured_at' }, 'contract_id', ids);
  const withForecast = new Set(forecasts.map((f) => f.contract_id));
  let resolutions = await store.selectIn('pred_resolutions', { select: 'resolution_id,contract_id,outcome,venue_result,resolved_at' }, 'contract_id', ids);
  const resolvedSet = new Set(resolutions.map((r) => r.contract_id));

  // 1. resolution: window ended (or a path contract that may have settled early); venue settlement via canonical service
  const isPath = (c) => /^YIELD_PATH_/.test(c.event_type || '');
  const due = contracts.filter((c) => withForecast.has(c.contract_id) && !resolvedSet.has(c.contract_id) && (isPath(c) || Date.parse(c.observation_end) + 3600000 < Date.parse(now)));
  if (due.length) {
    const venue = new Map();
    for (const part of chunk(due.map((c) => c.market_id), 50)) for (const m of await mkt.marketsByTicker(part)) venue.set(m.ticker, m);
    const cache = new Map();
    const newRes = [];
    for (const c of due) {
      const m = venue.get(c.market_id);
      if (!m || !['yes', 'no'].includes(m.result)) continue; // venue not settled yet
      let day = null; let official = null; let sourceLabel = null;
      if (c.event_type === 'FOMC_DECISION_BUCKET') {
        if (!cache.has('fred')) { try { cache.set('fred', await fetchFredSeries(['DFEDTARU'], { fetchImpl, userAgent: USER_AGENT, since: '2026-01-01' })); } catch (e) { cache.set('fred', { error: e.message }); } }
        official = fedOfficialOutcome(c, cache.get('fred')?.DFEDTARU?.rows || []);
        if (official) { day = { product_id: `FRED DFEDTARU ${official.before_date}->${official.after_date}`, product_url: 'https://fred.stlouisfed.org/series/DFEDTARU' }; sourceLabel = `Federal funds target ${day.product_id}`; }
      } else if (isPath(c)) {
        if (!cache.has('treasury')) { try { cache.set('treasury', await treasuryInputs({ fetchImpl, now })); } catch (e) { cache.set('treasury', { error: e.message, rows: [] }); } }
        official = ratesOfficialOutcome(c, cache.get('treasury').rows || []);
        if (official) { day = { product_id: `Treasury par ${c.detail.tenor}Y ${official.basis}`, product_url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve' }; sourceLabel = `U.S. Treasury ${day.product_id}`; }
      } else {
        const st = cliStation(c.station_id);
        const year = c.detail.climate_date.slice(0, 4);
        const key = `${st.icao}:${year}`;
        if (!cache.has(key)) { try { cache.set(key, await fetchCliYear({ icao: st.icao, year }, { fetchImpl, userAgent: USER_AGENT })); } catch (e) { cache.set(key, { error: e.message, rows: [] }); } }
        day = cliDay(cache.get(key).rows, c.detail.climate_date);
        official = officialOutcome(c, day);
        if (day) sourceLabel = `NWS CLI ${c.station_id} product ${day.product_id}`;
      }
      newRes.push({
        event_id: c.event_id, resolved_at: m.settlement_ts || now, authority: c.resolution_authority, source_url: day?.product_url ?? null,
        outcome: { venue_result: m.result, official: official ?? null, scored_outcome: m.result === 'yes' ? 1 : 0, scored_on: 'venue settlement (the contract authority value as settled)' },
        contract_id: c.contract_id, market_id: c.market_id, official_outcome: official?.outcome ?? null, official_value: official?.value ?? null, official_units: official?.units ?? null,
        official_source: sourceLabel, official_observation_key: day?.product_id ?? null,
        venue_result: m.result, venue_settlement_value: m.settlement_value_dollars != null ? Number(m.settlement_value_dollars) : null, venue_expiration_value: m.expiration_value ?? null,
        venue_settled_at: m.settlement_ts ?? null, sources_agree: official ? official.outcome === m.result.toUpperCase() : null,
        metadata: { resolution_rule: c.rules_primary, verification: c.verification_dataset },
      });
    }
    const inserted = newRes.length ? (await Promise.all(chunk(newRes, 200).map((part) => store.insertReturning('pred_resolutions', part)))).flat() : [];
    out.resolutions = inserted.length;
    resolutions = resolutions.concat(inserted);
  }
  const resByContract = new Map(resolutions.map((r) => [r.contract_id, r]));

  // 2. designations
  const designations = await store.selectIn('pred_forecast_designations', { select: '*' }, 'contract_id', ids);
  const newDes = [];
  for (const c of contracts) {
    const fs = forecasts.filter((f) => f.contract_id === c.contract_id);
    if (!fs.length) continue;
    const resolvedAt = resByContract.get(c.contract_id)?.resolved_at || null;
    const byModel = new Map();
    for (const f of fs) { if (!byModel.has(f.model_id)) byModel.set(f.model_id, []); byModel.get(f.model_id).push(f); }
    for (const [modelId, list] of byModel) {
      // intraday models (designation-intraday/1, separate scoring) never take pre-window designations or scores
      if (/-intraday$/.test(modelId)) continue;
      const existing = designations.filter((d) => d.contract_id === c.contract_id && d.model_id === modelId);
      for (const d of dueDesignations({ contract: c, forecasts: list, existing, now, resolvedAt })) {
        newDes.push({ contract_id: c.contract_id, model_id: modelId, designation: d.designation, forecast_id: d.forecast.forecast_id, rule_version: DESIGNATION_RULES, reference_time: d.reference_time, detail: { captured_at: d.forecast.captured_at, scoring_reference: new Date(scoringReference(c, resolvedAt)).toISOString() } });
      }
    }
  }
  for (const d of newDes) { try { await store.write('pred_forecast_designations', d, {}); out.designations += 1; designations.push(d); } catch (e) { if (!/duplicate|unique|after resolution/i.test(e.message)) throw e; } }

  // 2b. decision ledger (sql/006): one immutable row per FINAL_PRE_RESOLUTION designation captured after the freeze
  if (env.DECISIONS_DB === 'true') {
    try { out.decisions = await writeDecisions(store, designations); } catch (e) { out.decisions = { error: e.message }; console.error('decision ledger', e.message); }
  }

  // 3. scoring: every designation of a resolved contract not yet scored
  const resolvedIds = [...resByContract.keys()];
  if (resolvedIds.length) {
    const allDes = await store.selectIn('pred_forecast_designations', { select: '*' }, 'contract_id', resolvedIds);
    const scored = await store.selectIn('pred_scores', { select: 'forecast_id,designation' }, 'contract_id', resolvedIds);
    const done = new Set(scored.map((x) => `${x.forecast_id}|${x.designation}`));
    const fById = new Map(forecasts.map((f) => [f.forecast_id, f]));
    const rows = [];
    for (const d of allDes) {
      if (done.has(`${d.forecast_id}|${d.designation}`)) continue;
      const r = resByContract.get(d.contract_id);
      const f = fById.get(d.forecast_id);
      if (!r || !f || !['yes', 'no'].includes(r.venue_result)) continue;
      rows.push(...scoreRows({ designation: d.designation, forecast: f, resolution: r, outcome: r.venue_result === 'yes' ? 1 : 0 }));
    }
    for (const row of rows) { try { await store.write('pred_scores', row, {}); out.scores += 1; } catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; } }
  }
  return out;
}
