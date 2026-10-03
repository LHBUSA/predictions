// Fed decision model v1 (SHADOW): ordered logit over the five Kalshi KXFEDDECISION buckets.
// Inputs are official, never-revised daily series only (H.15 via FRED): the 6-month constant-maturity
// Treasury yield relative to the federal funds target midpoint, its change since the previous FOMC decision,
// the direction of that decision, and the horizon to the meeting. Feature set chosen on 1994-2007 fit /
// 2008-2015 validation (scripts/research/fed-select.mjs). No Kalshi data, no market-implied Fed odds.

export const FED_OUTCOMES = Object.freeze(['cut_gt_25', 'cut_25', 'hold', 'hike_25', 'hike_gt_25']);
export const FED_FEATURES = Object.freeze(['cmt6m_change_since_last_decision', 'cmt6m_minus_target_mid', 'previous_decision_direction', 'horizon_days_over_30']);

export function outcomeOfChange(bps) {
  if (bps < -25) return 'cut_gt_25';
  if (bps < 0) return 'cut_25';
  if (bps === 0) return 'hold';
  if (bps <= 25) return 'hike_25';
  return 'hike_gt_25';
}

export function fedFeatureVector(f) {
  for (const k of ['d6', 'c6', 'prev', 'horizonDays']) if (!Number.isFinite(f?.[k])) throw new TypeError(`fed feature ${k} is required`);
  return [f.d6, f.c6, f.prev, f.horizonDays / 30];
}

const sig = (z) => 1 / (1 + Math.exp(-z));

// params: { beta: [4], cut0: number, gaps: [3] (log increments) } -> P over 5 ordered outcomes
export function orderedProbabilities(params, x) {
  const eta = params.beta.reduce((s, b, i) => s + b * x[i], 0);
  const th = [params.cut0];
  for (const g of params.gaps) th.push(th[th.length - 1] + Math.exp(g));
  const cdf = th.map((t) => sig(t - eta));
  const p = [cdf[0], cdf[1] - cdf[0], cdf[2] - cdf[1], cdf[3] - cdf[2], 1 - cdf[3]];
  return p.map((v) => Math.max(1e-6, v));
}

function pack(v) { return { beta: v.slice(0, 4), cut0: v[4], gaps: v.slice(5, 8) }; }

export function negLogLik(v, X, Y, ridge = 1e-3) {
  const params = pack(v);
  let s = 0;
  for (let i = 0; i < X.length; i += 1) s -= Math.log(orderedProbabilities(params, X[i])[Y[i]]);
  return s / X.length + ridge * params.beta.reduce((a, b) => a + b * b, 0);
}

// Newton iterations with finite-difference gradient/Hessian (8 parameters; small data).
export function fitOrderedLogit(X, Y, { iterations = 60 } = {}) {
  let v = [0, 0, 0, 0, -3, 0.5, 1.2, 0.5];
  const f = (w) => negLogLik(w, X, Y);
  const h = 1e-4;
  for (let it = 0; it < iterations; it += 1) {
    const base = f(v);
    const g = v.map((_, i) => { const a = [...v]; a[i] += h; const b = [...v]; b[i] -= h; return (f(a) - f(b)) / (2 * h); });
    const H = v.map((_, i) => v.map((__, j) => {
      const pp = [...v]; pp[i] += h; pp[j] += h; const pm = [...v]; pm[i] += h; pm[j] -= h; const mp = [...v]; mp[i] -= h; mp[j] += h; const mm = [...v]; mm[i] -= h; mm[j] -= h;
      return (f(pp) - f(pm) - f(mp) + f(mm)) / (4 * h * h);
    }));
    for (let i = 0; i < v.length; i += 1) H[i][i] += 1e-6;
    const step = solve(H, g);
    let t = 1;
    let next = v.map((x, i) => x - t * step[i]);
    while (f(next) > base && t > 1e-4) { t /= 2; next = v.map((x, i) => x - t * step[i]); }
    if (Math.abs(base - f(next)) < 1e-10) { v = next; break; }
    v = next;
  }
  return pack(v);
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
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j += 1) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function predictFed(artifact, f) {
  const p = orderedProbabilities(artifact.params, fedFeatureVector(f));
  const [lo, hi] = artifact.probability_bounds;
  const bounded = p.map((v) => Math.min(hi, Math.max(lo, v)));
  const z = bounded.reduce((a, b) => a + b, 0);
  return Object.freeze(Object.fromEntries(FED_OUTCOMES.map((o, i) => [o, bounded[i] / z])));
}

// ---- official daily series helpers (FRED fredgraph.csv: public, keyless) ----
export function parseFredCsv(text) {
  const out = [];
  for (const line of String(text).trim().split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(',');
    const n = Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(n)) out.push([d, n]);
  }
  return out;
}

// Latest value dated on or before `date` (sorted rows).
export function valueAsOf(rows, date) {
  let lo = 0; let hi = rows.length - 1; let best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= date) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? { date: rows[best][0], value: rows[best][1] } : null;
}

export function targetMidAsOf({ legacy, upper, lower }, date) {
  if (date <= '2008-12-15') { const v = valueAsOf(legacy, date); return v ? { date: v.date, value: v.value, kind: 'target' } : null; }
  const u = valueAsOf(upper, date); const l = valueAsOf(lower, date);
  return u && l ? { date: u.date, value: (u.value + l.value) / 2, upper: u.value, lower: l.value, kind: 'range-midpoint' } : null;
}
