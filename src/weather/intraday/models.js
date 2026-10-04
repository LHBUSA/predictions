// Weather intraday v2 model functions (pure). The same code path is used by the research fit/holdout scripts and
// by the engine, so the validated numbers are the numbers the engine reproduces.
//
// MAX TEMP: P(final CLI max = M + E | cell), M = round(observed ASOS max so far, degF), with E's distribution read
// from empirical tables (training 2023-01..2025-06) indexed by local-standard cutoff hour, guidance gap
// (day-max guidance - M) and drop (M - round(current temp)), with hierarchical shrinkage to coarser cells. E < 0
// (CLI max below the rounded hourly ASOS max: conversion/rounding/QC disagreement) is carried by the data, never
// excluded by a hard-coded bound.
// RAIN: once measurable rain (>= 0.01 in) is reported inside the window (accumulation fully inside it), P(YES) =
// station bound calibrated from training ASOS-measurable vs final CLI agreement; otherwise a logistic model on the
// remaining-window PoP, remaining hours, trace/straddle flags and climatology.
import { logit } from '../precip-model.js';

export const TEMP_HOURS = Object.freeze([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
export const STATION_GROUPS = Object.freeze({
  pacific_coast: ['CLILAX', 'CLISFO', 'CLISEA'],
  desert_mountain: ['CLIPHX', 'CLILAS', 'CLIABQ', 'CLIDEN'],
  gulf_texas: ['CLIMIA', 'CLIMSY', 'CLIHOU', 'CLIAUS', 'CLISAT', 'CLICLL', 'CLIDFW'],
  northeast: ['CLINYC', 'CLIEWR', 'CLIPHL', 'CLITTN', 'CLIBOS', 'CLIPVD', 'CLIDCA'],
  interior_east: ['CLIATL', 'CLILEX', 'CLICMH', 'CLIPIT'],
  midwest_plains: ['CLIORD', 'CLIMDW', 'CLIMKE', 'CLIMSP', 'CLISGF', 'CLIOKC'],
});
const GROUP_OF = Object.freeze(Object.fromEntries(Object.entries(STATION_GROUPS).flatMap(([g, list]) => list.map((s) => [s, g]))));
export const stationGroup = (cli) => GROUP_OF[cli] || null;

export const tableHour = (hoursIntoWindow) => Math.min(22, Math.max(2, Math.floor(hoursIntoWindow / 2) * 2));
export function gapBucket(gap) {
  if (gap <= -3) return -3;
  if (gap <= 4) return gap;
  if (gap <= 6) return 5;
  if (gap <= 9) return 7;
  if (gap <= 13) return 10;
  return 14;
}
export function dropBucket(drop) {
  if (drop <= 0) return 0;
  if (drop <= 2) return 1;
  if (drop <= 5) return 3;
  if (drop <= 9) return 6;
  return 10;
}

export function tempCellKeys({ station, h, M, D, g }) {
  const gb = gapBucket(Math.round(g) - M); const db = dropBucket(M - D);
  return {
    hour: `${h}`,
    hour_gap: `${h}|${gb}`,
    hour_gap_drop: `${h}|${gb}|${db}`,
    group_hour_gap_drop: `${stationGroup(station)}|${h}|${gb}|${db}`,
    station_hour_gap: `${station}|${h}|${gb}`,
    station_hour_gap_drop: `${station}|${h}|${gb}|${db}`,
  };
}

// The integer the E distribution is relative to: M (observed max so far) or max(M, round(guidance)).
export function tempAnchor(art, { M, g }) {
  return art.anchor === 'max_obs_guidance' ? Math.max(M, Math.round(g)) : M;
}

// Full distribution over E in [support[0], support[1]] for one case. Each level: P = (count + alpha * P_parent) / (n + alpha);
// the root (hour) shrinks to uniform over the support with weight 1.
export function tempEDistribution(art, x, keys = tempCellKeys(x)) {
  const [lo, hi] = art.support;
  const K = hi - lo + 1;
  let p = new Float64Array(K).fill(1 / K);
  for (const level of art.levels) {
    const alpha = art.alphas[level];
    const cell = art.tables[level]?.[keys[level]];
    if (!cell) continue;
    const q = new Float64Array(K);
    for (let i = 0; i < K; i += 1) q[i] = (alpha * p[i]) / (cell.n + alpha);
    for (const [e, c] of Object.entries(cell.c)) { const i = Number(e) - lo; if (i >= 0 && i < K) q[i] += c / (cell.n + alpha); }
    p = q;
  }
  return { lo, p, keys };
}

export function tempCellSample(art, x) {
  const keys = tempCellKeys(x);
  return Object.fromEntries(art.levels.map((l) => [l, art.tables[l]?.[keys[l]]?.n ?? 0]));
}

export const DEFICIT_MAX = 15;

// P(final CLI max < M): the ASOS-vs-CLI disagreement rate (conversion/rounding, QC'd spikes), a rare event estimated
// on POOLED cells (hour x gap, shrunk to hour, shrunk to the global rate) so one outlier in a sparse station cell
// cannot set it. Returns { q, n, below, key }.
export function belowRate(art, x) {
  const b = art.below_obs_max;
  const keys = tempCellKeys(x);
  const g = b.global; const qg = (g.below + 0.5) / (g.n + 1);
  const hc = b.hour[keys.hour]; const qh = hc ? (hc.below + b.alpha_hour * qg) / (hc.n + b.alpha_hour) : qg;
  const cc = b.hour_gap[keys.hour_gap]; const q = cc ? (cc.below + b.alpha_cell * qh) / (cc.n + b.alpha_cell) : qh;
  return { q, n: cc?.n ?? hc?.n ?? g.n, below: cc?.below ?? hc?.below ?? g.below, key: cc ? keys.hour_gap : hc ? keys.hour : 'global' };
}

// Distribution of the FINAL integer CLI max y: { lo (smallest y), p[] }. Without a below_obs_max block it is the
// hierarchical E table mapped to y = anchor + E. With it, y >= M comes from the table (renormalised over y >= M) and
// y < M carries the pooled disagreement rate q spread by the pooled deficit histogram (M - y = 1..15).
export function tempFinalDistribution(art, x, keys) {
  const e = tempEDistribution(art, x, keys);
  const anchor = tempAnchor(art, x);
  const y0 = anchor + e.lo;
  if (!art.below_obs_max) return { lo: y0, p: e.p, keys: e.keys };
  const lo = Math.min(y0, x.M - DEFICIT_MAX);
  const hiY = y0 + e.p.length - 1;
  const p = new Float64Array(hiY - lo + 1);
  let above = 0;
  for (let i = 0; i < e.p.length; i += 1) if (y0 + i >= x.M) above += e.p[i];
  const { q } = belowRate(art, x);
  for (let i = 0; i < e.p.length; i += 1) { const y = y0 + i; if (y >= x.M) p[y - lo] = (1 - q) * e.p[i] / above; }
  const d = art.below_obs_max.deficit;
  for (let k = 1; k <= DEFICIT_MAX; k += 1) p[x.M - k - lo] += q * ((d.c[k] || 0) + 1 / DEFICIT_MAX) / (d.n + 1);
  return { lo, p, keys: e.keys };
}

// P(lo <= final <= hi) over a final-max distribution (integer CLI semantics).
export function rangeProbability(dist, lo, hi) {
  let s = 0;
  for (let i = 0; i < dist.p.length; i += 1) { const y = dist.lo + i; if (y >= lo && y <= hi) s += dist.p[i]; }
  return s;
}

// ---- rain ----
export function precipIntradayVector(f, featureNames) {
  const map = {
    intercept: 1,
    logit_remaining_pop: logit(f.rem_pop),
    remaining_hours_frac: f.rem_h / 24,
    trace_seen: f.trace ? 1 : 0,
    straddle_measurable: f.straddle ? 1 : 0,
    logit_climatology: logit(f.clim_rate),
    logit_remaining_pop_x_hours: logit(f.rem_pop) * (f.rem_h / 24),
    remaining_from_gfs: f.rem_src === 'gfs' ? 1 : 0,
  };
  return featureNames.map((n) => { const v = map[n]; if (!Number.isFinite(v)) throw new TypeError(`precip intraday feature ${n} not finite`); return v; });
}

export function precipBound(art, station) {
  const s = art.measured_bound.by_station[station];
  return s ? { p: s.bound, n: s.n, yes: s.yes, source: 'station' } : { p: art.measured_bound.pooled.bound, n: art.measured_bound.pooled.n, yes: art.measured_bound.pooled.yes, source: 'pooled' };
}

// f: { station, measured_in_window, straddle, trace, rem_pop, rem_h, rem_src, clim_rate }
export function precipIntradayProbability(art, f) {
  if (f.measured_in_window) {
    const b = precipBound(art, f.station);
    return { probability: b.p, branch: 'measured_bound', bound: b };
  }
  const x = precipIntradayVector(f, art.features);
  const terms = art.coefficients.map((c, i) => c * x[i]);
  const z = terms.reduce((a, b) => a + b, 0);
  return { probability: 1 / (1 + Math.exp(-z)), branch: 'logistic', contributions: Object.fromEntries(art.features.map((n, i) => [n, +terms[i].toFixed(4)])) };
}

// ---- maxtemp-intraday 2.2.0 (additive; the functions above keep their v2.0/v2.1 behaviour) ----
// Hourly calibration hour (1..23 h after the LST window opened) instead of the 2-hourly floor.
export const tableHour22 = (hoursIntoWindow) => Math.min(23, Math.max(1, Math.floor(hoursIntoWindow)));
const bucketBy = (edges, labels) => (v) => { if (v === null || v === undefined || !Number.isFinite(v)) return 'na'; for (let i = 0; i < edges.length; i += 1) if (v <= edges[i]) return labels[i]; return labels[labels.length - 1]; };
// Candidate feature buckets (fixed before fitting; never tuned per station). x carries the raw values.
export const FEATURE_BUCKETS = Object.freeze({
  wx: (x) => x.wx ?? 'na', // weatherRegime: precip | overcast | broken | clear | unknown
  precip: (x) => (x.wx === 'precip' ? 'p' : x.wx == null ? 'na' : 'n'),
  sky: (x) => (x.sky_rank == null ? 'na' : x.sky_rank >= 4 ? 'ovc' : x.sky_rank === 3 ? 'bkn' : 'clr'),
  ceil: (x) => (x.sky_rank == null ? 'na' : x.ceil == null ? 'none' : x.ceil < 1000 ? 'lt1k' : x.ceil < 3000 ? 'lt3k' : x.ceil < 10000 ? 'lt10k' : 'hi'),
  obsc: (x) => (x.obsc ? 'o' : 'n'),
  resid: (x) => bucketBy([-3.5, -1.5, 1.5, 3.5], ['m4', 'm2', '0', 'p2', 'p4'])(x.resid),
  warm: (x) => bucketBy([0.5, 2.5, 5.5, 9.5], ['0', '1', '3', '6', '10'])(x.rem_peak == null || x.D == null ? null : x.rem_peak - x.D),
  slope3: (x) => bucketBy([-2.5, -0.5, 0.5, 2.5], ['m3', 'm1', '0', 'p1', 'p3'])(x.s3),
  slope1: (x) => bucketBy([-1.5, -0.25, 0.25, 1.5], ['m2', 'm1', '0', 'p1', 'p2'])(x.s1),
  path: (x) => bucketBy([-1.5, -0.5, 0.5, 1.5], ['m2', 'm1', '0', 'p1', 'p2'])(x.path_chg),
  lead: (x) => bucketBy([0, 2, 5], ['0', '2', '5', '6p'])(x.rem_peak_lead),
});
// Level names: a base level from tempCellKeys, optionally extended with feature buckets: 'hour_gap_drop+wx+resid'.
export function tempCellKeys22(x, levels) {
  const base = tempCellKeys(x);
  const keys = { ...base };
  for (const l of levels) {
    if (keys[l] !== undefined) continue;
    const [b, ...feats] = l.split('+');
    if (base[b] === undefined || !feats.length) throw new RangeError(`unknown 2.2 level ${l}`);
    keys[l] = `${base[b]}|${feats.map((f) => { const fn = FEATURE_BUCKETS[f]; if (!fn) throw new RangeError(`unknown 2.2 feature ${f}`); return fn(x); }).join('|')}`;
  }
  return keys;
}
// Gap guidance for 2.2: 'txn' = NBS day max (as v2.x); 'proj' = remaining NBM path peak + current obs-vs-path residual;
// 'proj_half' = remaining path peak + half the residual.
export function gapGuidance22(source, x) {
  if (source === 'txn') return x.txn;
  if (x.rem_peak == null || x.resid == null) return null;
  return source === 'proj' ? x.rem_peak + x.resid : source === 'proj_half' ? x.rem_peak + 0.5 * x.resid : null;
}
export function tempFinalDistribution22(art, x) {
  return tempFinalDistribution(art, x, tempCellKeys22(x, art.levels));
}
export function tempCellSample22(art, x) {
  const keys = tempCellKeys22(x, art.levels);
  return Object.fromEntries(art.levels.map((l) => [l, art.tables[l]?.[keys[l]]?.n ?? 0]));
}
