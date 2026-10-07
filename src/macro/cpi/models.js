// CPI V1 model families and baselines.
//
// Every family maps (training rows, target) -> predict(row) -> distribution on
// the published 0.1 grid (see distribution.js). Training rows are released
// observations strictly before the forecast row's cutoff; the caller enforces
// that ordering (validate.mjs) and the tests prove it.
//
// Market prices are not an input anywhere in this file.

import { GRID, discretize, gaussianCdf, kernelCdf, studentCdf } from './distribution.js';
import { TARGETS } from './features.js';

export const MODEL_VERSION = 'cpi-v1/1.0.0';

export const HYPER = Object.freeze({
  ridgeLambda: 2,
  studentNu: 5,
  ewmaHalfLifeMonths: 24,
  empiricalWindow: 60,
  meanWindow: 12,
  minTrain: 36
});

// Hyperparameters are pre-declared above and never selected on validation
// scores. withHyper() exists only for the sensitivity report.
let active = HYPER;
function H() { return active; }

export function withHyper(override, fn) {
  const prev = active;
  active = Object.freeze({ ...HYPER, ...override });
  try { return fn(); } finally { active = prev; }
}

// Feature sets. YoY targets are modelled as the change from the last published
// 12-month rate (the anchor), then shifted back to a level.
export const FEATURE_SETS = Object.freeze({
  headline_mom: Object.freeze(['H_AVG3', 'C_AVG3', 'GAS_SA', 'F_L1', 'E_L1']),
  core_mom: Object.freeze(['C_L1', 'C_AVG3', 'C_AVG6']),
  headline_yoy: Object.freeze(['GAS_SA', 'C_AVG3', 'H_BASE', 'F_L1']),
  core_yoy: Object.freeze(['C_L1', 'C_AVG3', 'C_BASE'])
});

export const FEATURE_SETS_NO_GAS = Object.freeze({
  headline_mom: Object.freeze(['H_AVG3', 'C_AVG3', 'F_L1', 'E_L1']),
  core_mom: FEATURE_SETS.core_mom,
  headline_yoy: Object.freeze(['C_AVG3', 'H_BASE', 'F_L1']),
  core_yoy: FEATURE_SETS.core_yoy
});

const PERSIST_FEATURE = Object.freeze({ headline_mom: 'H_L1', core_mom: 'C_L1' });

export function isYoY(target) {
  return TARGETS[target].anchor !== null;
}

function grid(target) {
  return isYoY(target) ? GRID.yoy : GRID.mom;
}

// modelled quantity: MoM level, or YoY change from the anchor
function response(row, target) {
  return isYoY(target) ? row.y - row.features[TARGETS[target].anchor] : row.y;
}

function shift(row, target) {
  return isYoY(target) ? row.features[TARGETS[target].anchor] : 0;
}

function mean(xs) { return xs.reduce((s, v) => s + v, 0) / xs.length; }
function sd(xs) { const m = mean(xs); return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1)); }

function silverman(xs) {
  return Math.max(0.05, 1.06 * sd(xs) * xs.length ** -0.2);
}

function shifted(cdf, by) {
  return (x) => cdf(x - by);
}

// ---------- ridge regression (closed form, standardized features) ----------

function solve(A, b) {
  const n = A.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error('singular ridge system');
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

export function fitRidge(X, y, lambda) {
  const p = X[0].length;
  const mu = Array.from({ length: p }, (_, j) => mean(X.map((r) => r[j])));
  const sdv = Array.from({ length: p }, (_, j) => sd(X.map((r) => r[j])) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sdv[j]));
  const ym = mean(y);
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? lambda : 0)));
  const b = Array.from({ length: p }, (_, i) => Z.reduce((s, r, k) => s + r[i] * (y[k] - ym), 0));
  const beta = solve(A, b);
  return {
    intercept: ym,
    beta,
    featureMean: mu,
    featureSd: sdv,
    predict(x) { return ym + x.reduce((s, v, j) => s + beta[j] * (v - mu[j]) / sdv[j], 0); }
  };
}

function ewmaSigma(residuals, halfLife) {
  const a = 1 - 0.5 ** (1 / halfLife);
  let v = residuals.slice(0, 12).reduce((s, r) => s + r * r, 0) / Math.min(12, residuals.length);
  for (const r of residuals.slice(12)) v = (1 - a) * v + a * r * r;
  return Math.sqrt(v);
}

// ---------- families ----------

function climatology(train, target) {
  const pts = train.map((r) => r.y);
  const h = silverman(pts);
  return () => discretize(kernelCdf(pts, h), grid(target));
}

function persistenceValue(row, target) {
  return isYoY(target) ? row.features[TARGETS[target].anchor] : row.features[PERSIST_FEATURE[target]];
}

