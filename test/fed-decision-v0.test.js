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
    observations: values.map((value, i) => ({ date: `2026-0${9 - i}-01`, value }))
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

test('feature builder preserves dates and computes 3-month unemployment change', () => {
  const snapshot = buildFedFeatureSnapshot({
    coreInflation: series('CORE', [2.8]),
    headlineInflation: series('HEAD', [2.4]),
    unemployment: series('UNRATE', [4.4, 4.3, 4.2, 4.1]),
    capturedAt: '2026-09-16T15:00:00Z'
  });
  assert.equal(snapshot.features.unemploymentChange3m, 0.3);
  assert.equal(snapshot.features.coreInflationYoY, 2.8);
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
