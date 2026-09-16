import { brierScore, logLoss } from '../scoring.js';
import { fedDecisionProbabilities } from '../models/fed-decision-v0.js';

export const FOMC_OUTCOMES = Object.freeze(['cut_gt_25', 'cut_25', 'hold', 'hike_25', 'hike_gt_25']);

function oneHot(outcome) {
  if (!FOMC_OUTCOMES.includes(outcome)) throw new RangeError(`unsupported FOMC outcome: ${outcome}`);
  return Object.fromEntries(FOMC_OUTCOMES.map((key) => [key, key === outcome ? 1 : 0]));
}

export function classifyRateChangeBps(changeBps) {
  const bps = Number(changeBps);
  if (!Number.isFinite(bps)) throw new TypeError('changeBps must be finite');
  if (bps <= -50) return 'cut_gt_25';
  if (bps < 0) return 'cut_25';
  if (bps === 0) return 'hold';
  if (bps < 50) return 'hike_25';
  return 'hike_gt_25';
}

export function scoreCategoricalForecast(probabilities, realizedOutcome) {
  const actual = oneHot(realizedOutcome);
  let brier = 0;
  for (const outcome of FOMC_OUTCOMES) {
    const p = probabilities[outcome];
    if (!Number.isFinite(p)) throw new TypeError(`missing probability for ${outcome}`);
    brier += (p - actual[outcome]) ** 2;
  }

  const realizedProbability = probabilities[realizedOutcome];
  return Object.freeze({
    brierMultiClass: brier / FOMC_OUTCOMES.length,
    realizedProbability,
    logLoss: logLoss(realizedProbability, 1)
  });
}

export function runFomcBacktest(rows, config = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');

  const results = rows.map((row) => {
    const model = fedDecisionProbabilities(row.features, config);
    const realizedOutcome = row.outcome ?? classifyRateChangeBps(row.changeBps);
    const score = scoreCategoricalForecast(model.probabilities, realizedOutcome);

    return Object.freeze({
      id: row.id,
      meetingDate: row.meetingDate,
      realizedOutcome,
      changeBps: row.changeBps,
      probabilities: model.probabilities,
      pressure: model.pressure,
      ...score
    });
  });

  const meanBrier = results.length
    ? results.reduce((sum, row) => sum + row.brierMultiClass, 0) / results.length
    : null;
  const meanLogLoss = results.length
    ? results.reduce((sum, row) => sum + row.logLoss, 0) / results.length
    : null;

  return Object.freeze({
    modelId: 'fed-decision-baseline',
    modelVersion: '0.1.0',
    sampleSize: results.length,
    meanBrier,
    meanLogLoss,
    results: Object.freeze(results)
  });
}

export function binaryOutcomeScore(probability, actual) {
  return Object.freeze({
    brier: brierScore(probability, actual),
    logLoss: logLoss(probability, actual)
  });
}
