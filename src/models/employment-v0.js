import { assertProbability } from '../domain.js';

export const EMPLOYMENT_MODEL = Object.freeze({
  id: 'employment-threshold-baseline',
  version: '0.1.0',
  status: 'research'
});

function num(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${field} must be a finite number`);
  return n;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export function employmentFeatures(input) {
  const unemploymentRate = num(input.unemploymentRate, 'unemploymentRate');
  const priorUnemploymentRate = num(input.priorUnemploymentRate ?? unemploymentRate, 'priorUnemploymentRate');
  const payrollChangeK = num(input.payrollChangeK, 'payrollChangeK');
  const priorPayrollChangeK = num(input.priorPayrollChangeK ?? payrollChangeK, 'priorPayrollChangeK');
  const initialClaimsK = num(input.initialClaimsK ?? 230, 'initialClaimsK');
  const continuingClaimsM = num(input.continuingClaimsM ?? 1.85, 'continuingClaimsM');

  return Object.freeze({
    unemploymentRate,
    priorUnemploymentRate,
    unemploymentMomentum: unemploymentRate - priorUnemploymentRate,
    payrollChangeK,
    priorPayrollChangeK,
    payrollMomentumK: payrollChangeK - priorPayrollChangeK,
    initialClaimsK,
    continuingClaimsM
  });
}

export function probabilityUnemploymentAbove(features, threshold, config = {}) {
  const f = employmentFeatures(features);
  const target = num(threshold, 'threshold');
  const scale = num(config.scale ?? 0.22, 'scale');
  const score =
    (f.unemploymentRate - target) / scale +
    1.4 * f.unemploymentMomentum -
    0.0032 * f.payrollMomentumK +
    0.0022 * (f.initialClaimsK - 230) +
    0.85 * (f.continuingClaimsM - 1.85);

  const probability = sigmoid(score);
  assertProbability(probability);
  return Object.freeze({
    probability,
    score,
    features: f,
    explanation: Object.freeze({
      threshold: target,
      unemploymentGap: f.unemploymentRate - target,
      unemploymentMomentum: f.unemploymentMomentum,
      payrollMomentumK: f.payrollMomentumK,
      claimsPressure: f.initialClaimsK - 230,
      note: 'Research baseline; uncalibrated until point-in-time historical backtest is complete.'
    })
  });
}

export function probabilityPayrollsAbove(features, thresholdK, config = {}) {
  const f = employmentFeatures(features);
  const target = num(thresholdK, 'thresholdK');
  const scale = num(config.scale ?? 85, 'scale');
  const score =
    (f.payrollChangeK - target) / scale +
    0.004 * f.payrollMomentumK -
    1.1 * f.unemploymentMomentum -
    0.0018 * (f.initialClaimsK - 230) -
    0.6 * (f.continuingClaimsM - 1.85);

  const probability = sigmoid(score);
  assertProbability(probability);
  return Object.freeze({
    probability,
    score,
    features: f,
    explanation: Object.freeze({
      thresholdK: target,
      payrollGapK: f.payrollChangeK - target,
      payrollMomentumK: f.payrollMomentumK,
      unemploymentMomentum: f.unemploymentMomentum,
      note: 'Research baseline; uncalibrated until point-in-time historical backtest is complete.'
    })
  });
}
