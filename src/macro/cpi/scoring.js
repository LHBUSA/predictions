// CPI V1 scoring. All binary scores use the same probability floor for every
// model so log loss stays finite and comparable.

export const PROB_FLOOR = 1e-4;

function clip(p) {
  return Math.min(1 - PROB_FLOOR, Math.max(PROB_FLOOR, p));
}

export function thresholdsFor(target, row) {
  if (target.endsWith('_mom')) {
    return Array.from({ length: 12 }, (_, i) => Math.round((-0.3 + 0.1 * i) * 10) / 10);
  }
  const anchor = row.features[target === 'headline_yoy' ? 'H_YOY_L1' : 'C_YOY_L1'];
  return Array.from({ length: 11 }, (_, i) => Math.round((anchor - 0.5 + 0.1 * i) * 10) / 10);
}

// Binary threshold events "published > t" for a distribution or a raw
// probability function (inflation-v0 is not a distribution).
export function scoreThresholds(probAbove, y, thresholds) {
  let brier = 0;
  let logLoss = 0;
  const pairs = [];
  for (const t of thresholds) {
    const p = probAbove(t);
    const o = y > t + 1e-9 ? 1 : 0;
    brier += (p - o) ** 2;
    const q = clip(p);
    logLoss += -(o * Math.log(q) + (1 - o) * Math.log(1 - q));
    pairs.push({ t, p, o });
  }
  return { brier: brier / thresholds.length, logLoss: logLoss / thresholds.length, pairs };
}

// Ranked probability score over the full support (step 0.1), i.e. a discrete CRPS.
export function rps(dist, y) {
  let s = 0;
  for (const k of dist.support) {
    const F = dist.cdfAt(k);
    const o = y <= k + 1e-9 ? 1 : 0;
    s += (F - o) ** 2;
  }
  return s * 0.1;
}

export function scoreDistribution(dist, y, thresholds) {
  const th = scoreThresholds((t) => dist.probAbove(t), y, thresholds);
  const pExact = dist.probExact(y);
  const median = dist.quantile(0.5);
  // randomized PIT for a discrete outcome
  const below = dist.cdfAt(Math.round((y - 0.1) * 10) / 10);
  return {
    brier: th.brier,
    logLoss: th.logLoss,
    pairs: th.pairs,
    rps: rps(dist, y),
    bucketLogScore: -Math.log(Math.max(PROB_FLOOR, pExact)),
    absError: Math.abs(median - y),
    sqError: (median - y) ** 2,
    sharpnessSd: dist.sd(),
    pitLow: below,
    pitHigh: below + pExact
  };
}

export function reliability(pairs, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, meanP: 0, freq: 0 }));
  for (const { p, o } of pairs) {
    const b = out[Math.min(bins - 1, Math.floor(p * bins))];
    b.n += 1; b.meanP += p; b.freq += o;
  }
  let ece = 0;
  const total = pairs.length;
  for (const b of out) {
    if (b.n) { b.meanP /= b.n; b.freq /= b.n; ece += (b.n / total) * Math.abs(b.meanP - b.freq); }
  }
  return { bins: out, ece };
}

// PIT histogram (10 bins) from randomized-PIT intervals, spreading each
// observation's [pitLow, pitHigh] mass uniformly.
export function pitHistogram(rows, bins = 10) {
  const h = new Array(bins).fill(0);
  for (const { pitLow, pitHigh } of rows) {
    const w = Math.max(1e-12, pitHigh - pitLow);
    for (let i = 0; i < bins; i += 1) {
      const lo = i / bins;
      const hi = (i + 1) / bins;
      h[i] += Math.max(0, Math.min(hi, pitHigh) - Math.max(lo, pitLow)) / w;
    }
  }
  return h.map((v) => v / rows.length);
}

// Deterministic PRNG for bootstrap reproducibility.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Moving-block bootstrap of mean(diff). Returns 95% CI and P(mean diff >= 0).
export function blockBootstrap(diffs, { block = 12, reps = 2000, seed = 20261007 } = {}) {
  const n = diffs.length;
  const rand = mulberry32(seed);
  const means = [];
  for (let r = 0; r < reps; r += 1) {
    let s = 0;
    let k = 0;
    while (k < n) {
      const start = Math.floor(rand() * (n - block + 1));
      for (let j = 0; j < block && k < n; j += 1, k += 1) s += diffs[start + j];
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const mean = diffs.reduce((s, v) => s + v, 0) / n;
  return {
    mean,
    ci95: [means[Math.floor(0.025 * reps)], means[Math.floor(0.975 * reps)]],
    probNonNegative: means.filter((m) => m >= 0).length / reps
  };
}
