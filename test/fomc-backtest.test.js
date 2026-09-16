import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRateChangeBps, runFomcBacktest, scoreCategoricalForecast } from '../src/backtest/fomc.js';
import { calibrationBins, expectedCalibrationError } from '../src/backtest/calibration.js';

test('classifies FOMC rate changes', () => {
  assert.equal(classifyRateChangeBps(-50), 'cut_gt_25');
  assert.equal(classifyRateChangeBps(-25), 'cut_25');
  assert.equal(classifyRateChangeBps(0), 'hold');
  assert.equal(classifyRateChangeBps(25), 'hike_25');
  assert.equal(classifyRateChangeBps(75), 'hike_gt_25');
});

test('scores a categorical forecast', () => {
  const score = scoreCategoricalForecast({ cut_gt_25: 0.05, cut_25: 0.15, hold: 0.7, hike_25: 0.08, hike_gt_25: 0.02 }, 'hold');
  assert.ok(score.brierMultiClass >= 0);
  assert.ok(score.logLoss >= 0);
  assert.equal(score.realizedProbability, 0.7);
});

test('runs historical FOMC backtest rows deterministically', () => {
  const report = runFomcBacktest([
    {
      id: 'example', meetingDate: '2026-07-29', changeBps: 0,
      features: { coreInflationYoY: 2.7, headlineInflationYoY: 2.5, unemploymentRate: 4.2, unemploymentChange3m: 0.0 }
    }
  ]);
  assert.equal(report.sampleSize, 1);
  assert.equal(report.results[0].realizedOutcome, 'hold');
  assert.ok(report.meanBrier >= 0);
});

test('computes calibration bins and ECE', () => {
  const bins = calibrationBins([
    { probability: 0.1, actual: 0 },
    { probability: 0.2, actual: 0 },
    { probability: 0.8, actual: 1 },
    { probability: 0.9, actual: 1 }
  ], { bins: 5 });
  const ece = expectedCalibrationError(bins);
  assert.ok(ece >= 0 && ece <= 1);
});
