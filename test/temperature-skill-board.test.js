// Members' temperature skill (issue #64): exhaustive ladders only, hits vs their own expectation, the same-time
// market favourite, and nothing blended with rain picks.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { assembleScorecard, MIN_SKILL_DAYS } from '../workers/pbe-predictions/src/results-board.js';

const LAD = [['less', null, 80, '79° or below'], ['between', 80, 81, '80° to 81°'], ['between', 82, 83, '82° to 83°'], ['greater', 83, null, '84° or above']];
function event(id, date, probs, win, { mids = null, official = null, nbm = 82, drop = null, quotes = [] } = {}) {
  const contracts = LAD.map(([comparator, lo, hi, label], i) => ({ contract_id: `${id}-${i}`, event_id: id, market_id: `M-${id}-${i}`, outcome_label: label, event_type: 'MAX_TEMP_BUCKET', station_id: 'CLIMDW', detail: { climate_date: date, city_label: 'Chicago' }, comparator, threshold_low: lo, threshold_high: hi }));
  const forecasts = contracts.map((c, i) => ({ forecast_id: `f-${c.contract_id}`, contract_id: c.contract_id, probability: probs[i], model_state: 'RESEARCH', captured_at: `${date}T05:00:00Z`, market_probability: mids ? mids[i] : null, market_snapshot_key: `k-${c.contract_id}`, confidence: 'HIGH', evidence: [{ label: 'National Blend of Models high', value: nbm }] }));
  const scores = contracts.filter((_, i) => i !== drop).map((c, i) => ({ forecast_id: `f-${c.contract_id}`, contract_id: c.contract_id, designation: 'FINAL_PRE_RESOLUTION', scoring_method: 'brier', outcome: LAD.findIndex((x) => x[3] === c.outcome_label) === win ? 1 : 0, scored_at: `${date}T12:00:00Z` }));
  return { contracts, forecasts, scores, events: [{ event_id: id, slug: `s-${id}`, canonical_question: `High ${id}?`, category: 'WEATHER' }], resolutions: contracts.map((c) => ({ contract_id: c.contract_id, official_value: official })), quotes: quotes.map((q, i) => (q ? { snapshot_key: `k-${id}-${i}`, ...q } : null)).filter(Boolean) };
}
const merge = (...es) => { const o = { contracts: [], forecasts: [], scores: [], events: [], resolutions: [], quotes: [] }; for (const e of es) for (const k of Object.keys(o)) o[k].push(...e[k]); return { ...o, ladders: o.contracts }; };

test('hits are set against their own expectation (sum of the favourite probabilities)', () => {
  const card = assembleScorecard(merge(event('A', '2026-10-04', [0.1, 0.5, 0.3, 0.1], 2, { official: 82 }), event('B', '2026-10-05', [0.1, 0.3, 0.4, 0.2], 2, { official: 83 })));
  const t = card.temperature_skill;
  assert.equal(t.events, 2); assert.equal(t.top_bucket.hits, 1); assert.ok(Math.abs(t.top_bucket.expected - 0.9) < 1e-9);
  assert.equal(card.top_outcome.events, 2); assert.equal(card.top_outcome.rows.find((r) => r.event_id === 'A').error_f, 0);
  assert.equal(t.by_city[0].city, 'Chicago'); assert.equal(t.by_city[0].nbm_bias_f, 0.5);
});

test('an incomplete ladder (one bucket unscored) never counts as an event win or miss', () => {
  const card = assembleScorecard(merge(event('A', '2026-10-04', [0.1, 0.5, 0.3, 0.1], 1, { drop: 3 })));
  assert.equal(card.top_outcome.events, 0); assert.equal(card.temperature_skill, null);
});

test('a ladder with a gap is excluded with its reason', () => {
  const e = event('A', '2026-10-04', [0.1, 0.5, 0.3, 0.1], 1); e.contracts[2].threshold_low = 83; // 82 uncovered
  const card = assembleScorecard({ ...merge(e) });
  assert.equal(card.top_outcome.events, 0);
});

test('market favourite uses the same-time quote; no-bid tails count at half their ask; wide quotes give no market', () => {
  const ok = event('A', '2026-10-04', [0.1, 0.5, 0.3, 0.1], 2, { mids: [null, 0.3, 0.6, null], quotes: [{ bid: null, ask: 0.02, market_status: 'active' }, null, null, { bid: null, ask: 0.01, market_status: 'active' }] });
  const t = assembleScorecard(merge(ok)).temperature_skill;
  assert.equal(t.market.market_hits, 1); assert.equal(t.market.pbe_hits, 0); assert.equal(t.market.events, 1);
  const row = assembleScorecard(merge(ok)).top_outcome.rows[0]; assert.equal(row.market_picked, '82° to 83°'); assert.equal(row.market_result, 'MATCHED');
  const wide = event('B', '2026-10-04', [0.1, 0.5, 0.3, 0.1], 2, { mids: [null, 0.3, 0.6, 0.05], quotes: [{ bid: 0.01, ask: 0.3, market_status: 'active' }] });
  assert.equal(assembleScorecard(merge(wide)).temperature_skill.market, null);
});

test('market verdict waits for enough independent days', () => {
  const few = merge(...Array.from({ length: 3 }, (_, i) => event(`E${i}`, `2026-10-0${i + 1}`, [0.1, 0.5, 0.3, 0.1], 2, { mids: [0.05, 0.2, 0.7, 0.05] })));
  assert.equal(assembleScorecard(few).temperature_skill.market.verdict_log_loss, 'TOO_FEW_DAYS');
  const many = merge(...Array.from({ length: MIN_SKILL_DAYS }, (_, i) => event(`E${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`, [0.1, 0.5, 0.3, 0.1], 2, { mids: [0.05, 0.2, 0.7, 0.05] })));
  assert.equal(assembleScorecard(many).temperature_skill.market.verdict_log_loss, 'MARKET_AHEAD');
});

