import { probabilityAboveNormal, probabilityBelowNormal, finite } from './probability-utils.js';

export const WEATHER_MODEL = Object.freeze({
  id: 'weather-threshold-ensemble-baseline',
  version: '0.1.0',
  status: 'research'
});

export function weatherFeatures(input) {
  const forecastMean = finite(input.forecastMean, 'forecastMean');
  const ensembleStdDev = finite(input.ensembleStdDev, 'ensembleStdDev');
  const biasCorrection = finite(input.biasCorrection ?? 0, 'biasCorrection');
  const calibrationRmse = finite(input.calibrationRmse ?? 0, 'calibrationRmse');
  if (ensembleStdDev <= 0) throw new RangeError('ensembleStdDev must be greater than 0');
  if (calibrationRmse < 0) throw new RangeError('calibrationRmse cannot be negative');
  return Object.freeze({ forecastMean, ensembleStdDev, biasCorrection, calibrationRmse });
}

export function weatherDistribution(features) {
  const f = weatherFeatures(features);
  const mean = f.forecastMean + f.biasCorrection;
  const sigma = Math.sqrt(f.ensembleStdDev ** 2 + f.calibrationRmse ** 2);
  return Object.freeze({ mean, sigma, features: f });
}

export function probabilityWeatherAbove(features, threshold) {
  const dist = weatherDistribution(features);
  const target = finite(threshold, 'threshold');
  return Object.freeze({
    probability: probabilityAboveNormal(dist.mean, dist.sigma, target),
    mean: dist.mean,
    sigma: dist.sigma,
    features: dist.features,
    explanation: Object.freeze({
      threshold: target,
      forecastMean: dist.features.forecastMean,
      ensembleStdDev: dist.features.ensembleStdDev,
      biasCorrection: dist.features.biasCorrection,
      calibrationRmse: dist.features.calibrationRmse,
      note: 'Research ensemble-threshold baseline. Intended for continuous weather variables such as temperature; hurricane events require a separate specialist model.'
    })
  });
}

export function probabilityWeatherBelow(features, threshold) {
  const dist = weatherDistribution(features);
  const target = finite(threshold, 'threshold');
  return Object.freeze({
    probability: probabilityBelowNormal(dist.mean, dist.sigma, target),
    mean: dist.mean,
    sigma: dist.sigma,
    features: dist.features,
    explanation: Object.freeze({
      threshold: target,
      forecastMean: dist.features.forecastMean,
      ensembleStdDev: dist.features.ensembleStdDev,
      biasCorrection: dist.features.biasCorrection,
      calibrationRmse: dist.features.calibrationRmse,
      note: 'Research ensemble-threshold baseline. Intended for continuous weather variables such as temperature; hurricane events require a separate specialist model.'
    })
  });
}
