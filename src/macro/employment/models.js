// Employment V1 model families (Amendment A1 items 3-6). Market prices are not an input anywhere in this file.
// Each family: fit(trainRows) -> predictor(row) -> distribution on the published 0.1 U-3 grid (CPI V1 distribution.js),
// or, for the quarantined employment-v0 baseline, a raw P(U-3 > t) function.
import { discretize, gaussianCdf, kernelCdf, studentCdf } from '../cpi/distribution.js';
import { fitRidge } from '../cpi/models.js';
import { EMPLOYMENT_MODEL, probabilityUnemploymentAbove } from '../../models/employment-v0.js';

export const MODEL_VERSION = 'employment-v1/0.1.0-research';
// CPI V1 values, unchanged (A1 item 3)
export const HYPER = Object.freeze({ ridgeLambda: 2, studentNu: 5, ewmaHalfLifeMonths: 24, empiricalWindow: 60, meanWindow: 12, minTrain: 36 });
export const U3_GRID = Object.freeze({ lo: 2.0, hi: 16.0 });
export const U3_FEATURES = Object.freeze(['CC_LOGCHG_REF', 'IC4_LOGCHG_REF', 'DU_L1']);
export const U3_CLAIMS_FEATURES = Object.freeze(['CC_LOGCHG_REF', 'IC4_LOGCHG_REF']);
export const U3_LADDER_HALF_WIDTH = 0.6;

export const u3Ladder = (anchor) => Array.from({ length: 13 }, (_, i) => Math.round((anchor - U3_LADDER_HALF_WIDTH + 0.1 * i) * 10) / 10);

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const silverman = (xs) => Math.max(0.05, 1.06 * sd(xs) * xs.length ** -0.2);
const dU = (r) => Math.round((r.target.u3 - r.anchor_u3) * 10) / 10;

function ewmaSigma(residuals, halfLife) {
  const a = 1 - 0.5 ** (1 / halfLife);
  let v = residuals.slice(0, 12).reduce((s, r) => s + r * r, 0) / Math.min(12, residuals.length);
  for (const r of residuals.slice(12)) v = (1 - a) * v + a * r * r;
  return Math.sqrt(v);
}

function ridge(train, names) {
  const y = train.map(dU);
  const fit = fitRidge(train.map((r) => names.map((n) => r.features[n])), y, HYPER.ridgeLambda);
  const resid = train.map((r, i) => y[i] - fit.predict(names.map((n) => r.features[n])));
  const inflate = Math.sqrt(train.length / Math.max(1, train.length - names.length - 1));
  return { fit, resid, inflate };
}

export const U3_FAMILIES = Object.freeze({
  RIDGE_T_EWMA: {
    role: 'candidate',
    fit(train) {
      const { fit, resid, inflate } = ridge(train, U3_FEATURES);
      const nu = HYPER.studentNu;
      const sigma = Math.max(0.03, inflate * ewmaSigma(resid, HYPER.ewmaHalfLifeMonths));
      const scale = sigma * Math.sqrt((nu - 2) / nu);
      const p = (row) => discretize(studentCdf(row.anchor_u3 + fit.predict(U3_FEATURES.map((n) => row.features[n])), scale, nu), U3_GRID);
      p.state = { intercept: fit.intercept, beta: fit.beta, featureMean: fit.featureMean, featureSd: fit.featureSd, sigma, scale, nu, features: U3_FEATURES };
      return p;
    },
  },
  PERSISTENCE_EMPIRICAL: {
    role: 'baseline',
    fit(train) {
      const errs = train.slice(-HYPER.empiricalWindow).map(dU);
      const h = silverman(errs);
      const k = kernelCdf(errs, h);
      return (row) => discretize((x) => k(x - row.anchor_u3), U3_GRID);
    },
  },
  ROLLING_MEAN_GAUSS: {
    role: 'baseline',
    fit(train) {
      const w = HYPER.meanWindow;
      const center = mean(train.slice(-w).map(dU));
      const res = [];
      for (let i = w; i < train.length; i++) res.push(dU(train[i]) - mean(train.slice(i - w, i).map(dU)));
      const sigma = Math.max(0.03, Math.sqrt(mean(res.map((e) => e * e))));
      return (row) => discretize(gaussianCdf(row.anchor_u3 + center, sigma), U3_GRID);
    },
  },
  CLAIMS_ONLY: {
    role: 'baseline',
    fit(train) {
      const { fit, resid, inflate } = ridge(train, U3_CLAIMS_FEATURES);
      const sigma = Math.max(0.03, inflate * Math.sqrt(mean(resid.map((e) => e * e))));
      return (row) => discretize(gaussianCdf(row.anchor_u3 + fit.predict(U3_CLAIMS_FEATURES.map((n) => row.features[n])), sigma), U3_GRID);
    },
  },
  EMPLOYMENT_V0: {
    role: 'baseline', kind: 'threshold-function', quarantined: EMPLOYMENT_MODEL,
    // no fitting (fixed coefficients); every input is passed explicitly, so none of v0's defaults is ever reached
    fit() {
      return (row) => {
        if (!row.v0_inputs) return null;
        const req = ['unemploymentRate', 'priorUnemploymentRate', 'payrollChangeK', 'priorPayrollChangeK', 'initialClaimsK', 'continuingClaimsM'];
        for (const k of req) if (!Number.isFinite(row.v0_inputs[k])) throw new Error(`employment-v0 input ${k} missing: defaults are not allowed`);
        return { probAbove: (t) => probabilityUnemploymentAbove(row.v0_inputs, t).probability };
      };
    },
  },
});

