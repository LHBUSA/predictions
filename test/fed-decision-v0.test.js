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
  assert.equal(snapshot.provenance[0].transform, '12m-percent-change');
  assert.equal(snapshot.provenance.length, 3);
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
