// Weather intraday v2 — pure point-in-time feature extraction shared by the research scripts and the engine.
// Never imports market data. Observations are exact-station ASOS reports VALID INSIDE the CLI window and
// AVAILABLE (published) at or before the cutoff; guidance runs are usable at cycle + 5 h (v1 rule) and <= 24 h old.
import { runAvailableAt, MOS_AVAILABLE_LAG_H } from '../mos.js';

// METAR publication lag. Routine METARs are observed at ~:51-:56 and disseminated within minutes; the IEM archive
// carries no receipt time, so a conservative fixed lag is applied to every ob (an ob valid 13:54 is usable from 14:04).
export const OBS_PUBLICATION_LAG_MIN = 10;
export const GUIDANCE_MAX_AGE_H = 24;
export const MEASURABLE_IN = 0.01;
// A report valid within this many minutes of the window start may carry an accumulation that began before the
// window (hourly p01i runs from the previous routine report, ~:51 of the prior hour).
export const STRADDLE_MIN = 65;

const H = 3600000;
const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));

export class PointInTimeError extends Error {
  constructor(msg) { super(msg); this.name = 'PointInTimeError'; }
}

export function obsAvailableAt(validAt, lagMin = OBS_PUBLICATION_LAG_MIN) {
  return new Date(toMs(validAt) + lagMin * 60000).toISOString();
}

// Throws unless every row is valid inside [start, end) and was available at or before now.
export function assertPointInTime(rows, win, now) {
  const s = toMs(win.start); const e = toMs(win.end); const n = toMs(now);
  for (const r of rows) {
    const v = toMs(r.valid_at); const a = toMs(r.available_at);
    if (!Number.isFinite(v) || !Number.isFinite(a)) throw new PointInTimeError('observation without valid_at/available_at');
    if (v < s || v >= e) throw new PointInTimeError(`observation valid ${r.valid_at} outside window`);
    if (a > n) throw new PointInTimeError(`observation available ${r.available_at} after cutoff ${new Date(n).toISOString()}`);
    if (a < v) throw new PointInTimeError(`observation available before it was valid (${r.valid_at})`);
  }
  return rows;
}

// Select the usable observations (inside window, published by now), sorted by valid time.
export function usableObs(obs, win, now) {
  const s = toMs(win.start); const e = toMs(win.end); const n = toMs(now);
  return obs.filter((r) => { const v = toMs(r.valid_at); return v >= s && v < e && toMs(r.available_at) <= n; })
    .sort((a, b) => toMs(a.valid_at) - toMs(b.valid_at));
}

// Observation summary. tmpf: decimal degF (from the METAR T-group when present); p01i: inches, 0 for trace,
// null when missing; trace flag kept separately.
export function obsSummary(rows, win) {
  const s = toMs(win.start);
  let obsMax = null; let cur = null; let nTemp = 0; let meas = false; let measInWindow = false; let trace = false; let lastValid = null; let maxAt = null;
  for (const r of rows) {
    const v = toMs(r.valid_at);
    if (Number.isFinite(r.tmpf)) { nTemp += 1; cur = r.tmpf; if (obsMax === null || r.tmpf > obsMax) { obsMax = r.tmpf; maxAt = r.valid_at; } }
    if (r.trace) trace = true;
    if (Number.isFinite(r.p01i) && r.p01i >= MEASURABLE_IN - 1e-9) { meas = true; if (v >= s + STRADDLE_MIN * 60000) measInWindow = true; }
    lastValid = r.valid_at;
  }
  return { n_obs: rows.length, n_temp: nTemp, obs_max_f: obsMax, obs_max_at: maxAt, current_f: cur, measurable: meas, measurable_straddle_only: meas && !measInWindow, trace, last_valid_at: lastValid };
}

// METAR 6-hour maximum groups (max6_f) among usable rows, counted only if the whole period [valid - 6 h, valid] lies
// inside the window (maxtemp-intraday 2.1.0).
export function obsMax6(rows, win) {
  const s = toMs(win.start); const e = toMs(win.end);
  let m = null; let at = null; let n = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.max6_f)) continue;
    const v = toMs(r.valid_at);
    if (v - 6 * H < s || v >= e) continue;
    n += 1;
    if (m === null || r.max6_f > m) { m = r.max6_f; at = r.valid_at; }
  }
  return { max6_f: m, max6_at: at, n };
}

