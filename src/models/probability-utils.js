import { assertProbability } from '../domain.js';

export function finite(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${field} must be a finite number`);
  return n;
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x, mean = 0, sigma = 1) {
  const value = finite(x, 'x');
  const mu = finite(mean, 'mean');
  const sd = finite(sigma, 'sigma');
  if (sd <= 0) throw new RangeError('sigma must be greater than 0');
  const probability = 0.5 * (1 + erf((value - mu) / (sd * Math.SQRT2)));
  assertProbability(probability);
  return probability;
}

export function probabilityAboveNormal(mean, sigma, threshold) {
  const probability = 1 - normalCdf(finite(threshold, 'threshold'), mean, sigma);
  assertProbability(probability);
  return probability;
}

export function probabilityBelowNormal(mean, sigma, threshold) {
  const probability = normalCdf(finite(threshold, 'threshold'), mean, sigma);
  assertProbability(probability);
  return probability;
}
