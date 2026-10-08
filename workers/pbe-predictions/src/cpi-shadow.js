// CPI V1 PRIVATE SHADOW lane (owner approval 2026-10-07; sql/015). Runs at :09 and :39 off the one-minute cron, in its
// own waitUntil, never inside the core cycle. Kill switch: CPI_SHADOW != "true".
//   1. EIA first-seen capture (hourly, :09): every weekly gasoline value PBE has not seen before -> pred_macro_first_seen.
//   2. BLS first-seen capture: once a scheduled release time has passed, the current release page, parsed by the same
//      code that built the training ledger, checked against the expected month and the previous release.
//   3. Contract ingest: CPI events/contracts (KXCPI, KXCPIYOY, KXCPICOREYOY, plus KXCPICORE for monitoring only) and venue
//      snapshots, through the canonical market service. Events are MARKET_MONITORING with no model family: nothing about a
//      CPI model is public. Venue prices are stored for a later, separate benchmark and never read by the model.
//   4. Forecast: for each approved target and calendar month whose T-1D cutoff has passed, exactly one frozen run
//      (pred_cpi_shadow_runs) and one pred_forecasts_shadow row per contract. Contracts listed after the freeze get rows
//      from the SAME frozen distribution until the release. After the release no forecast is ever created.
//   5. Grade: OK runs whose release has been captured first-seen, against the exact one-decimal BLS value.
import ledgerFile from '../../../data/cpi/bls-cpi-releases-v1.json' with { type: 'json' };
import artifact from '../../../src/macro/artifacts/cpi-v1.json' with { type: 'json' };
import { normalizeContract, sha256Hex } from '../../../src/engine/contracts.js';
import { normalizeMarket } from '../../../src/vendor/propsports-markets/core.js';
import { parseRelease, vintageConsistency, PARSER_VERSION } from '../../../src/macro/cpi/bls-release.js';
import { parseEiaWeekly, EIA_SOURCE_URL } from '../../../src/macro/cpi/eia-gasoline.js';
import { eiaAvailableAt } from '../../../src/macro/cpi/asof.js';
import { RELEASE_DATES, releaseFor, calendarHorizon, CALENDAR_VERSION } from '../../../src/macro/cpi/calendar.js';
import { CPI_EVENT_TYPE } from '../../../src/macro/cpi/cpi-contract.js';
import { assertShadowArtifact, buildShadowRun, contractProbabilities, distributionOf, gradeRun, shadowContractRow, runId, SHADOW_TARGETS, SHADOW_MODEL_ID, ARTIFACT_SHA256, EIA_SERIES, BLS_SERIES } from '../../../src/macro/cpi/shadow.js';
import { contractRow, eventSlug, lifecycleFor, venueRow, USER_AGENT } from './cycle.js';
import { pool } from '../../../src/engine/store.js';

export const CAPTURE_VERSION = 'cpi-shadow-capture/1';
export const CPI_SERIES = Object.freeze(['KXCPI', 'KXCPIYOY', 'KXCPICOREYOY', 'KXCPICORE']);
export const BLS_CURRENT_URL = 'https://www.bls.gov/news.release/cpi.nr0.htm';
// Forecast runs exist only for releases whose cutoff is after the lane went live (no retroactive MISSED rows).
export const LANE_START = '2026-10-08T00:00:00.000Z';
export const cpiShadowDue = (iso) => new Date(iso).getUTCMinutes() % 30 === 9; // :09 and :39
const eiaDue = (iso) => new Date(iso).getUTCMinutes() === 9;
const LEDGER = ledgerFile.releases;
assertShadowArtifact(artifact);

const FS = 'pred_macro_first_seen';
const FS_CONFLICT = 'source,series,period,content_sha256';

async function fetchText(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return text;
}

// ---------------------------------------------------------------- 1. EIA first seen
export async function captureEia(store, { fetchImpl, now, existing }) {
  const html = await fetchText(fetchImpl, EIA_SOURCE_URL);
  const weeks = parseEiaWeekly(html);
  if (weeks.length < 500) throw new Error(`EIA page parsed only ${weeks.length} weeks`);
  const docSha = await sha256Hex(html);
  // latest value PBE holds per week (rows arrive ordered by observed_at); a changed value is a new row, never an update
  const latest = new Map(existing.map((r) => [r.period, Number(r.value)]));
  const rows = [];
  for (const w of weeks) {
    if (latest.get(w.date) === w.price) continue;
    rows.push({ source: 'EIA', series: EIA_SERIES, period: w.date, value: w.price, payload: {}, content_sha256: await sha256Hex(`${EIA_SERIES}|${w.date}|${w.price}`),
      observed_at: now, source_published_at: eiaAvailableAt(w.date), source_url: EIA_SOURCE_URL, source_document_sha256: docSha, parser_version: 'eia-leafhandler/1', capture_version: CAPTURE_VERSION });
  }
  if (rows.length) await store.insertMany(FS, rows, FS_CONFLICT);
  return { weeks: weeks.length, last_week: weeks.at(-1)?.date ?? null, new_rows: rows.length };
}

