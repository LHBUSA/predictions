// CPI V1 frozen-artifact predictor.
//
// A frozen artifact holds, per target, the ridge coefficients and the
// predictive scale fixed at freeze time. predictFromArtifact() needs only the
// artifact and a buildFeatures() result; it never refits. Contract
// probabilities come from contracts.js on the returned distribution.

import { GRID, discretize, studentCdf } from './distribution.js';
import { TARGETS } from './features.js';

export function predictFromArtifact(artifact, target, featureValues) {
  const spec = artifact.targets?.[target];
  if (!spec) throw new Error(`artifact has no target ${target}`);
  const names = spec.features;
  for (const n of names) {
    if (!Number.isFinite(featureValues[n])) throw new Error(`missing feature ${n} for ${target}`);
  }
  const anchorName = TARGETS[target].anchor;
  let anchor = 0;
  if (anchorName) {
    anchor = featureValues[anchorName];
    if (!Number.isFinite(anchor)) throw new Error(`missing anchor ${anchorName} for ${target}`);
  }
  const { intercept, beta, featureMean, featureSd } = spec.ridge;
  const mu = intercept + names.reduce((s, n, j) => s + beta[j] * (featureValues[n] - featureMean[j]) / featureSd[j], 0) + anchor;
  const grid = anchorName ? GRID.yoy : GRID.mom;
  return {
    target,
    location: mu,
    scale: spec.scale,
    nu: spec.nu,
    distribution: discretize(studentCdf(mu, spec.scale, spec.nu), grid)
  };
}
