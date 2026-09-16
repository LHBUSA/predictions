import { probabilityAboveNormal, probabilityBelowNormal, finite } from './probability-utils.js';

export const MORTGAGE_MODEL = Object.freeze({
  id: 'mortgage-rate-baseline',
  version: '0.1.0',
  status: 'research'
});

export function mortgageFeatures(input) {
  const mortgage30 = finite(input.mortgage30, 'mortgage30');
  const priorMortgage30 = finite(input.priorMortgage30 ?? mortgage30, 'priorMortgage30');
  const treasury10 = finite(input.treasury10, 'treasury10');
  const priorTreasury10 = finite(input.priorTreasury10 ?? treasury10, 'priorTreasury10');
  const spread = finite(input.mortgageTreasurySpread ?? (mortgage30 - treasury10), 'mortgageTreasurySpread');
  const priorSpread = finite(input.priorMortgageTreasurySpread ?? spread, 'priorMortgageTreasurySpread');
  const policyUpper = finite(input.policyUpper ?? 0, 'policyUpper');
  const inflationYoY = finite(input.inflationYoY ?? 0, 'inflationYoY');

  return Object.freeze({
    mortgage30,
    priorMortgage30,
    mortgageMomentum: mortgage30 - priorMortgage30,
    treasury10,
    priorTreasury10,
    treasuryMomentum: treasury10 - priorTreasury10,
    spread,
    priorSpread,
    spreadMomentum: spread - priorSpread,
    policyUpper,
    inflationYoY
  });
}

export function mortgageDistribution(features, config = {}) {
  const f = mortgageFeatures(features);
  const mean =
    f.mortgage30 +
    0.42 * f.treasuryMomentum +
    0.34 * f.spreadMomentum +
    0.14 * f.mortgageMomentum +
    0.025 * Math.max(0, f.inflationYoY - 2) +
    0.015 * Math.max(0, f.policyUpper - f.treasury10);
  const sigma = finite(config.sigma ?? 0.22, 'sigma');
  return Object.freeze({ mean, sigma, features: f });
}

export function probabilityMortgageAbove(features, threshold, config = {}) {
  const dist = mortgageDistribution(features, config);
  const target = finite(threshold, 'threshold');
  return Object.freeze({
    probability: probabilityAboveNormal(dist.mean, dist.sigma, target),
    mean: dist.mean,
    sigma: dist.sigma,
    features: dist.features,
    explanation: Object.freeze({
      threshold: target,
      mortgage30: dist.features.mortgage30,
      treasuryMomentum: dist.features.treasuryMomentum,
      spreadMomentum: dist.features.spreadMomentum,
      note: 'Research baseline using rate, Treasury and spread pressure; not validated edge.'
    })
  });
}

export function probabilityMortgageBelow(features, threshold, config = {}) {
  const dist = mortgageDistribution(features, config);
  const target = finite(threshold, 'threshold');
  return Object.freeze({
    probability: probabilityBelowNormal(dist.mean, dist.sigma, target),
    mean: dist.mean,
    sigma: dist.sigma,
    features: dist.features,
    explanation: Object.freeze({
      threshold: target,
      mortgage30: dist.features.mortgage30,
      treasuryMomentum: dist.features.treasuryMomentum,
      spreadMomentum: dist.features.spreadMomentum,
      note: 'Research baseline using rate, Treasury and spread pressure; not validated edge.'
    })
  });
}
