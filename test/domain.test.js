import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalEvent, createPredictionSnapshot, probabilityGap } from '../src/domain.js';
import { brierScore, scoreSnapshot } from '../src/scoring.js';

const event = createCanonicalEvent({
  id: 'cpi-2026-10',
  title: 'October CPI above 3.0%',
  category: 'macro',
  resolutionRule: 'YES if the official BLS CPI release reports YoY CPI above 3.0%.',
  resolutionSource: 'BLS'
});

test('canonical event requires explicit resolution metadata', () => {
  assert.equal(event.category, 'macro');
  assert.equal(event.resolutionSource, 'BLS');
});

test('prediction snapshot keeps model and market probabilities separate', () => {
  const snapshot = createPredictionSnapshot({
    id: 'snap-1',
    eventId: event.id,
    modelId: 'macro-baseline',
    modelVersion: '0.1.0',
    capturedAt: '2026-09-16T10:00:00Z',
    modelProbability: 0.58,
    marketProbability: 0.44
  });
  assert.ok(Math.abs(probabilityGap(snapshot) - 0.14) < 1e-12);
});

test('Brier score and comparative scoring work', () => {
  assert.ok(Math.abs(brierScore(0.8, 1) - 0.04) < 1e-12);
  const result = scoreSnapshot({
    id: 'snap-2',
    eventId: event.id,
    modelProbability: 0.8,
    marketProbability: 0.6
  }, 1);
  assert.ok(result.modelBrier < result.marketBrier);
});