// ---------------------------------------------------------------- 2. BLS first seen
export async function captureBls(store, { fetchImpl, now, firstSeenBls }) {
  const have = new Set([...LEDGER.map((r) => r.referenceMonth), ...firstSeenBls.map((r) => r.period)]);
  const due = Object.keys(RELEASE_DATES).filter((m) => !have.has(m) && Date.parse(releaseFor(m).releaseAt) <= Date.parse(now)).sort();
  if (!due.length) return { due: [] };
  const month = due[0];
  const rel = releaseFor(month);
  const [y, m, d] = rel.releaseDate.split('-');
  const file = `cpi_${m}${d}${y}.htm`;
  // the current release page first; the archive copy if a later release has already replaced it
  let parsed = null; const tried = [];
  for (const url of [BLS_CURRENT_URL, `https://www.bls.gov/news.release/archives/${file}`]) {
    try {
      const html = await fetchText(fetchImpl, url);
      const r = parseRelease(html, file, { sha256: await sha256Hex(html), sourceUrl: url });
      if (r.referenceMonth === month) { parsed = r; break; }
      tried.push(`${url}: page is ${r.referenceMonth}`);
    } catch (e) { tried.push(`${url}: ${e.message.slice(0, 120)}`); }
  }
  if (!parsed) return { due, month, captured: false, reason: `the ${month} release is not readable yet`, tried };
  const prior = [...LEDGER, ...firstSeenBls.map((r) => r.payload)].filter((r) => r.releaseAt < parsed.releaseAt).sort((a, b) => a.releaseAt.localeCompare(b.releaseAt)).at(-1);
  const misaligned = prior ? vintageConsistency([prior, parsed]) : [];
  if (misaligned.length) throw new Error(`BLS ${month} release fails the alignment guard: ${misaligned[0].error}`);
  const contentSha = await sha256Hex(JSON.stringify({ referenceMonth: parsed.referenceMonth, releaseAt: parsed.releaseAt, series: parsed.series }));
  await store.insertMany(FS, [{ source: 'BLS', series: BLS_SERIES, period: month, value: parsed.series.headline?.saMoM?.[month] ?? null, payload: parsed, content_sha256: contentSha,
    observed_at: now, source_published_at: parsed.releaseAt, source_url: parsed.sourceUrl, source_document_sha256: parsed.sourceSha256, parser_version: PARSER_VERSION, capture_version: CAPTURE_VERSION }], FS_CONFLICT);
  return { due, month, captured: true, headline: parsed.series.headline?.saMoM?.[month] ?? null, narrative_check: parsed.narrativeHeadlineCheck };
}

