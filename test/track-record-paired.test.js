// track-record/2: PBE and market are only ever compared on the same contracts, lanes are never blended, and
// "enough to score" is never presented as evidence of an edge (issue #64).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { assembleTrackRecord, MIN_VERDICT_CLUSTERS } from '../workers/pbe-predictions/src/api.js';

const sc = (id, lane, date, score, bench, method = 'brier', designation = 'FINAL_PRE_RESOLUTION') => ({ contract_id: id, forecast_id: 'f-' + id, designation, scoring_method: method, score, benchmark_score: bench, outcome: 0, _c: { contract_id: id, event_id: 'e-' + date, event_type: lane, detail: { climate_date: date } } });
const build = (rows, opts = {}) => assembleTrackRecord({ scores: rows, contracts: rows.map((r) => r._c), ...opts });

test('the headline pairs PBE and market on the same contracts; PBE-over-all is reported separately', () => {
  // Two easy contracts with no market quote must not flatter PBE against the market.
  const rows = [sc('a', 'MAX_TEMP_BUCKET', '2026-10-04', 0.20, 0.10), sc('b', 'MAX_TEMP_BUCKET', '2026-10-04', 0.20, 0.10), sc('c', 'MAX_TEMP_BUCKET', '2026-10-04', 0.0, null), sc('d', 'MAX_TEMP_BUCKET', '2026-10-04', 0.0, null)];
  const g = build(rows).groups.find((x) => x.method === 'brier');
  assert.equal(g.n, 4); assert.equal(g.pbe_mean, 0.1); // all contracts
  assert.equal(g.market_n, 2); assert.equal(g.market_mean, 0.1); assert.equal(g.paired_pbe_mean, 0.2); // the fair comparison
});

test('lanes are separate; YIELD_PATH_* collapse into one Treasury lane; shadow forecasts excluded', () => {
  const rows = [sc('t', 'MAX_TEMP_BUCKET', 'd1', 0.3, 0.1), sc('r', 'PRECIP_ANY', 'd1', 0.05, 0.07), sc('y1', 'YIELD_PATH_MAX', null, 0.04, 0.02), sc('y2', 'YIELD_PATH_MIN', null, 0.06, null), sc('s', 'PRECIP_ANY', 'd1', 0.9, 0.0)];
  const r = build(rows, { shadowForecastIds: new Set(['f-s']) });
  assert.deepEqual(r.lanes.map((x) => x.lane), ['MAX_TEMP_BUCKET', 'PRECIP_ANY', 'TREASURY_YIELD_PATH']);
  assert.equal(r.lanes.find((x) => x.lane === 'PRECIP_ANY').brier.n, 1);
  assert.equal(r.lanes.find((x) => x.lane === 'TREASURY_YIELD_PATH').contracts, 2);
  assert.equal(r.resolved_contracts, 4);
  assert.equal(r.rules, 'track-record/2');
});

test('a verdict needs enough independent days and a CI that excludes zero', () => {
  const days = (n, pbe, mkt) => Array.from({ length: n }, (_, i) => sc(`c${n}-${i}`, 'MAX_TEMP_BUCKET', `2026-10-${String(i + 1).padStart(2, '0')}`, pbe + (i % 3) * 0.01, mkt));
  assert.equal(build(days(6, 0.15, 0.10)).lanes[0].brier.paired.verdict, 'TOO_FEW_DAYS');
  assert.equal(build(days(MIN_VERDICT_CLUSTERS, 0.15, 0.10)).lanes[0].brier.paired.verdict, 'MARKET_AHEAD');
  assert.equal(build(days(MIN_VERDICT_CLUSTERS, 0.05, 0.10)).lanes[0].brier.paired.verdict, 'PBE_AHEAD');
  const mixed = Array.from({ length: 12 }, (_, i) => sc(`m${i}`, 'PRECIP_ANY', `2026-11-${String(i + 1).padStart(2, '0')}`, i % 2 ? 0.2 : 0.0, 0.1));
  assert.equal(build(mixed).lanes[0].brier.paired.verdict, 'NOT_ESTABLISHED');
  // Many contracts on ONE day are one cluster, not many independent results.
  const oneDay = Array.from({ length: 40 }, (_, i) => sc(`o${i}`, 'MAX_TEMP_BUCKET', '2026-10-04', 0.2, 0.1));
  const p = build(oneDay).lanes[0].brier.paired; assert.equal(p.n, 40); assert.equal(p.clusters, 1); assert.equal(p.verdict, 'TOO_FEW_DAYS');
});

test('a lane with no market-priced contract has no paired block (never a fake comparison)', () => {
  const r = build([sc('x', 'PRECIP_ANY', 'd1', 0.1, null)]);
  assert.equal(r.lanes[0].brier.paired, null); assert.equal(r.lanes[0].brier.pbe_mean_all, 0.1);
});

// ---------- rendering: the page never shows the unpaired comparison or "Measurable" ----------
function renderRecord(payload) {
  const nodes = {};
  const el = (id) => (nodes[id] ||= { id, innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, closest: () => null });
  const doc = { hidden: false, getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: { dataset: {}, classList: { add() {}, remove() {} } }, body: { classList: { add() {}, remove() {}, toggle() {} } } };
  const ctx = { window: { matchMedia: () => ({ matches: false }), addEventListener() {}, PBE_MEMBERSHIP: null }, document: doc, fetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
    console: { error() {}, warn() {}, log() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '', pathname: '/track-record/', replace() {} }, history: { replaceState() {} }, URLSearchParams, Intl, Date, Math, Promise, JSON };
  ctx.window.document = doc; vm.createContext(ctx);
  vm.runInContext(`${readFileSync('core.js', 'utf8')}\n${readFileSync('track-record.js', 'utf8')}\n;globalThis.__scoring = scoring;`, ctx);
  ctx.__scoring(payload);
  return { tr: nodes.tr.innerHTML, lanes: nodes['tr-lanes'].innerHTML };
}

test('Track Record page: same-contract numbers, lane cards with ranges, no "Measurable"', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) { const d = `2026-10-0${i + 4}`; rows.push(sc(`t${i}`, 'MAX_TEMP_BUCKET', d, 0.15, 0.10), sc(`n${i}`, 'MAX_TEMP_BUCKET', d, 0.0, null), sc(`r${i}`, 'PRECIP_ANY', d, 0.07, 0.07)); }
  for (let i = 0; i < 30; i += 1) rows.push(sc(`z${i}`, 'PRECIP_ANY', '2026-10-04', 0.0, null));
  const { tr, lanes } = renderRecord(build(rows));
  assert.match(tr, /same contracts/); assert.match(tr, /market 0\.\d{3} on the same 12 contracts/); assert.match(tr, /on all 48/);
  assert.doesNotMatch(tr, /Measurable/); assert.match(tr, /None yet/); assert.match(tr, /not evidence of an edge/);
  assert.match(lanes, /Max temperature · pre-window/); assert.match(lanes, /Rain · any measurable/);
  assert.match(lanes, /6 days\/events/); assert.match(lanes, /Too few days for a verdict/); assert.match(lanes, /\[-?0\.\d{3}, -?0\.\d{3}\]/);
});

test('static page and generator carry the honest note and the lane container', () => {
  for (const p of ['track-record/index.html', 'scripts/brand/static-pages.py']) {
    const s = readFileSync(p, 'utf8');
    assert.match(s, /on the same contracts, at the same moment/); assert.match(s, /id="tr-lanes"/); assert.match(s, /resamples whole days/);
  }
});
