// CPI V1 PRIVATE SHADOW lane (owner approval 2026-10-07). The frozen artifact is used as frozen; inputs are the
// point-in-time view at the T-1D cutoff; KXCPICORE never gets a forecast; the 2026-10/11 y/y lanes are NO_FORECAST;
// nothing reaches pred_forecasts; market prices never enter the model; weather shadow reporting ignores CPI rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeContract } from '../src/engine/contracts.js';
import { MarketLeakageError } from '../src/engine/leakage.js';
import { eiaAvailableAt } from '../src/macro/cpi/asof.js';
import { KNOWN_INPUT_GAPS, releaseFor, RELEASE_DATES } from '../src/macro/cpi/calendar.js';
import { eventProbability } from '../src/macro/cpi/contracts.js';
import { buildFeatures } from '../src/macro/cpi/features.js';
import { predictFromArtifact } from '../src/macro/cpi/artifact.js';
import { addMonths } from '../src/macro/cpi/timeline.js';
import { ARTIFACT_SHA256, BLS_LEDGER_SHA256, SHADOW_TARGETS, assertShadowArtifact, buildShadowRun, contractProbabilities, distributionOf, gradeRun } from '../src/macro/cpi/shadow.js';
import { runCpiShadow, dueRuns, captureBls, cpiShadowDue, LANE_START } from '../workers/pbe-predictions/src/cpi-shadow.js';
import { summarize } from '../workers/pbe-predictions/src/cpi-shadow-report.js';
import { shadowCompareReport } from '../workers/pbe-predictions/src/intraday-scoring.js';

const root = new URL('../', import.meta.url);
const bytes = (p) => readFileSync(new URL(p, root));
const json = (p) => JSON.parse(bytes(p));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const artifact = json('src/macro/artifacts/cpi-v1.json');
const ledger = json('data/cpi/bls-cpi-releases-v1.json').releases;
const gas = json('data/cpi/eia-gasoline-weekly-v1.json').weeks;
const dataset = json('data/cpi/cpi-v1-dataset.json').observations.filter((o) => o.horizon === 'T-1D');
const kalshi = json('test/fixtures/cpi/kalshi-cpi-events-2026-10-07.json');

const SEP = releaseFor('2026-09');
const fsEia = (observedAt) => gas.map((w) => ({ first_seen_id: `eia-${w.date}`, period: w.date, value: w.price, observed_at: observedAt ?? eiaAvailableAt(w.date) }));
// A synthetic first-seen release for month M (test only): the previous vintage shifted one month, M's values set.
function syntheticRelease(month, releaseAt, { headline = 0.3, core = 0.2, food = 0.1, energy = 1.0, h12 = 3.5, c12 = 2.5 } = {}) {
  const prev = ledger.at(-1);
  const series = {};
  for (const [k, v] of Object.entries({ headline, core, food, energy })) {
    const sa = {}; for (const [m, x] of Object.entries(prev.series[k].saMoM)) sa[m] = x; sa[month] = v;
    series[k] = { saMoM: sa, nsa12m: k === 'headline' ? h12 : k === 'core' ? c12 : prev.series[k].nsa12m };
  }
  return { id: `bls-cpi:${month}`, referenceMonth: month, releaseDate: releaseAt.slice(0, 10), releaseAt, series };
}

test('frozen identities: artifact + bundled ledger hashes, approved targets only (core m/m excluded)', () => {
  assert.equal(sha(bytes('src/macro/artifacts/cpi-v1.json')), ARTIFACT_SHA256);
  assert.equal(sha(bytes('data/cpi/bls-cpi-releases-v1.json')), BLS_LEDGER_SHA256);
  assertShadowArtifact(artifact);
  assert.deepEqual([...SHADOW_TARGETS].sort(), ['core_yoy', 'headline_mom', 'headline_yoy']);
  assert.equal(artifact.targets.core_mom.shadowEligible, false);
  assert.throws(() => buildShadowRun({ artifact, target: 'core_mom', release: SEP, ledger, firstSeenBls: [], firstSeenEia: fsEia(), now: SEP.cutoffAt }), /not approved/);
  for (const m of Object.keys(RELEASE_DATES)) assert.ok(dueRuns({ now: '2027-06-01T00:00:00.000Z', runs: [] }).every((d) => d.target !== 'core_mom'), m);
});