function persistGauss(train, target) {
  const errs = train.map((r) => r.y - persistenceValue(r, target));
  const sigma = Math.max(0.03, Math.sqrt(mean(errs.map((e) => e * e))));
  return (row) => discretize(gaussianCdf(persistenceValue(row, target), sigma), grid(target));
}

function persistEmpirical(train, target) {
  const errs = train.slice(-H().empiricalWindow).map((r) => r.y - persistenceValue(r, target));
  const h = silverman(errs);
  return (row) => discretize(shifted(kernelCdf(errs, h), persistenceValue(row, target)), grid(target));
}

function meanGauss(train, target) {
  const recent = train.slice(-H().meanWindow).map((r) => response(r, target));
  const center = mean(recent);
  // residual spread of the same rolling-mean rule, evaluated inside training
  const res = [];
  for (let i = H().meanWindow; i < train.length; i += 1) {
    const c = mean(train.slice(i - H().meanWindow, i).map((r) => response(r, target)));
    res.push(response(train[i], target) - c);
  }
  const sigma = Math.max(0.03, Math.sqrt(mean(res.map((e) => e * e))));
  return (row) => discretize(gaussianCdf(center + shift(row, target), sigma), grid(target));
}

function design(rows, names) {
  return rows.map((r) => names.map((n) => r.features[n]));
}

function ridgeCore(train, target, names) {
  const y = train.map((r) => response(r, target));
  const fit = fitRidge(design(train, names), y, H().ridgeLambda);
  const resid = train.map((r, i) => y[i] - fit.predict(names.map((n) => r.features[n])));
  const dof = Math.max(1, train.length - names.length - 1);
  const inflate = Math.sqrt(train.length / dof);
  return { fit, resid, inflate };
}

function ridgeGauss(train, target, names) {
  const { fit, resid, inflate } = ridgeCore(train, target, names);
  const sigma = Math.max(0.03, inflate * Math.sqrt(mean(resid.map((e) => e * e))));
  return (row) => discretize(gaussianCdf(fit.predict(names.map((n) => row.features[n])) + shift(row, target), sigma), grid(target));
}

function ridgeStudentEwma(train, target, names) {
  const { fit, resid, inflate } = ridgeCore(train, target, names);
  const nu = H().studentNu;
  const sigma = Math.max(0.03, inflate * ewmaSigma(resid, H().ewmaHalfLifeMonths));
  const scale = sigma * Math.sqrt((nu - 2) / nu);
  const predictor = (row) => discretize(studentCdf(fit.predict(names.map((n) => row.features[n])) + shift(row, target), scale, nu), grid(target));
  predictor.state = { fit, sigma, scale, nu, names, inflate };
  return predictor;
}

function ridgeEmpirical(train, target, names) {
  const { fit, resid, inflate } = ridgeCore(train, target, names);
  const pts = resid.map((e) => e * inflate);
  const h = silverman(pts);
  return (row) => discretize(shifted(kernelCdf(pts, h), fit.predict(names.map((n) => row.features[n])) + shift(row, target)), grid(target));
}

export const FAMILIES = Object.freeze({
  CLIMATOLOGY: { role: 'baseline', features: () => [], fit: climatology },
  PERSISTENCE_GAUSS: { role: 'baseline', features: (t) => [isYoY(t) ? TARGETS[t].anchor : PERSIST_FEATURE[t]], fit: persistGauss },
  PERSISTENCE_EMPIRICAL: { role: 'baseline', features: (t) => [isYoY(t) ? TARGETS[t].anchor : PERSIST_FEATURE[t]], fit: persistEmpirical },
  ROLLING_MEAN_GAUSS: { role: 'baseline', features: (t) => (isYoY(t) ? [TARGETS[t].anchor] : []), fit: meanGauss },
  RIDGE_GAUSS: { role: 'candidate', features: (t) => [...FEATURE_SETS[t], ...(isYoY(t) ? [TARGETS[t].anchor] : [])], fit: (tr, t) => ridgeGauss(tr, t, FEATURE_SETS[t]) },
  RIDGE_EMPIRICAL: { role: 'candidate', features: (t) => [...FEATURE_SETS[t], ...(isYoY(t) ? [TARGETS[t].anchor] : [])], fit: (tr, t) => ridgeEmpirical(tr, t, FEATURE_SETS[t]) },
  RIDGE_T_EWMA: { role: 'candidate', features: (t) => [...FEATURE_SETS[t], ...(isYoY(t) ? [TARGETS[t].anchor] : [])], fit: (tr, t) => ridgeStudentEwma(tr, t, FEATURE_SETS[t]) },
  RIDGE_T_EWMA_NO_GAS: { role: 'ablation', features: (t) => [...FEATURE_SETS_NO_GAS[t], ...(isYoY(t) ? [TARGETS[t].anchor] : [])], fit: (tr, t) => ridgeStudentEwma(tr, t, FEATURE_SETS_NO_GAS[t]) }
});

export { ridgeStudentEwma };