// Runs usable at `now`: published (cycle + 5 h) and <= 24 h old. runs: [{runtime, rows, ...}] any order.
export function usableRuns(runs, now, maxAgeH = GUIDANCE_MAX_AGE_H) {
  const n = toMs(now);
  return (runs || []).filter((r) => r?.runtime && toMs(runAvailableAt(r.runtime)) <= n && n - toMs(r.runtime) <= maxAgeH * H)
    .sort((a, b) => toMs(b.runtime) - toMs(a.runtime));
}

// Day-max guidance for the climate date from the newest usable run that carries it. kind 'nbm' reads TXN, 'gfs' N/X.
export function dayMaxFromRuns(runs, date, kind) {
  const target = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString();
  for (const run of runs) {
    const row = run.rows.find((r) => r.ftime === target && (kind === 'nbm' ? r.txn != null : r.n_x != null));
    if (row) return { max: kind === 'nbm' ? row.txn : row.n_x, spread: kind === 'nbm' ? row.xnd ?? null : null, runtime: run.runtime };
  }
  return null;
}

// Probability of >= 0.01 in during [from, to) from 6-h PoP periods. Each hour slot takes the newest usable run whose
// 6-h period contains it; an hour's share of a period PoP p is 1-(1-p)^(1/6) (constant hazard inside the period).
// Returns null if any hour slot is not covered.
export function remainingPop(runs, from, to) {
  const f = toMs(from); const t = toMs(to);
  if (t <= f) return { pop: 0, hours: 0, runs: [] };
  const periods = runs.map((run) => run.rows.filter((r) => r.p06 != null).map((r) => ({ pe: toMs(r.ftime), p: r.p06 / 100 })));
  let logNo = 0; let hours = 0; const used = new Set();
  for (let s = f; s < t;) {
    const e = Math.min((Math.floor(s / H) + 1) * H, t); // hour-aligned slots (6-h periods end on whole hours)
    let found = null;
    for (let i = 0; i < runs.length && found === null; i += 1) {
      for (const q of periods[i]) if (q.pe - 6 * H <= s && e <= q.pe) { found = q.p; used.add(runs[i].runtime); break; }
    }
    if (found === null) return null;
    const frac = (e - s) / (6 * H);
    logNo += frac * Math.log(Math.max(1e-9, 1 - Math.min(found, 0.999999)));
    hours += (e - s) / H;
    s = e;
  }
  return { pop: 1 - Math.exp(logNo), hours, runs: [...used].sort() };
}

export const lstHour = (nowMs, win) => (toMs(nowMs) - toMs(win.start)) / H;
export { MOS_AVAILABLE_LAG_H };

// ---- maxtemp-intraday 2.2.0 candidate features (additive; nothing above is changed) ----
const PRECIP_RE = /(DZ|RA|SN|SG|IC|PL|GR|GS|UP)/;
const COVER_RANK = Object.freeze({ CLR: 0, SKC: 0, FEW: 1, SCT: 2, BKN: 3, OVC: 4, VV: 4 });

// Weather state of ONE report (present-weather group + sky). wxcodes: string[] | null, sky: [{cover, base_ft}] | null.
//   precip: precipitation (or thunder) at the station now (VC = vicinity, not counted)
//   obscuration: fog/mist/haze with no precipitation
//   sky_rank: 0 clear (CLR/SKC) .. 4 overcast/obscured (OVC/VV), max over layers; null when no sky group
//   ceiling_ft: lowest BKN/OVC/VV base; null = no ceiling (or unknown when sky_rank is null)
export function weatherState(wxcodes, sky) {
  const codes = Array.isArray(wxcodes) ? wxcodes.filter((c) => !/^VC/.test(c)) : [];
  const precip = codes.some((c) => PRECIP_RE.test(c) || /TS/.test(c));
  const obscuration = !precip && codes.some((c) => /(BR|FG|HZ|FU)/.test(c));
  let rank = null; let ceil = null;
  if (Array.isArray(sky)) for (const l of sky) {
    const r = COVER_RANK[l.cover]; if (r === undefined) continue;
    rank = rank === null ? r : Math.max(rank, r);
    if (r >= 3 && l.base_ft != null && (ceil === null || l.base_ft < ceil)) ceil = l.base_ft;
  }
  const known = Array.isArray(wxcodes) || Array.isArray(sky);
  return { known, precip, obscuration, sky_rank: rank, ceiling_ft: ceil };
}

