// Fed decision vertical on the REAL KXFEDDECISION-26OCT contract (captured 2026-10-03) and official FRED series.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeContract } from '../src/engine/contracts.js';
import { forecastFed, previousDecision } from '../src/macro/engine.js';
import { parseFredCsv, predictFed, outcomeOfChange, orderedProbabilities, fedFeatureVector } from '../src/macro/fed-model.js';
import { fedOfficialOutcome } from '../workers/pbe-predictions/src/cycle.js';
import fedArtifact from '../src/macro/artifacts/fed-v1.json' with { type: 'json' };
import registry from '../data/fomc/scheduled-decisions.json' with { type: 'json' };

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const fx = JSON.parse(read('./fixtures/kalshi/KXFEDDECISION-26OCT.json'));
const fred = Object.fromEntries(['DGS6MO', 'DFEDTARU', 'DFEDTARL', 'CPIAUCSL', 'CPILFESL', 'UNRATE', 'PAYEMS'].map((id) => [id, { url: `fred:${id}`, rows: parseFredCsv(read(`./fixtures/fred/${id}.csv`)) }]));
const NOW = '2026-10-03T18:30:00.000Z';
const norm = (suffix, patch = {}) => normalizeContract({ series: fx.series, event: fx.event, market: { ...fx.markets.find((m) => m.ticker.endsWith(suffix)), ...patch } }, { now: NOW });

test('all five October buckets normalize to exact outcomes on the official meeting date', async () => {
  const want = { '-C26': 'cut_gt_25', '-C25': 'cut_25', '-H0': 'hold', '-H25': 'hike_25', '-H26': 'hike_gt_25' };
  for (const [s, o] of Object.entries(want)) {
    const c = await norm(s);
    assert.equal(c.normalization_status, 'NORMALIZED', s);
    assert.equal(c.domain, 'MACRO');
    assert.equal(c.detail.outcome, o);
    assert.equal(c.detail.meeting_date, '2026-10-28');
    assert.equal(c.observation_start, '2026-10-28T18:00:00.000Z');
    assert.match(c.resolution_authority, /Federal Reserve/);
  }
});

test('garbled ">" in venue rules is recorded as an exception, not silently fixed', async () => {
  const c = await norm('-C26');
  assert.ok(c.exceptions.some((e) => /lost the ">" sign/.test(e)));
  const plain = await norm('-C25');
  assert.ok(!plain.exceptions.some((e) => /lost the/.test(e)));
});

test('fail closed: structured strike, title and rules must agree; meeting must be on the official calendar', async () => {
  assert.equal((await norm('-C25', { custom_strike: { Cut: '>25' } })).status_reason, 'TITLE_DISAGREES_WITH_STRIKE');
  assert.equal((await norm('-H25', { custom_strike: { Hike: '50' } })).status_reason, 'CUSTOM_STRIKE_UNRECOGNIZED');
  assert.equal((await norm('-H25', { rules_primary: fx.markets[3].rules_primary.replace('October 28', 'October 21') })).status_reason, 'MEETING_NOT_IN_OFFICIAL_CALENDAR');
  assert.equal((await norm('-H0', { rules_secondary: 'Resolves per the statement.' })).status_reason, 'FED_SECONDARY_RULES_CHANGED');
});

test('registry: 16/16 agreement with the curated decisions and Sept 2026 = +25', () => {
  assert.equal(registry.curated_agreement, '16/16');
  assert.equal(registry.meetings.find((m) => m.meetingDate === '2026-09-16').changeBps, 25);
  assert.ok(registry.meetings.some((m) => m.meetingDate === '2026-10-28'));
});

test('SHADOW forecast: one distribution over the five buckets, official inputs only, LOW confidence', async () => {
  let total = 0;
  for (const s of ['-C26', '-C25', '-H0', '-H25', '-H26']) {
    const c = await norm(s);
    const f = forecastFed(c, { fred }, { now: NOW });
    assert.equal(f.status, 'OK');
    assert.equal(f.model.state, 'SHADOW');
    assert.equal(f.confidence, 'LOW');
    assert.deepEqual(Object.keys(f.features).sort(), ['cmt6m_change_since_last_decision', 'cmt6m_minus_target_mid', 'horizon_days', 'previous_decision_direction']);
    assert.equal(JSON.stringify(f.features).match(/kalshi|market|bid|ask|volume/i), null);
    assert.equal(f.features.previous_decision_direction, 1);
    assert.equal(f.features.horizon_days, 25);
    total += f.rawProbability;
  }
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('only the next meeting is modeled; post-announcement forecasts are refused', async () => {
  const c = await norm('-H0');
  const dec = { ...c, detail: { ...c.detail, meeting_date: '2026-12-09' }, observation_start: '2026-12-09T19:00:00.000Z' };
  assert.equal(forecastFed(dec, { fred }, { now: NOW }).status, 'HORIZON_OUT_OF_RANGE');
  assert.equal(forecastFed(dec, { fred }, { now: '2026-11-20T12:00:00.000Z' }).status, 'NOT_NEXT_MEETING');
  assert.equal(forecastFed(c, { fred }, { now: '2026-10-28T18:00:00.000Z' }).status, 'WINDOW_STARTED');
  assert.deepEqual(previousDecision('2026-10-28', fred.DFEDTARU.rows, '2026-10-03'), { meetingDate: '2026-09-16', changeBps: 25 });
});

test('official FOMC outcome comes from the target-range series, bucketed exactly', async () => {
  const hold = await norm('-H0'); const hike = await norm('-H25');
  const rows = [['2026-10-27', 4.0], ['2026-10-29', 4.25], ['2026-10-30', 4.25]];
  assert.equal(fedOfficialOutcome(hike, rows).outcome, 'YES');
  assert.equal(fedOfficialOutcome(hold, rows).outcome, 'NO');
  assert.equal(fedOfficialOutcome(hold, [['2026-10-27', 4.0], ['2026-10-30', 4.0]]).outcome, 'YES');
  assert.equal(fedOfficialOutcome(hold, [['2026-10-27', 4.0]]), null); // not yet observed
});

test('model mechanics: ordered buckets, honest holdout recorded in the artifact', () => {
  assert.equal(outcomeOfChange(-50), 'cut_gt_25');
  assert.equal(outcomeOfChange(75), 'hike_gt_25');
  const p = orderedProbabilities(fedArtifact.params, fedFeatureVector({ d6: 0, c6: 0, prev: 0, horizonDays: 7 }));
  assert.ok(p.indexOf(Math.max(...p)) === 2, 'flat curve after a hold favors hold');
  const d = predictFed(fedArtifact, { d6: 0, c6: 0, prev: 0, horizonDays: 7 });
  assert.ok(Math.abs(Object.values(d).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(fedArtifact.holdout.metrics.model.log_loss < fedArtifact.holdout.metrics.climatology.log_loss);
  assert.ok(fedArtifact.holdout.metrics.model.top_outcome_accuracy < fedArtifact.holdout.metrics.climatology.top_outcome_accuracy, 'documented weakness: keep SHADOW + LOW');
});