test('calendar cutoff = the training T-1D cutoff (20:00 ET the day before the 08:30 ET release)', () => {
  const aug = dataset.find((o) => o.referenceMonth === '2026-08');
  const r = releaseFor('2026-08');
  assert.equal(r.cutoffAt, aug.cutoffAt);
  assert.equal(r.releaseAt, aug.releaseAt);
  assert.equal(SEP.cutoffAt, '2026-10-14T00:00:00.000Z');
  assert.equal(SEP.releaseAt, '2026-10-14T12:30:00.000Z');
  assert.equal(cpiShadowDue('2026-10-14T00:09:00.000Z'), true);
  assert.equal(cpiShadowDue('2026-10-14T00:10:00.000Z'), false);
});

test('runtime view reproduces the training features and the frozen prediction (first-seen rows at the EIA rule)', () => {
  const eia = fsEia();
  let n = 0;
  for (const o of dataset.filter((x) => x.referenceMonth >= '2023-01' && x.referenceMonth <= '2025-09')) {
    for (const target of SHADOW_TARGETS) {
      const r = buildShadowRun({ artifact, target, release: { referenceMonth: o.referenceMonth, releaseAt: o.releaseAt, cutoffAt: o.cutoffAt }, ledger, firstSeenBls: [], firstSeenEia: eia, now: o.cutoffAt });
      assert.equal(r.status, 'OK', `${o.referenceMonth} ${target}`);
      for (const [k, v] of Object.entries(r.features)) assert.equal(v, o.features[k], `${o.referenceMonth} ${target} ${k}`);
      const p = predictFromArtifact(artifact, target, o.features);
      assert.equal(r.location, p.location);
      assert.deepEqual(r.distribution.mass, p.distribution.mass);
      n += 1;
    }
  }
  assert.ok(n >= 90, `${n} runs`);
});

test('KNOWN GAP: 2026-10 and 2026-11 y/y are NO_FORECAST / INPUT_UNAVAILABLE; monthly headline still forecasts', () => {
  assert.deepEqual(KNOWN_INPUT_GAPS[0].referenceMonths, ['2026-10', '2026-11']);
  const firstSeenBls = [
    { first_seen_id: 'b9', period: '2026-09', observed_at: '2026-10-14T12:31:00.000Z', payload: syntheticRelease('2026-09', SEP.releaseAt) },
    { first_seen_id: 'b10', period: '2026-10', observed_at: '2026-11-10T13:31:00.000Z', payload: { ...syntheticRelease('2026-10', releaseFor('2026-10').releaseAt), series: (() => { const s = syntheticRelease('2026-09', SEP.releaseAt).series; const o = {}; for (const [k, v] of Object.entries(s)) o[k] = { ...v, saMoM: { ...v.saMoM, '2026-10': 0.2 } }; return o; })() } },
  ];
  const eia = fsEia('2026-10-08T00:00:00.000Z').concat(['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'].map((d) => ({ period: d, value: 3.1, observed_at: eiaAvailableAt(d) })));
  for (const month of ['2026-10', '2026-11']) {
    const rel = releaseFor(month);
    for (const target of ['headline_yoy', 'core_yoy']) {
      const r = buildShadowRun({ artifact, target, release: rel, ledger, firstSeenBls, firstSeenEia: eia, now: rel.cutoffAt });
      assert.equal(r.status, 'NO_FORECAST'); assert.equal(r.reason, 'INPUT_UNAVAILABLE');
      assert.equal(r.distribution, null); assert.equal(r.median, null); assert.deepEqual(r.contracts, []);
    }
    // the data agree with the hard-coded table: the M-12 base first print does not exist
    const f = buildFeatures({ releases: ledger, gasWeeks: [], referenceMonth: month, cutoffAt: rel.cutoffAt, names: ['H_BASE', 'C_BASE'] });
    assert.deepEqual(Object.keys(f.missing).sort(), ['C_BASE', 'H_BASE']);
    assert.match(f.missing.H_BASE, new RegExp(addMonths(month, -12)));
  }
  const oct = releaseFor('2026-10');
  const h = buildShadowRun({ artifact, target: 'headline_mom', release: oct, ledger, firstSeenBls, firstSeenEia: eia, now: oct.cutoffAt });
  assert.equal(h.status, 'OK');
});

