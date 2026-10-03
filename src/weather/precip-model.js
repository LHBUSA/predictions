// Precipitation (any measurable rain at the CLI site over the climate day) — calibrated logistic model.
// Inputs are domain data only: NWS GFS MOS PoP for the window + station climatology. No market fields.

export const PRECIP_FEATURES = Object.freeze(['intercept', 'logit_pop_union', 'logit_pop_max', 'logit_climatology', 'run_lead_days_minus_1']);
const EPS = 0.01;
const clamp = (p) => Math.min(1 - EPS, Math.max(EPS, p));
export const logit = (p) => Math.log(clamp(p) / (1 - clamp(p)));

export function precipFeatureVector(f) {
  for (const k of ['pop_union', 'pop_max', 'clim', 'runLeadH']) {
    if (!Number.isFinite(f?.[k])) throw new TypeError(`precip feature ${k} is required`);
  }
  return [1, logit(f.pop_union), logit(f.pop_max), logit(f.clim), (f.runLeadH - 24) / 24];
}

// Newton-Raphson logistic regression with a small ridge (intercept unpenalised).
export function fitLogistic(X, y, { ridge = 1e-3, maxIter = 50, tol = 1e-9 } = {}) {
  const k = X[0].length;
  let w = new Array(k).fill(0);
  let iterations = 0;
  for (; iterations < maxIter; iterations += 1) {
    const g = new Array(k).fill(0);
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i += 1) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], 0);
      const p = 1 / (1 + Math.exp(-z));
      const r = p - y[i];
      const s = p * (1 - p);
      for (let a = 0; a < k; a += 1) {
        g[a] += r * X[i][a];
        for (let b = 0; b < k; b += 1) H[a][b] += s * X[i][a] * X[i][b];
      }
    }
    for (let a = 1; a < k; a += 1) { g[a] += ridge * w[a] * X.length; H[a][a] += ridge * X.length; }
    const step = solve(H, g);
    w = w.map((v, i) => v - step[i]);
    if (Math.max(...step.map(Math.abs)) < tol) break;
  }
  return { coefficients: w, iterations };
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function predictPrecip(artifact, f) {
  const x = precipFeatureVector(f);
  const terms = artifact.coefficients.map((c, i) => c * x[i]);
  const z = terms.reduce((a, b) => a + b, 0);
  const [lo, hi] = artifact.probability_bounds;
  const p = Math.min(hi, Math.max(lo, 1 / (1 + Math.exp(-z))));
  return Object.freeze({
    probability: p,
    contributions: Object.freeze(Object.fromEntries(artifact.features.map((name, i) => [name, +terms[i].toFixed(4)]))),
  });
}
