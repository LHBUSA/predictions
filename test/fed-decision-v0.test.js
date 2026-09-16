import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFedFeatureSnapshot } from '../src/features/fed-features.js';
import {
  FED_DECISION_MODEL,
  buildFedPredictionSnapshots,
  classifyFedContract,
  fedDecisionProbabilities
} from '../src/models/fed-decision-v0.js';

function series(seriesId, values) {
  return {
    provider: 'fred',
    seriesId,
    observations: values.map((value, i) => ({
      date: new Date(Date.UTC(2026, 8 - i, 1)).toISOString().slice(0, 10),
      value
    }))
  };
}

function datedSeries(seriesId, rows) {
  return {
    provider: 'fred',
    seriesId,
    observations: rows.map(([date, value]) => ({ date, value }))
  };
}

test('Fed probabilities sum to one', () => {
  const result = fedDecisionProbabilities({
    coreInflationYoY: 2.8,
    headlineInflationYoY: 2.4,
    unemploymentRate: 4.3,
    unemploymentChange3m: 0.1
  });
  const total = Object.values(result.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.equal(result.modelVersion, FED_DECISION_MODEL.version);
});

test('classifies common Fed market titles', () => {
  assert.equal(classifyFedContract('Fed to cut rates by 25 bps?'), 'cut_25');
  assert.equal(classifyFedContract('Fed to hold rates unchanged?'), 'hold');
  assert.equal(classifyFedContract('Fed to hike rates by 25 bps?'), 'hike_25');
  assert.equal(classifyFedContract('Fed to hike rates by more than 25 bps?'), 'hike_gt_25');
});

test('feature builder converts vintage CPI index levels to YoY inflation and computes labor momentum', () => {
  const headline = [310.0,309.6,309.1,308.7,308.1,307.8,307.4,307.0,306.5,306.1,305.7,305.2,302.7];
  const core = [315.0,314.5,314.0,313.6,313.1,312.7,312.3,311.8,311.4,311.0,310.6,310.1,306.4];
  const snapshot = buildFedFeatureSnapshot({
    coreInflation: series('CPILFESL', core),
    headlineInflation: series('CPIAUCSL', headline),
    unemployment: series('UNRATE', [4.4, 4.3, 4.2, 4.1]),
    capturedAt: '2026-09-16T15:00:00Z'
  });
  assert.ok(Math.abs(snapshot.features.unemploymentChange3m - 0.3) < 1e-12);
  assert.ok(Math.abs(snapshot.features.headlineInflationYoY - ((310 / 302.7 - 1) * 100)) < 1e-12);
  assert.ok(Math.abs(snapshot.features.coreInflationYoY - ((315 / 306.4 - 1) * 100)) < 1e-12);
  assert.equal(snapshot.provenance[0].transform, 'calendar-12m-percent-change');
  assert.equal(snapshot.provenance.length, 3);
});

test('YoY inflation matches the same calendar month even when an intermediate release month is missing', () => {
  const headline = datedSeries('CPIAUCSL', [
    ['2025-12-01', 330],
    ['2025-11-01', 329],
    ['2025-09-01', 327],
    ['2025-08-01', 326],
    ['2025-07-01', 325],
    ['2025-06-01', 324],
    ['2025-05-01', 323],
    ['2025-04-01', 322],
    ['2025-03-01', 321],
    ['2025-02-01', 320],
    ['2025-01-01', 319],
    ['2024-12-01', 318]
  ]);
  const core = datedSeries('CPILFESL', [
    ['2025-12-01', 340],
    ['2025-11-01', 339],
    ['2025-09-01', 337],
    ['2025-08-01', 336],
    ['2025-07-01', 335],
    ['2025-06-01', 334],
    ['2025-05-01', 333],
    ['2025-04-01', 332],
    ['2025-03-01', 331],
    ['2025-02-01', 330],
    ['2025-01-01', 329],
    ['2024-12-01', 328]
  ]);
  const unemployment = datedSeries('UNRATE', [
    ['2025-12-01', 4.4],
    ['2025-11-01', 4.3],
    ['2025-10-01', 4.2],
    ['2025-09-01', 4.1]
  ]);
  const snapshot = buildFedFeatureSnapshot({ coreInflation: core, headlineInflation: headline, unemployment });
  assert.ok(Math.abs(snapshot.features.headlineInflationYoY - ((330 / 318 - 1) * 100)) < 1e-12);
  assert.ok(Math.abs(snapshot.features.coreInflationYoY - ((340 / 328 - 1) * 100)) < 1e-12);
});

test('builds prediction snapshots with explicit market/model separation', () => {
  const snapshots = buildFedPredictionSnapshots({
    eventId: 'fed-2026-09',
    capturedAt: '2026-09-16T15:00:00Z',
    features: {
      coreInflationYoY: 2.8,
      headlineInflationYoY: 2.4,
      unemploymentRate: 4.3,
      unemploymentChange3m: 0.1
    },
    markets: [{
      venue: 'kalshi',
      marketId: 'FED-HOLD',
      title: 'Fed to hold rates unchanged?',
      impliedProbability: 0.61
    }]
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].marketProbability, 0.61);
  assert.notEqual(snapshots[0].modelProbability, snapshots[0].marketProbability);
  assert.equal(snapshots[0].metadata.modelStatus, 'research');
});
