// Treasury yield path model (pbe-rates-path). For a contract "par yield above K (below K) on ANY business day in
// the period", given the path published so far: P(YES) = P(running extreme crosses K over the remaining business days).
// Daily changes are simulated as sigma_t * z with z resampled from standardized historical daily changes (fat tails)
// or N(0,1) (baseline); yields are rounded to two decimals each day as published. Inputs: official Treasury par
// curve only (FRED DGS* history is identical to the Treasury series, verified 688/688 days 2024-26). No market data.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function seedFrom(text) { let h = 2166136261; for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function gauss(rand) { let u = 0; while (u === 0) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); }

// EWMA volatility of daily changes (percentage points) using only values up to the last index.
export function ewmaSigma(changes, lambda = 0.94, init = null) {
  if (!changes.length) return null;
  let v = init ?? changes.slice(0, Math.min(20, changes.length)).reduce((s, c) => s + c * c, 0) / Math.min(20, changes.length);
  for (const c of changes) v = lambda * v + (1 - lambda) * c * c;
  return Math.sqrt(v);
}
export function trailingSigma(changes, n = 250) {
  const xs = changes.slice(-n);
  if (xs.length < 20) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

// Simulate remaining-path extremes once; returns sorted arrays of path maxima and minima (rounded to 0.01).
export function simulateExtremes({ y0, sigma, steps, paths = 4000, residuals = null, seed = 1 }) {
  const rand = mulberry32(seed);
  const maxs = new Float64Array(paths); const mins = new Float64Array(paths);
  for (let p = 0; p < paths; p += 1) {
    let y = y0; let hi = -Infinity; let lo = Infinity;
    for (let s = 0; s < steps; s += 1) {
      const z = residuals ? residuals[Math.floor(rand() * residuals.length)] : gauss(rand);
      y += sigma * z;
      const pub = Math.round(y * 100) / 100;
      if (pub > hi) hi = pub;
      if (pub < lo) lo = pub;
    }
    maxs[p] = steps ? hi : -Infinity; mins[p] = steps ? lo : Infinity;
  }
  maxs.sort(); mins.sort();
  return { maxs, mins, paths };
}

// P(any future published value > K) for highs, P(any < K) for lows. Already-crossed paths must be filtered by caller.
export function crossProbability(sim, { direction, level }) {
  const n = sim.paths;
  let count = 0;
  if (direction === 'high') { for (let i = n - 1; i >= 0 && sim.maxs[i] > level + 1e-9; i -= 1) count += 1; }
  else { for (let i = 0; i < n && sim.mins[i] < level - 1e-9; i += 1) count += 1; }
  return (count + 0.5) / (n + 1);
}