// ---------------------------------------------------------------- payrolls (A1 items 5, 6; fit only after U-3 is decided)
// Unit: 10,000 persons, so the CPI V1 0.1 grid step is exactly the A1 payroll grid of 1,000 persons. A first print of
// +50k is 5.0; strike 50,000 persons is 5.0; "above" stays strict on integer grid indices.
export const PAY_UNIT_PERSONS = 10000;
export const toPayUnits = (k) => Math.round(k) / 10; // thousands (BLS) -> 10k-person units, exact on the 1k grid
export const PAY_GRID = Object.freeze({ lo: -2500.0, hi: 500.0 }); // -25.0M .. +5.0M persons: covers every print since 2008
export const PAY_FEATURES = Object.freeze(['PAY_L1', 'PAY_AVG3', 'IC4_LOGCHG_REF', 'CC_LOGCHG_REF']);
export const PAY_CLAIMS_FEATURES = Object.freeze(['IC4_LOGCHG_REF', 'CC_LOGCHG_REF']);
// A1 item 2: -100,000 .. +300,000 persons in 25,000 steps (17 events), in pay units
export const payLadder = () => Array.from({ length: 17 }, (_, i) => Math.round((-10 + 2.5 * i) * 10) / 10);

const yPay = (r) => toPayUnits(r.target.payroll_change_k);
const payX = (r, names) => names.map((n) => (n === 'PAY_L1' || n === 'PAY_AVG3' ? r.features[n] / 10 : r.features[n]));

function ridgePay(train, names) {
  const y = train.map(yPay);
  const fit = fitRidge(train.map((r) => payX(r, names)), y, HYPER.ridgeLambda);
  const resid = train.map((r, i) => y[i] - fit.predict(payX(r, names)));
  const inflate = Math.sqrt(train.length / Math.max(1, train.length - names.length - 1));
  return { fit, resid, inflate };
}

export const PAY_FAMILIES = Object.freeze({
  RIDGE_T_EWMA: {
    role: 'candidate',
    fit(train) {
      const { fit, resid, inflate } = ridgePay(train, PAY_FEATURES);
      const nu = HYPER.studentNu;
      const sigma = Math.max(0.03, inflate * ewmaSigma(resid, HYPER.ewmaHalfLifeMonths));
      const scale = sigma * Math.sqrt((nu - 2) / nu);
      const p = (row) => discretize(studentCdf(fit.predict(payX(row, PAY_FEATURES)), scale, nu), PAY_GRID);
      p.state = { intercept: fit.intercept, beta: fit.beta, featureMean: fit.featureMean, featureSd: fit.featureSd, sigma, scale, nu, features: PAY_FEATURES, unit_persons: PAY_UNIT_PERSONS };
      return p;
    },
  },
  PERSISTENCE_EMPIRICAL: {
    role: 'baseline',
    fit(train) {
      const errs = train.slice(-HYPER.empiricalWindow).map((r) => yPay(r) - r.features.PAY_L1 / 10);
      const k = kernelCdf(errs, silverman(errs));
      return (row) => discretize((x) => k(x - row.features.PAY_L1 / 10), PAY_GRID);
    },
  },
  ROLLING_MEAN_GAUSS: {
    role: 'baseline',
    fit(train) {
      const w = HYPER.meanWindow;
      const center = mean(train.slice(-w).map(yPay));
      const res = [];
      for (let i = w; i < train.length; i++) res.push(yPay(train[i]) - mean(train.slice(i - w, i).map(yPay)));
      const sigma = Math.max(0.03, Math.sqrt(mean(res.map((e) => e * e))));
      return () => discretize(gaussianCdf(center, sigma), PAY_GRID);
    },
  },
  CLAIMS_ONLY: {
    role: 'baseline',
    fit(train) {
      const { fit, resid, inflate } = ridgePay(train, PAY_CLAIMS_FEATURES);
      const sigma = Math.max(0.03, inflate * Math.sqrt(mean(resid.map((e) => e * e))));
      return (row) => discretize(gaussianCdf(fit.predict(payX(row, PAY_CLAIMS_FEATURES)), sigma), PAY_GRID);
    },
  },
});