test('point in time: inputs first seen after the cutoff are invisible; a run after the release is never created', () => {
  // EIA first seen only after the cutoff -> the gasoline feature is missing -> NO_FORECAST, never a default
  const late = buildShadowRun({ artifact, target: 'headline_mom', release: SEP, ledger, firstSeenBls: [], firstSeenEia: fsEia('2026-10-14T00:30:00.000Z'), now: '2026-10-14T00:40:00.000Z' });
  assert.equal(late.status, 'NO_FORECAST'); assert.equal(late.reason, 'INPUT_UNAVAILABLE'); assert.ok(late.detail.missing.GAS_SA);
  const ok = buildShadowRun({ artifact, target: 'headline_mom', release: SEP, ledger, firstSeenBls: [], firstSeenEia: fsEia('2026-10-08T00:00:00.000Z'), now: '2026-10-14T00:09:00.000Z' });
  assert.equal(ok.status, 'OK');
  assert.ok(ok.inputs_observed_at.eia.latest_observed_at <= SEP.cutoffAt);
  const missed = buildShadowRun({ artifact, target: 'headline_mom', release: SEP, ledger, firstSeenBls: [], firstSeenEia: fsEia(), now: SEP.releaseAt });
  assert.equal(missed.status, 'NO_FORECAST'); assert.equal(missed.reason, 'RUNTIME_MISSED_WINDOW'); assert.equal(missed.distribution, null);
  assert.throws(() => buildShadowRun({ artifact, target: 'headline_mom', release: SEP, ledger, firstSeenBls: [], firstSeenEia: fsEia(), now: '2026-10-13T23:59:00.000Z' }), /after its cutoff/);
  // a first-seen BLS release that disagrees with the archived ledger is refused
  const bad = { first_seen_id: 'x', period: '2026-08', observed_at: '2026-09-11T13:00:00.000Z', payload: { ...ledger.at(-1), series: { ...ledger.at(-1).series, headline: { saMoM: { '2026-08': 9.9 }, nsa12m: 3.4 } } } };
  assert.throws(() => buildShadowRun({ artifact, target: 'headline_mom', release: SEP, ledger, firstSeenBls: [bad], firstSeenEia: fsEia(), now: SEP.cutoffAt }), /disagrees with the archived ledger/);
});

test('contract adapter: terms only; a price field anywhere refuses the contract; probabilities = frozen distribution', async () => {
  const ev = kalshi.series.KXCPI.event;
  const contracts = await Promise.all(ev.markets.map((m) => normalizeContract({ series: { ticker: 'KXCPI' }, event: ev, market: m }, { now: '2026-10-07T00:00:00.000Z' })));
  assert.ok(contracts.every((c) => c.normalization_status === 'NORMALIZED' && c.event_type === 'CPI_PRINT_THRESHOLD'));
  const run = buildShadowRun({ artifact, target: 'headline_mom', release: SEP, ledger, firstSeenBls: [], firstSeenEia: fsEia('2026-10-08T00:00:00.000Z'), contracts, now: SEP.cutoffAt });
  const dist = distributionOf(run);
  for (const c of run.contracts) assert.equal(c.probability, eventProbability(dist, c.event));
  assert.equal(run.contracts.length, contracts.length);
  assert.throws(() => contractProbabilities(dist, 'headline_mom', '2026-09', [{ ...contracts[0], yes_bid: 0.4 }]), MarketLeakageError);
  // a YoY contract never prices off the monthly distribution
  assert.deepEqual(contractProbabilities(dist, 'headline_mom', '2026-09', [{ ...contracts[0], market_id: 'KXCPIYOY-26SEP-T3.0' }]), []);
});

