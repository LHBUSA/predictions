import { normalCdf, finite } from './probability-utils.js';

export const CRYPTO_MODEL = Object.freeze({
  id: 'crypto-threshold-diffusion-baseline',
  version: '0.1.0',
  status: 'research'
});

export function cryptoFeatures(input, horizonDays) {
  const currentPrice = finite(input.currentPrice, 'currentPrice');
  const annualizedVol = finite(input.annualizedVol, 'annualizedVol');
  const driftAnnualized = finite(input.driftAnnualized ?? 0, 'driftAnnualized');
  const fundingAnnualized = finite(input.fundingAnnualized ?? 0, 'fundingAnnualized');
  const horizon = finite(horizonDays, 'horizonDays');
  if (currentPrice <= 0) throw new RangeError('currentPrice must be greater than 0');
  if (annualizedVol <= 0) throw new RangeError('annualizedVol must be greater than 0');
  if (horizon <= 0) throw new RangeError('horizonDays must be greater than 0');
  return Object.freeze({ currentPrice, annualizedVol, driftAnnualized, fundingAnnualized, horizonDays: horizon });
}

export function cryptoTerminalDistribution(features, horizonDays, config = {}) {
  const f = cryptoFeatures(features, horizonDays);
  const t = f.horizonDays / finite(config.daysPerYear ?? 365.25, 'daysPerYear');
  const effectiveDrift = f.driftAnnualized + 0.25 * f.fundingAnnualized;
  const meanLogReturn = (effectiveDrift - 0.5 * f.annualizedVol ** 2) * t;
  const sigmaLogReturn = f.annualizedVol * Math.sqrt(t);
  return Object.freeze({ meanLogReturn, sigmaLogReturn, features: f });
}

export function probabilityCryptoAbove(features, threshold, horizonDays, config = {}) {
  const target = finite(threshold, 'threshold');
  if (target <= 0) throw new RangeError('threshold must be greater than 0');
  const dist = cryptoTerminalDistribution(features, horizonDays, config);
  const logBarrier = Math.log(target / dist.features.currentPrice);
  const z = (dist.meanLogReturn - logBarrier) / dist.sigmaLogReturn;
  const probability = normalCdf(z);
  return Object.freeze({
    probability,
    features: dist.features,
    meanLogReturn: dist.meanLogReturn,
    sigmaLogReturn: dist.sigmaLogReturn,
    explanation: Object.freeze({
      threshold: target,
      currentPrice: dist.features.currentPrice,
      annualizedVol: dist.features.annualizedVol,
      horizonDays: dist.features.horizonDays,
      driftAnnualized: dist.features.driftAnnualized,
      note: 'Research diffusion baseline. It is a transparent volatility/horizon prior, not a claim that crypto prices follow a perfect lognormal process.'
    })
  });
}

export function probabilityCryptoBelow(features, threshold, horizonDays, config = {}) {
  const above = probabilityCryptoAbove(features, threshold, horizonDays, config);
  return Object.freeze({ ...above, probability: 1 - above.probability });
}