// Regime used by 2.2.0 tables and the regime slices: 'precip' | 'overcast' | 'broken' | 'clear' | 'unknown'.
export function weatherRegime(ws) {
  if (!ws || !ws.known) return 'unknown';
  if (ws.precip) return 'precip';
  if (ws.sky_rank === 4) return 'overcast';
  if (ws.sky_rank === 3) return 'broken';
  if (ws.sky_rank === null) return 'unknown';
  return 'clear';
}

// Latest usable report's weather state (rows already filtered by usableObs, sorted by valid time). Rows must carry the
// 2.2.0 fields (wxcodes, sky); returns null if the newest row has neither.
export function latestWeather(rows) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r.wxcodes !== undefined || r.sky !== undefined) return { valid_at: r.valid_at, ...weatherState(r.wxcodes ?? null, r.sky ?? null) };
  }
  return null;
}

// NBM (NBS) temperature path. NBS carries TMP every 3 h (the hourly NBH text product is not archived by IEM, so the
// research and the engine both use the 3-hourly NBS TMP, linearly interpolated in time). For a time ms the value
// comes from the NEWEST usable run whose TMP points bracket ms (runs newest-first, as from usableRuns).
const TMP_PTS = new WeakMap();
function tmpPoints(run) {
  let pts = TMP_PTS.get(run);
  if (!pts) { pts = (run.rows || []).filter((r) => r.tmp != null && Number.isFinite(r.tmp)).map((r) => [toMs(r.ftime), r.tmp]).sort((a, b) => a[0] - b[0]); TMP_PTS.set(run, pts); }
  return pts;
}
export function runTempAt(run, ms) {
  const p = tmpPoints(run);
  if (!p.length || ms < p[0][0] || ms > p[p.length - 1][0]) return null;
  let lo = 0; let hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][0] <= ms) lo = m; else hi = m; }
  if (p[lo][0] === ms) return p[lo][1];
  if (p[hi][0] === ms) return p[hi][1];
  const f = (ms - p[lo][0]) / (p[hi][0] - p[lo][0]);
  if (p[hi][0] - p[lo][0] > 6 * H) return null; // never bridge a gap wider than two NBS steps
  return p[lo][1] + f * (p[hi][1] - p[lo][1]);
}
export function nbmTempAt(runs, ms) {
  for (const run of runs) { const v = runTempAt(run, ms); if (v !== null) return { tmp: v, runtime: run.runtime }; }
  return null;
}

// Trajectory features at cutoff `now` for the rest of the window. runs: usable NBS runs, newest first.
//   nbm_now: path value at the current report's valid time; resid = current temp - nbm_now (obs-vs-guidance residual)
//   rem_peak: max of the path over the hourly grid [now, end) (+ now itself); rem_peak_lead_h: hours from now to it
//   slope1/2/3: path(now + k h) - path(now)
//   path_change: mean over the grid of (newest run - next-older usable run), where both cover the hour; null if no prior run
// Returns null when the path cannot be evaluated at now (missing TMP coverage) -> engine fails closed.
export function trajectoryFeatures(runs, { now, end, curValidAt, cur }) {
  const n = toMs(now); const e = toMs(end);
  if (!runs?.length) return null;
  const at = (ms) => nbmTempAt(runs, ms);
  const base = at(n);
  const curV = curValidAt != null ? at(toMs(curValidAt)) : base;
  if (!base || !curV) return null;
  let peak = base.tmp; let lead = 0; const used = new Set([base.runtime]);
  for (let ms = (Math.floor(n / H) + 1) * H; ms < e; ms += H) {
    const v = at(ms); if (!v) continue;
    used.add(v.runtime);
    if (v.tmp > peak) { peak = v.tmp; lead = (ms - n) / H; }
  }
  const sl = (k) => { const v = at(n + k * H); return v ? v.tmp - base.tmp : null; };
  let pc = null;
  if (runs.length > 1) {
    let s = 0; let k = 0;
    for (let ms = n; ms < e; ms += H) { const a = runTempAt(runs[0], ms); const b = runTempAt(runs[1], ms); if (a !== null && b !== null) { s += a - b; k += 1; } }
    pc = k ? s / k : null;
  }
  return { nbm_now: curV.tmp, resid: Number.isFinite(cur) ? cur - curV.tmp : null, rem_peak: peak, rem_peak_lead_h: lead, slope1: sl(1), slope2: sl(2), slope3: sl(3), path_change: pc, runs: [...used].sort() };
}