// ---------------------------------------------------------------- 3. contracts (terms) + venue snapshots (benchmark only)
export async function ingestContracts(store, mkt, { now }) {
  const nowMs = Date.parse(now);
  const out = { series: {}, contracts: 0, normalized: 0, errors: [] };
  const writes = { events: [], contracts: [], venue: [] };
  for (const seriesTicker of CPI_SERIES) {
    try {
      const series = await mkt.series(seriesTicker);
      const { events } = await mkt.openEvents(seriesTicker);
      out.series[seriesTicker] = events.length;
      for (const ev of events) {
        const eventId = `PBE-${ev.event_ticker}`;
        const contracts = [];
        for (const m of ev.markets || []) contracts.push(await normalizeContract({ series, event: ev, market: m }, { now }));
        const normalized = contracts.filter((c) => c.normalization_status === 'NORMALIZED');
        out.contracts += contracts.length; out.normalized += normalized.length;
        const states = (ev.markets || []).map((m) => normalizeMarket(m, { series, event: ev, capturedAt: now }).state);
        writes.events.push({
          event_id: eventId, slug: eventSlug(ev), canonical_question: ev.title, category: 'MACRO', status: 'open', domain: 'MACRO', event_family: seriesTicker, venue: 'kalshi',
          venue_event_id: ev.event_ticker, venue_series_id: seriesTicker, model_family: null, model_state: 'MARKET_MONITORING', lifecycle: lifecycleFor(states, normalized[0]?.observation_start || null, nowMs) || 'DISCOVERED',
          close_time: (ev.markets || []).map((m) => m.close_time).filter(Boolean).sort().at(-1) ?? null, resolution_authority: normalized[0]?.resolution_authority ?? null,
          resolution_rule: normalized[0]?.rules_primary ?? null, resolution_time: ev.markets?.[0]?.expected_expiration_time ?? null,
          metadata: { series_title: series?.title ?? null, series_category: series?.category ?? null, settlement_sources: series?.settlement_sources ?? [], strike_date: ev.strike_date ?? null, sub_title: ev.sub_title ?? null, mutually_exclusive: ev.mutually_exclusive ?? null, category: 'MACRO', fail_closed: contracts.filter((c) => c.normalization_status !== 'NORMALIZED').map((c) => c.status_reason).filter((v, i, a) => a.indexOf(v) === i) },
        });
        for (const c of contracts) writes.contracts.push(contractRow(c, eventId));
        for (const m of ev.markets || []) {
          const n = normalizeMarket(m, { series, event: ev, capturedAt: now });
          const c = contracts.find((x) => x.market_id === m.ticker);
          writes.venue.push(venueRow(n, c.contract_id, eventId, lifecycleFor([n.state], c.observation_start || null, nowMs)));
        }
      }
    } catch (e) { out.errors.push({ series: seriesTicker, error: e.message }); }
  }
  await pool(writes.events, 4, (e) => store.upsertEventRow(e).catch((err) => {
    if (!/slug|duplicate|unique/i.test(err.message)) throw err;
    return store.upsertEventRow({ ...e, slug: `${e.slug}-${e.venue_event_id.toLowerCase()}` });
  }));
  await store.insertContracts(writes.contracts);
  await store.insertVenueSnapshots(writes.venue);
  out.events = writes.events.length; out.venue_snapshots = writes.venue.length;
  return out;
}

// ---------------------------------------------------------------- 4. forecasts
async function rowHashes(run) {
  const featuresSha = await sha256Hex(JSON.stringify({ model: `${SHADOW_MODEL_ID}@${run.model_version}`, features: run.features }));
  const predictiveHash = await sha256Hex(JSON.stringify({ artifact: run.artifact_sha256, target: run.target, month: run.reference_month, cutoff: run.cutoff_at, features: run.features }));
  const sourceStateHash = await sha256Hex(JSON.stringify({ provenance: run.input_provenance, observed: run.inputs_observed_at }));
  return { featuresSha, predictiveHash, sourceStateHash };
}

export function dueRuns({ now, runs }) {
  const have = new Set(runs.map((r) => r.run_id));
  const out = [];
  for (const month of Object.keys(RELEASE_DATES).sort()) {
    const rel = releaseFor(month);
    if (Date.parse(rel.cutoffAt) < Date.parse(LANE_START) || Date.parse(now) < Date.parse(rel.cutoffAt)) continue;
    for (const target of SHADOW_TARGETS) if (!have.has(runId(target, month))) out.push({ target, release: rel });
  }
  return out;
}

export async function forecastDue(store, { now, runs, contracts, firstSeenBls, firstSeenEia }) {
  const out = { runs_written: 0, ok: 0, no_forecast: {}, contract_rows: 0 };
  const newRuns = [];
  for (const { target, release } of dueRuns({ now, runs })) {
    const cs = contracts.filter((c) => c.detail?.cpi_target === target && c.detail?.reference_month === release.referenceMonth);
    const run = buildShadowRun({ artifact, artifactSha: ARTIFACT_SHA256, target, release, ledger: LEDGER, firstSeenBls, firstSeenEia, contracts: cs, now });
    newRuns.push(run);
    if (run.status === 'OK') out.ok += 1; else out.no_forecast[run.reason] = (out.no_forecast[run.reason] || 0) + 1;
  }
  if (newRuns.length) { await store.insertMany('pred_cpi_shadow_runs', newRuns, 'run_id'); out.runs_written = newRuns.length; }
  return { ...out, newRuns };
}

// Contract rows for every OK run still before its release: the run's own contracts plus any contract listed since,
// all priced from the frozen distribution (never recomputed from newer inputs).
export async function contractRowsForOpenRuns(store, { now, runs, contracts, existing }) {
  const have = new Set(existing.map((r) => r.record_id));
  const rows = [];
  for (const run of runs) {
    if (run.status !== 'OK' || Date.parse(now) >= Date.parse(run.release_at)) continue;
    const cs = contracts.filter((c) => c.detail?.cpi_target === run.target && c.detail?.reference_month === run.reference_month);
    if (!cs.length) continue;
    const priced = contractProbabilities(distributionOf(run), run.target, run.reference_month, cs);
    const h = await rowHashes(run);
    for (const c of priced) {
      const row = shadowContractRow(run, c, { capturedAt: now, ...h });
      if (!have.has(row.record_id)) rows.push(row);
    }
  }
  if (rows.length) await store.insertMany('pred_forecasts_shadow', rows, 'record_id');
  return rows.length;
}

