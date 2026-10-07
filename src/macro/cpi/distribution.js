// CPI V1 predictive distribution over the PUBLISHED one-decimal value.
//
// A model supplies a continuous predictive CDF for the latent change; BLS
// publishes it rounded to 0.1. The distribution is therefore a probability mass
// on the 0.1 grid: P(published = k) = F(k + 0.05) - F(k - 0.05), with all tail
// mass folded into the end buckets. Every contract probability (above, below,
// range, exact) is a sum over this one mass vector, so they are coherent and
// monotonic by construction.

export const STEP = 0.1;

function erf(x) {
  // Abramowitz-Stegun 7.1.26, |err| < 1.5e-7
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function logGamma(z) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i += 1) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// regularized incomplete beta via continued fraction (Numerical Recipes betacf)
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function ibeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

export function studentTCdf(t, nu) {
  const x = nu / (nu + t * t);
  const tail = 0.5 * ibeta(nu / 2, 0.5, x);
  return t >= 0 ? 1 - tail : tail;
}

// Continuous predictive CDF factories.
export function gaussianCdf(mu, sigma) {
  if (!(sigma > 0)) throw new RangeError('sigma must be > 0');
  return (x) => normalCdf((x - mu) / sigma);
}

export function studentCdf(mu, scale, nu) {
  if (!(scale > 0) || !(nu > 2)) throw new RangeError('scale > 0 and nu > 2 required');
  return (x) => studentTCdf((x - mu) / scale, nu);
}

// Gaussian-kernel mixture over sample points (empirical / KDE distribution).
export function kernelCdf(points, bandwidth) {
  if (!points.length) throw new RangeError('kernelCdf needs points');
  if (!(bandwidth > 0)) throw new RangeError('bandwidth must be > 0');
  return (x) => {
    let s = 0;
    for (const p of points) s += normalCdf((x - p) / bandwidth);
    return s / points.length;
  };
}

function roundStep(x) {
  return Math.round(x / STEP) / (1 / STEP);
}

// Discretize a continuous CDF onto the published 0.1 grid [lo, hi].
export function discretize(cdf, { lo, hi }) {
  const n = Math.round((hi - lo) / STEP) + 1;
  const support = Array.from({ length: n }, (_, i) => roundStep(lo + i * STEP));
  const mass = support.map((k, i) => {
    const upper = i === n - 1 ? 1 : cdf(k + STEP / 2);
    const lower = i === 0 ? 0 : cdf(k - STEP / 2);
    return Math.max(0, upper - lower);
  });
  const total = mass.reduce((s, v) => s + v, 0);
  return makeDistribution(support, mass.map((v) => v / total));
}

export function makeDistribution(support, mass) {
  if (support.length !== mass.length) throw new Error('support/mass length mismatch');
  const cum = [];
  let c = 0;
  for (const m of mass) { c += m; cum.push(c); }
  const idx = (k) => Math.round((roundStep(k) - support[0]) / STEP);
  const dist = {
    support: Object.freeze(support.slice()),
    mass: Object.freeze(mass.slice()),
    // P(published <= k)
    cdfAt(k) {
      const i = idx(k);
      if (i < 0) return 0;
      if (i >= support.length) return 1;
      return Math.min(1, cum[i]);
    },
    // P(published > t). Thresholds are on the one-decimal grid ("Above 0.3%").
    probAbove(t) {
      return Math.max(0, Math.min(1, 1 - dist.cdfAt(t)));
    },
    probBelow(t) {
      return dist.cdfAt(roundStep(t) - STEP);
    },
    // P(lo <= published <= hi), inclusive one-decimal bounds
    probRange(lo, hi) {
      return Math.max(0, dist.cdfAt(hi) - dist.cdfAt(roundStep(lo) - STEP));
    },
    probExact(k) {
      const i = idx(k);
      return i >= 0 && i < support.length ? mass[i] : 0;
    },
    quantile(q) {
      for (let i = 0; i < cum.length; i += 1) if (cum[i] >= q - 1e-12) return support[i];
      return support[support.length - 1];
    },
    mean() {
      return support.reduce((s, k, i) => s + k * mass[i], 0);
    },
    sd() {
      const m = dist.mean();
      return Math.sqrt(support.reduce((s, k, i) => s + (k - m) ** 2 * mass[i], 0));
    }
  };
  return Object.freeze(dist);
}

export const GRID = Object.freeze({
  mom: Object.freeze({ lo: -3.0, hi: 3.0 }),
  yoy: Object.freeze({ lo: -4.0, hi: 15.0 })
});