test('members panel renders the expectation, the market favourite and the early-sample label', () => {
  const card = assembleScorecard(merge(...Array.from({ length: 3 }, (_, i) => event(`E${i}`, `2026-10-0${i + 1}`, [0.1, 0.5, 0.3, 0.1], i ? 2 : 1, { mids: [0.05, 0.2, 0.7, 0.05], official: 82 }))));
  const nodes = {}; const el = (id) => (nodes[id] ||= { id, innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, classList: { add() {}, remove() {}, toggle() {} }, closest: () => null, scrollIntoView() {} });
  const doc = { hidden: false, getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: { dataset: {}, classList: { add() {}, remove() {} } }, body: { classList: { add() {}, remove() {}, toggle() {} } } };
  const ctx = { window: { matchMedia: () => ({ matches: false }), addEventListener() {}, PBE_MEMBERSHIP: null }, document: doc, fetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' }), console: { error() {}, warn() {}, log() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} }, location: { search: '', hash: '', pathname: '/track-record/', replace() {} }, history: { replaceState() {} }, URLSearchParams, Intl, Date, Math, Promise, JSON };
  ctx.window.document = doc; vm.createContext(ctx);
  vm.runInContext(`${readFileSync('core.js', 'utf8')}\n${readFileSync('track-record.js', 'utf8')}\n;board = ${JSON.stringify(card)}; overview(board); ledger();`, ctx);
  const skill = nodes['rec-skill'].innerHTML;
  assert.match(skill, /Top bucket vs expectation/); assert.match(skill, /1\.5 expected from PBE/); assert.match(skill, /Market favourite, same moment/);
  assert.match(skill, /early: 3 of 10 days needed for a verdict/); assert.match(skill, /Chicago/);
  assert.match(nodes['results-overview'].innerHTML, /1\.5 expected from PBE/);
  assert.match(nodes['results-ledger'].innerHTML, /market favourite 82° to 83° \(70%\)/); assert.match(nodes['results-ledger'].innerHTML, /official 82°F · NBM guidance 82°F \(0\)/);
  assert.doesNotMatch(skill, /official pick|profit|ROI/i);
});

test('member route: ladders read NORMALIZED rows deduped by market, quote keys only for temperature, no ladder = excluded', async () => {
  const e = event('A', '2026-10-04', [0.1, 0.5, 0.3, 0.1], 1, { official: 81 });
  const calls = [];
  const rain = { forecast_id: 'f-rain', contract_id: 'rain-1', probability: 0.8, model_state: 'RESEARCH', captured_at: '2026-10-04T05:00:00Z', market_probability: null, market_snapshot_key: 'k-rain' };
  const store = {
    select: async (t) => (t === 'pred_scores' ? [...e.scores, { forecast_id: 'f-rain', contract_id: 'rain-1', designation: 'FINAL_PRE_RESOLUTION', scoring_method: 'brier', outcome: 1, scored_at: '2026-10-04T12:00:00Z' }] : []),
    selectIn: async (t, q, col, ids) => { calls.push({ t, q, col, ids });
      if (t === 'pred_contracts' && col === 'contract_id') return [...e.contracts.map(({ comparator, threshold_low, threshold_high, detail, ...c }) => ({ ...c, climate_date: detail.climate_date, city_label: detail.city_label })), { contract_id: 'rain-1', event_id: 'R', market_id: 'MR', outcome_label: 'Rain', event_type: 'PRECIP_ANY' }];
      if (t === 'pred_contracts' && col === 'event_id') return [...e.contracts.map((c) => ({ ...c, normalized_at: '2026-10-01' })), { ...e.contracts[1], contract_id: 'A-1-old', normalized_at: '2026-09-01' }];
      if (t === 'pred_forecasts') return [...e.forecasts, rain];
      if (t === 'pred_events') return e.events;
      if (t === 'pred_resolutions') return e.resolutions;
      return []; } };
  const { memberScorecard } = await import('../workers/pbe-predictions/src/results-board.js');
  const card = await memberScorecard(store, { fresh: true });
  const lad = calls.find((c) => c.t === 'pred_contracts' && c.col === 'event_id');
  assert.equal(lad.q.normalization_status, 'eq.NORMALIZED'); assert.deepEqual(lad.ids, ['A']);
  assert.equal(card.temperature_skill.events, 1, 'the superseded normalisation of one market does not break the ladder');
  const q = calls.find((c) => c.t === 'pred_venue_snapshots');
  assert.ok(!q || !q.ids.includes('k-rain'), 'rain forecasts never fetch temperature quotes');
  assert.match(calls.find((c) => c.t === 'pred_forecasts').q.select, /evidence:explanation->evidence/);
  // the same rows without any ladder rows: excluded, not counted on scored rows alone
  const bare = assembleScorecard({ ...merge(e), ladders: [], requireLadder: true });
  assert.equal(bare.top_outcome.events, 0);
});

test('ties: the favourite in the ledger and the skill block are the same bucket (lower bucket wins)', () => {
  const card = assembleScorecard(merge(event('T', '2026-10-04', [0.1, 0.4, 0.4, 0.1], 2)));
  assert.equal(card.top_outcome.rows[0].picked, '80° to 81°'); assert.equal(card.top_outcome.matched, card.temperature_skill.top_bucket.hits);
});
