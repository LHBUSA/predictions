// Daily maximum temperature at the CLI site (temp-v1): empirical error distribution of the NWS GFS MOS
// day-max guidance at this station and run lead (2023-01..2025-06 training; holdout beat a Normal model on
// exact-degree log loss 2.583 vs 2.613 and 2-degree-bucket Brier 0.1386 vs 0.1395).
// The CLI reports whole degrees F; contracts are integer comparisons:
//   'less' cap C -> reported < C ; 'greater' floor F -> reported > F ; 'between' F..C -> F <= reported <= C

export function leadBucket(runLeadH) {
  if (!Number.isFinite(runLeadH)) throw new TypeError('runLeadH must be finite');
  return runLeadH <= 30 ? 'le30h' : runLeadH <= 54 ? 'le54h' : 'gt54h';
}

export function residualTable(artifact, stationCli, runLeadH) {
  const bucket = leadBucket(runLeadH);
  const station = artifact.station_residuals?.[stationCli]?.[bucket] || null;
  const table = station || artifact.pooled_residuals[bucket];
  const errors = Object.entries(table.counts).map(([e, c]) => [Number(e), c]);
  const n = table.n;
  const mean = errors.reduce((s, [e, c]) => s + e * c, 0) / n;
  const sd = Math.sqrt(errors.reduce((s, [e, c]) => s + c * (e - mean) ** 2, 0) / (n - 1));
  return Object.freeze({ bucket, source: station ? 'station' : 'pooled', n, errors, mean, sd });
}

export function integerRange({ comparator, low = null, high = null }) {
  if (comparator === 'less') return [-Infinity, high - 1];
  if (comparator === 'greater') return [low + 1, Infinity];
  if (comparator === 'between') return [low, high];
  throw new RangeError(`unsupported comparator ${comparator}`);
}

export function bucketProbability(artifact, table, guidanceF, contract) {
  if (!Number.isFinite(guidanceF)) throw new TypeError('guidanceF must be finite');
  const [lo, hi] = integerRange(contract);
  let hit = 0;
  for (const [e, c] of table.errors) { const t = Math.round(guidanceF + e); if (t >= lo && t <= hi) hit += c; }
  const p = (hit + 0.5) / (table.n + 1);
  const [a, b] = artifact.probability_bounds;
  return Math.min(b, Math.max(a, p));
}
