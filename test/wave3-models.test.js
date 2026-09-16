import test from 'node:test';
import assert from 'node:assert/strict';
import { probabilityCryptoAbove, probabilityCryptoBelow } from '../src/models/crypto-v0.js';
import { probabilityWeatherAbove, weatherDistribution } from '../src/models/weather-v0.js';

test('crypto threshold probability responds to current price and complements below probability', () => {
  const low = probabilityCryptoAbove({ currentPrice: 90000, annualizedVol: 0.55 }, 100000, 30);
  const high = probabilityCryptoAbove({ currentPrice: 98000, annualizedVol: 0.55 }, 100000, 30);
  const below = probabilityCryptoBelow({ currentPrice: 98000, annualizedVol: 0.55 }, 100000, 30);
  assert.ok(high.probability > low.probability);
  assert.ok(Math.abs(high.probability + below.probability - 1) < 1e-12);
});

test('weather temperature probability rises with a warmer ensemble mean', () => {
  const cooler = probabilityWeatherAbove({ forecastMean: 78, ensembleStdDev: 2.5, calibrationRmse: 1.2 }, 82);
  const warmer = probabilityWeatherAbove({ forecastMean: 84, ensembleStdDev: 2.5, calibrationRmse: 1.2 }, 82);
  assert.ok(warmer.probability > cooler.probability);
});

test('weather distribution widens when historical calibration error is higher', () => {
  const tight = weatherDistribution({ forecastMean: 80, ensembleStdDev: 2, calibrationRmse: 0.5 });
  const wide = weatherDistribution({ forecastMean: 80, ensembleStdDev: 2, calibrationRmse: 3 });
  assert.ok(wide.sigma > tight.sigma);
});
