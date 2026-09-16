import { assertProbability } from '../domain.js';

export const INFLATION_MODEL = Object.freeze({
  id: 'inflation-threshold-baseline',
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

export function inflationFeatures(input) {
  const headlineYoY = num(input.headlineYoY, 'headlineYoY');
  const coreYoY = num(input.coreYoY, 'coreYoY');
  const headlineMoM = num(input.headlineMoM, 'headlineMoM');
  const coreMoM = num(input.coreMoM, 'coreMoM');
  const energyMoM = num(input.energyMoM ?? 0, 'energyMoM');
  const shelterYoY = num(input.shelterYoY ?? coreYoY, 'shelterYoY');
  const priorHeadlineYoY = num(input.priorHeadlineYoY ?? headlineYoY, 'priorHeadlineYoY');

  return Object.freeze({
    headlineYoY,
    coreYoY,
    headlineMoM,
    coreMoM,
    energyMoM,
    shelterYoY,
    headlineMomentum: headlineYoY - priorHeadlineYoY
  });
}

export function probabilityAboveInflationThreshold(features, threshold, config = {}) {
  const f = inflationFeatures(features);
  const target = num(threshold, 'threshold');
  const scale = num(config.scale ?? 0.28, 'scale');
  const score =
    (f.headlineYoY - target) / scale +
    0.9 * (f.coreYoY - target) / Math.max(scale, 0.1) +
    0.45 * (f.headlineMoM - 0.2) +
    0.55 * (f.coreMoM - 0.2) +
    0.12 * f.energyMoM +
    0.18 * (f.shelterYoY - f.coreYoY) +
    0.5 * f.headlineMomentum;

  const probability = sigmoid(score);
  assertProbability(probability);
  return Object.freeze({
    probability,
    score,
    features: f,
    explanation: Object.freeze({
      threshold: target,
      headlineGap: f.headlineYoY - target,
      coreGap: f.coreYoY - target,
      headlineMomentum: f.headlineMomentum,
      note: 'Research baseline; uncalibrated until point-in-time historical backtest is complete.'
    })
  });
}
