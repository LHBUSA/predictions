import { assertProbability } from './domain.js';

export function brierScore(probability, outcome) {
  assertProbability(probability);
  if (outcome !== 0 && outcome !== 1) throw new RangeError('outcome must be 0 or 1');
  return (probability - outcome) ** 2;
}

export function logLoss(probability, outcome, epsilon = 1e-15) {
  assertProbability(probability);
  if (outcome !== 0 && outcome !== 1) throw new RangeError('outcome must be 0 or 1');
  const p = Math.min(1 - epsilon, Math.max(epsilon, probability));
  return -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
}

export function scoreSnapshot(snapshot, outcome) {
  return Object.freeze({
    snapshotId: snapshot.id,
    eventId: snapshot.eventId,
    outcome,
    modelProbability: snapshot.modelProbability,
    marketProbability: snapshot.marketProbability ?? null,
    modelBrier: brierScore(snapshot.modelProbability, outcome),
    marketBrier: snapshot.marketProbability == null ? null : brierScore(snapshot.marketProbability, outcome),
    modelLogLoss: logLoss(snapshot.modelProbability, outcome),
    marketLogLoss: snapshot.marketProbability == null ? null : logLoss(snapshot.marketProbability, outcome)
  });
}

export function calibrationBucket(probability, bucketWidth = 0.1) {
  assertProbability(probability);
  if (!Number.isFinite(bucketWidth) || bucketWidth <= 0 || bucketWidth > 1) {
    throw new RangeError('bucketWidth must be > 0 and <= 1');
  }
  const lower = Math.min(1, Math.floor(probability / bucketWidth) * bucketWidth);
  const upper = Math.min(1, lower + bucketWidth);
  return Object.freeze({ lower, upper });
}