// ---------------------------------------------------------------- 5. grading
export async function gradeDue(store, mkt, { now, runs, grades, firstSeenBls }) {
  const graded = new Set(grades.map((g) => g.run_id));
  const blsBy = new Map();
  for (const r of [...firstSeenBls].sort((a, b) => a.observed_at.localeCompare(b.observed_at))) if (!blsBy.has(r.period)) blsBy.set(r.period, r);
  const todo = runs.filter((r) => r.status === 'OK' && !graded.has(r.run_id) && blsBy.has(r.reference_month));
  if (!todo.length) return { graded: 0 };
  const shadowRows = await store.selectIn('pred_forecasts_shadow', { select: 'market_id,probability,raw_probability,explanation,metadata', model_id: `eq.${SHADOW_MODEL_ID}` }, 'metadata->>run_id', todo.map((r) => r.run_id));
  const venue = new Map();
  try { for (const m of await mkt.marketsByTicker([...new Set(shadowRows.map((r) => r.market_id))])) venue.set(m.ticker, m); } catch { /* cross-check only; graded on BLS regardless */ }
  const out = [];
  for (const run of todo) {
    const rows = shadowRows.filter((r) => r.metadata?.run_id === run.run_id);
    const g = gradeRun(run, blsBy.get(run.reference_month), { now, shadowRows: rows, venue: new Map(rows.map((r) => [r.market_id, venue.get(r.market_id)]).filter(([, v]) => v && ['yes', 'no'].includes(v.result))) });
    if (g) out.push(g);
  }
  if (out.length) await store.insertMany('pred_cpi_shadow_grades', out, 'run_id');
  return { graded: out.length };
}

// ---------------------------------------------------------------- lane
export async function runCpiShadow({ store, mkt, fetchImpl = globalThis.fetch, now = new Date().toISOString() }) {
  const out = { now, model: `${SHADOW_MODEL_ID}@${artifact.modelVersion}`, errors: [] };
  const step = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out.errors.push({ step: k, error: e.message }); } };
  const readFs = (source) => store.select(FS, { select: 'first_seen_id,source,series,period,value,payload,observed_at', source: `eq.${source}` }, { order: 'observed_at.asc' });
  let eia = await readFs('EIA');
  if (eiaDue(now) || !eia.length) { await step('eia', () => captureEia(store, { fetchImpl, now, existing: eia })); if (out.eia?.new_rows) eia = await readFs('EIA'); }
  let bls = await readFs('BLS');
  await step('bls', () => captureBls(store, { fetchImpl, now, firstSeenBls: bls }));
  if (out.bls?.captured) bls = await readFs('BLS');
  if (mkt) await step('contracts', () => ingestContracts(store, mkt, { now }));
  const since = new Date(Date.parse(now) - 120 * 86400000).toISOString();
  const contracts = await store.select('pred_contracts', { select: 'contract_id,event_id,market_id,comparator,threshold_low,threshold_high,observation_start,detail', event_type: `eq.${CPI_EVENT_TYPE}`, normalization_status: 'eq.NORMALIZED', observation_end: `gte.${since}` });
  let runs = await store.select('pred_cpi_shadow_runs', { select: '*' }, { order: 'run_id.asc' });
  await step('forecast', async () => { const r = await forecastDue(store, { now, runs, contracts, firstSeenBls: bls, firstSeenEia: eia }); if (r.newRuns.length) runs = runs.concat(r.newRuns); const { newRuns: _n, ...rest } = r; return rest; });
  await step('contract_rows', async () => {
    const open = runs.filter((r) => r.status === 'OK' && Date.parse(now) < Date.parse(r.release_at));
    const existing = open.length ? await store.select('pred_forecasts_shadow', { select: 'record_id', model_id: `eq.${SHADOW_MODEL_ID}`, captured_at: `gte.${new Date(Date.parse(now) - 60 * 86400000).toISOString()}` }, { order: 'record_id.asc' }) : [];
    return contractRowsForOpenRuns(store, { now, runs: open, contracts, existing });
  });
  await step('grade', async () => gradeDue(store, mkt, { now, runs, grades: await store.select('pred_cpi_shadow_grades', { select: 'run_id' }, { order: 'run_id.asc' }), firstSeenBls: bls }));
  out.calendar = { version: CALENDAR_VERSION, horizon: calendarHorizon() };
  return out;
}