test('normalizer fails closed when the rules, ticker and strike fields disagree', async () => {
  const ev = kalshi.series.KXCPIYOY.event; const m = ev.markets[0];
  const norm = (mm) => normalizeContract({ series: { ticker: 'KXCPIYOY' }, event: ev, market: mm }, { now: '2026-10-07T00:00:00.000Z' });
  assert.equal((await norm(m)).normalization_status, 'NORMALIZED');
  assert.equal((await norm({ ...m, rules_primary: m.rules_primary.replace('September 2026', 'August 2026') })).status_reason, 'RULES_MONTH_DISAGREES_WITH_TICKER');
  assert.equal((await norm({ ...m, floor_strike: 3.1 })).status_reason, 'STRIKE_FIELDS_DISAGREE_WITH_RULES');
  assert.equal((await norm({ ...m, strike_type: 'less' })).status_reason, 'STRIKE_TYPE_NOT_GREATER');
  assert.equal((await norm({ ...m, rules_primary: m.rules_primary.replace('Consumer Price Index (CPI)', 'Consumer Price Index (CPI) for All Urban Consumers: All Items less Food and Energy') })).status_reason, 'RULES_DISAGREE_WITH_SERIES');
  const core = kalshi.series.KXCPICORE.event;
  const c = await normalizeContract({ series: { ticker: 'KXCPICORE' }, event: core, market: core.markets[0] }, { now: '2026-10-07T00:00:00.000Z' });
  assert.equal(c.detail.cpi_target, 'core_mom');
});

// ------------------------------------------------------------------ lane harness
function memStore(seed = {}) {
  const t = { ...Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]])) };
  const writes = [];
  const tab = (n) => (t[n] ||= []);
  const match = (row, q) => Object.entries(q).every(([k, v]) => {
    if (k === 'select') return true;
    const val = k.includes('->>') ? row[k.split('->>')[0]]?.[k.split('->>')[1]] : row[k];
    const [op, ...rest] = String(v).split('.'); const arg = rest.join('.');
    if (op === 'eq') return String(val) === arg;
    if (op === 'gte') return String(val) >= arg;
    if (op === 'lte') return String(val) <= arg;
    if (op === 'in') return arg.slice(1, -1).split(',').map((x) => x.replace(/^"|"$/g, '')).includes(String(val));
    throw new Error(`op ${op}`);
  });
  const keyOf = (table, conflict, r) => conflict.split(',').map((c) => r[c]).join('|');
  const store = {
    tables: t, writes,
    select: async (table, q = {}) => tab(table).filter((r) => match(r, q)).map((r) => ({ ...r })),
    selectIn: async (table, q, col, ids) => tab(table).filter((r) => match(r, q) && ids.includes(col.includes('->>') ? r[col.split('->>')[0]]?.[col.split('->>')[1]] : r[col])),
    insertMany: async (table, rows, conflict) => { writes.push(table); const have = new Set(tab(table).map((r) => keyOf(table, conflict, r))); for (const r of rows) { const k = keyOf(table, conflict, r); if (!have.has(k)) { have.add(k); tab(table).push({ first_seen_id: table === 'pred_macro_first_seen' ? `fs-${tab(table).length}` : undefined, ...r }); } } },
    upsertEventRow: async (row) => { writes.push('pred_events'); const i = tab('pred_events').findIndex((e) => e.event_id === row.event_id); if (i >= 0) tab('pred_events')[i] = row; else tab('pred_events').push(row); },
    insertContracts: async (rows) => store.insertMany('pred_contracts', rows, 'contract_id'),
    insertVenueSnapshots: async (rows) => store.insertMany('pred_venue_snapshots', rows, 'snapshot_key'),
  };
  return store;
}
const fakeMkt = (settled = new Map()) => ({
  series: async (s) => ({ ticker: s, title: s, category: 'Economics' }),
  openEvents: async (s) => ({ events: [kalshi.series[s].event] }),
  marketsByTicker: async (tickers) => tickers.map((tk) => settled.get(tk)).filter(Boolean),
});
const eiaHtml = (weeks) => weeks.map((w) => { const [y, m, d] = w.date.split('-'); const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]; return `<tr><td class='B6'>&nbsp;&nbsp;${y}-${mon}</td><td class='B5'>${m}/${d}&nbsp;</td><td class='B3'>${w.price.toFixed(3)}&nbsp;</td></tr>`; }).join('\n');
const fakeFetch = ({ blsHtml = '<html>not yet</html>' } = {}) => async (url) => ({ ok: true, status: 200, text: async () => (/eia\.gov/.test(url) ? eiaHtml(gas) : blsHtml) });
const ALLOWED = new Set(['pred_macro_first_seen', 'pred_events', 'pred_contracts', 'pred_venue_snapshots', 'pred_cpi_shadow_runs', 'pred_forecasts_shadow', 'pred_cpi_shadow_grades']);

