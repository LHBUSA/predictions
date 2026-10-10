// maxtemp pre-window v1.2 (SHADOW research, issue #64). Pre-registered candidate D in
// docs/research/TEMP_PREWINDOW_V12_PREREG.md: the v1.1 empirical-error model re-centred on
//   center = NBM + beta_station * (GFS MOS - NBM)
// with beta fitted per station by least squares and shrunk toward the pooled beta (k = 200 cases); the residual tables
// are rebuilt on that center. Same lead buckets, +0.5 smoothing, [0.01, 0.99] bounds and integer contract ranges as v1.1.
// Inputs are the two station guidance values v1.1 already reads (no market data, no observation-window data).
// NOT wired into the Worker: it never writes pred_forecasts, takes designations or reaches a public surface.
import { residualTable, bucketProbability } from './temp-model.js';

export const V12_MODEL = Object.freeze({ model_id: 'pbe-weather-maxtemp', version: '1.2.0', state: 'SHADOW' });

export function v12Beta(artifact, stationCli) {
  const b = artifact.beta?.station?.[stationCli];
  return Number.isFinite(b) ? b : artifact.beta.pooled;
}

// Real-valued center, or null when GFS MOS is missing (v1.2 is undefined then; the caller reports NO_GFS, never a
// silent v1.1 substitute inside v1.2's record).
export function v12Center(artifact, stationCli, nbmF, gfsF) {
  if (!Number.isFinite(nbmF)) throw new TypeError('nbmF must be finite');
  if (!Number.isFinite(gfsF)) return null;
  return nbmF + v12Beta(artifact, stationCli) * (gfsF - nbmF);
}

// Bucket probabilities for one exhaustive ladder (contracts: { comparator, threshold_low, threshold_high }).
export function v12Probabilities(artifact, { stationCli, runLeadH, nbmF, gfsF, contracts }) {
  const center = v12Center(artifact, stationCli, nbmF, gfsF);
  if (center === null) return { state: 'NO_GFS', center: null, probabilities: null };
  const table = residualTable(artifact, stationCli, runLeadH);
  return { state: 'OK', center, table: { bucket: table.bucket, source: table.source, n: table.n, mean: table.mean, sd: table.sd },
    probabilities: contracts.map((c) => bucketProbability(artifact, table, center, c)) };
}