test('LANE: seeds EIA first seen, ingests contracts, freezes one run per approved target, writes only SHADOW tables', async () => {
  const store = memStore();
  const mkt = fakeMkt();
  const r0 = await runCpiShadow({ store, mkt, fetchImpl: fakeFetch(), now: '2026-10-08T02:09:00.000Z' });
  assert.deepEqual(r0.errors, []);
  assert.equal(r0.eia.new_rows, gas.length);
  assert.equal(store.tables.pred_macro_first_seen.length, gas.length);
  assert.ok(store.tables.pred_events.every((e) => e.model_state === 'MARKET_MONITORING' && e.model_family === null));
  assert.equal(store.tables.pred_contracts.filter((c) => c.normalization_status === 'NORMALIZED').length, 19);
  assert.equal(r0.forecast.runs_written, 0); // before the first cutoff
  // after the 2026-09 cutoff: three OK runs, contract rows for KXCPI/KXCPIYOY/KXCPICOREYOY only
  const r1 = await runCpiShadow({ store, mkt, fetchImpl: fakeFetch(), now: '2026-10-14T00:09:00.000Z' });
  assert.deepEqual(r1.errors, []);
  assert.equal(r1.forecast.ok, 3);
  const runs = store.tables.pred_cpi_shadow_runs;
  assert.deepEqual(runs.map((r) => r.target).sort(), ['core_yoy', 'headline_mom', 'headline_yoy']);
  assert.ok(runs.every((r) => r.model_version === 'cpi-v1/1.0.0' && r.feature_version === 'cpi-features/1' && r.public === false && r.model_state === 'SHADOW' && r.artifact_sha256 === ARTIFACT_SHA256));
  const rows = store.tables.pred_forecasts_shadow;
  assert.equal(rows.length, 15);
  assert.ok(rows.every((x) => !/^KXCPICORE-/.test(x.market_id) && x.model_id === 'pbe-cpi-distribution' && x.public === false && x.market_probability === undefined && x.station_id === null));
  assert.ok(rows.every((x) => x.data_cutoff_at <= x.captured_at && x.captured_at < x.metadata.release_at));
  assert.ok(store.writes.every((w) => ALLOWED.has(w)), [...new Set(store.writes)].join(','));
  assert.ok(!store.writes.includes('pred_forecasts') && !store.writes.includes('pred_feature_snapshots'));
  // idempotent: a rerun before the release adds no run and no row; a contract listed later is priced from the SAME frozen run
  const before = JSON.stringify(runs);
  kalshi.series.KXCPI.event.markets.push({ ...kalshi.series.KXCPI.event.markets[1], ticker: 'KXCPI-26SEP-T0.3', floor_strike: 0.3, rules_primary: kalshi.series.KXCPI.event.markets[1].rules_primary.replace('-0.1%', '0.3%') });
  try {
    await runCpiShadow({ store, mkt, fetchImpl: fakeFetch(), now: '2026-10-14T06:39:00.000Z' });
  } finally { kalshi.series.KXCPI.event.markets.pop(); }
  assert.equal(JSON.stringify(store.tables.pred_cpi_shadow_runs), before);
  const late = store.tables.pred_forecasts_shadow.find((x) => x.market_id === 'KXCPI-26SEP-T0.3');
  const run = runs.find((r) => r.target === 'headline_mom');
  assert.equal(late.raw_probability, distributionOf(run).probAbove(0.3));
  assert.equal(late.metadata.frozen_at, run.forecast_created_at);
});

test('LANE: after the release no forecast is created; grading uses the first-seen BLS value; Kalshi only cross-checks', async () => {
  const store = memStore();
  const mkt = fakeMkt();
  await runCpiShadow({ store, mkt, fetchImpl: fakeFetch(), now: '2026-10-10T15:09:00.000Z' }); // EIA first seen before the cutoff
  await runCpiShadow({ store, mkt, fetchImpl: fakeFetch(), now: '2026-10-14T00:09:00.000Z' });
  assert.equal(store.tables.pred_cpi_shadow_runs.filter((r) => r.status === 'OK').length, 3);
  // the BLS page still shows the August release at 12:39Z -> not captured (fail closed), nothing graded
  const aug = bytes('test/fixtures/cpi/bls-cpi-nr0-2026-09-11.htm').toString('utf8');
  const r1 = await captureBls(store, { fetchImpl: fakeFetch({ blsHtml: aug }), now: '2026-10-14T12:39:00.000Z', firstSeenBls: [] });
  assert.equal(r1.captured, false); assert.equal(r1.month, '2026-09');
  // simulate the first-seen 2026-09 release and grade
  const rel = syntheticRelease('2026-09', SEP.releaseAt, { headline: 0.4, h12: 3.6, c12: 2.5 });
  store.tables.pred_macro_first_seen.push({ first_seen_id: 'bls-2026-09', source: 'BLS', series: 'CPI-U Table A', period: '2026-09', value: 0.4, payload: rel, observed_at: '2026-10-14T12:39:00.000Z' });
  const settled = new Map(store.tables.pred_forecasts_shadow.map((x) => [x.market_id, { ticker: x.market_id, result: x.metadata.cpi_target === 'headline_mom' ? (0.4 > x.explanation.event.threshold ? 'yes' : 'no') : 'no', expiration_value: '0.4' }]));
  const r2 = await runCpiShadow({ store, mkt: fakeMkt(settled), fetchImpl: fakeFetch(), now: '2026-10-14T12:39:00.000Z' });
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.grade.graded, 3);
  const g = store.tables.pred_cpi_shadow_grades.find((x) => x.run_id.includes('headline_mom'));
  assert.equal(g.actual_value, 0.4);
  assert.equal(g.kalshi_cross_check.all_agree, true);
  const run = store.tables.pred_cpi_shadow_runs.find((r) => r.target === 'headline_mom');
  const direct = gradeRun(run, store.tables.pred_macro_first_seen.find((x) => x.first_seen_id === 'bls-2026-09'), { now: g.graded_at });
  assert.equal(g.scores.brier, direct.scores.brier);
  // a later pass never adds runs for a released month, and never regrades
  const n = store.tables.pred_cpi_shadow_runs.length;
  await runCpiShadow({ store, mkt, fetchImpl: fakeFetch(), now: '2026-10-15T00:09:00.000Z' });
  assert.equal(store.tables.pred_cpi_shadow_runs.length, n);
  assert.equal(store.tables.pred_cpi_shadow_grades.length, 3);
  const rep = summarize(store.tables.pred_cpi_shadow_runs, store.tables.pred_cpi_shadow_grades, { now: '2026-10-15T00:00:00.000Z' });
  assert.equal(rep.by_target.headline_mom.prospective_observations, 1);
  assert.equal(rep.public, false);
  assert.ok(!JSON.stringify(rep).match(/yes_bid|market_probability|last_price/));
});

test('LANE: a release missed by the runtime is recorded once as RUNTIME_MISSED_WINDOW, never back-filled', async () => {
  const store = memStore();
  await runCpiShadow({ store, mkt: fakeMkt(), fetchImpl: fakeFetch(), now: '2026-10-14T13:09:00.000Z' });
  const runs = store.tables.pred_cpi_shadow_runs;
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.status === 'NO_FORECAST' && r.reason === 'RUNTIME_MISSED_WINDOW'));
  assert.equal((store.tables.pred_forecasts_shadow || []).length, 0);
  assert.ok(Date.parse(releaseFor('2026-09').cutoffAt) >= Date.parse(LANE_START));
});

test('weather v2.2 shadow-compare reads only weather rows (CPI rows in the same table are excluded)', async () => {
  const queries = [];
  const store = { select: async (t, q) => { queries.push([t, q]); return []; }, selectIn: async () => [] };
  const r = await shadowCompareReport(store, { evaluate: () => null });
  assert.equal(r.shadow_rows, 0);
  assert.equal(queries[0][0], 'pred_forecasts_shadow');
  assert.equal(queries[0][1].model_id, 'eq.pbe-weather-maxtemp-intraday');
});
