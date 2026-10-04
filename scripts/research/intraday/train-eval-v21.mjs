// pbe-weather-maxtemp-intraday v2.1: identical pipeline and split discipline to v2.0 (train-eval.mjs), but the observed
// max so far includes the METAR 6-hour maximum groups (augment-max6.mjs). Baselines: frozen pre-window v1.1,
// persistence (now on the v2.1 observed max), climatology-of-remaining, AND maxtemp-intraday v2.0 (hourly obs only,
// its frozen artifact). Writes src/weather/artifacts/temp-intraday-v2.1.json + evidence-v21.json. v2.0 untouched.
//   node --max-old-space-size=3000 scripts/research/intraday/train-eval-v21.mjs [intradayDir]
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { TEMP_HOURS, STATION_GROUPS, stationGroup, tempCellKeys, tempFinalDistribution, DEFICIT_MAX, rangeProbability } from '../../../src/weather/intraday/models.js';
import { OBS_PUBLICATION_LAG_MIN, GUIDANCE_MAX_AGE_H } from '../../../src/weather/intraday/features.js';
import tempV1 from '../../../src/weather/artifacts/temp-v1.json' with { type: 'json' };
import tempV11 from '../../../src/weather/artifacts/temp-nbm-v1.1.json' with { type: 'json' };
import tempV20 from '../../../src/weather/artifacts/temp-intraday-v2.0.json' with { type: 'json' };

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-intraday';
const B = Number(process.env.BOOT || 1000);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const clampP = (p, a, b) => Math.min(b, Math.max(a, p));
const hourBucket = (h) => (h <= 6 ? 'h02-06' : h <= 12 ? 'h08-12' : h <= 16 ? 'h14-16' : 'h18-22');

const T = [];
{
  const rl = createInterface({ input: createReadStream(join(DIR, 'cases-v21.csv')) });
  let head = null;
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  for await (const line of rl) {
    if (!head) { head = line.split(','); continue; }
    const c = line.split(','); const o = {};
    for (let i = 0; i < head.length; i += 1) o[head[i]] = c[i];
    const r = { station: o.station, date: o.date, split: o.split, h: +o.h, obs_max: num(o.obs_max), cur: num(o.cur), g: num(o.g), clim_mean: num(o.clim_mean), clim_sd: num(o.clim_sd), pre_g: num(o.pre_g), pre_art: o.pre_art, pre_lb: o.pre_lb, y_max: num(o.y_max), max6: num(o.max6) };
    if (r.y_max === null || r.obs_max === null || r.cur === null || r.g === null || r.pre_g === null || !r.pre_art) continue;
    r.M0 = Math.round(r.obs_max); // v2.0 input: hourly/special tmpf only
    r.M = Math.round(r.max6 !== null ? Math.max(r.obs_max, r.max6) : r.obs_max); // v2.1 input
    r.D = Math.round(r.cur);
    r.E = r.y_max - r.M; r.EA = r.y_max - Math.max(r.M, Math.round(r.g));
    T.push(r);
  }
}
log('temp cases', T.length, 'with max6', T.filter((r) => r.max6 !== null).length);

const SUPPORT = [-10, 45];
const LEVELS_ALL = ['hour', 'hour_gap', 'hour_gap_drop', 'group_hour_gap_drop', 'station_hour_gap', 'station_hour_gap_drop'];
const eOf = (anchor, r) => (anchor === 'max_obs_guidance' ? r.EA : r.E);
function buildTables(rows, levels, anchor) {
  const tables = Object.fromEntries(levels.map((l) => [l, {}]));
  for (const r of rows) {
    const keys = tempCellKeys({ station: r.station, h: r.h, M: r.M, D: r.D, g: r.g });
    const e = Math.max(SUPPORT[0], Math.min(SUPPORT[1], eOf(anchor, r)));
    for (const l of levels) { const cell = (tables[l][keys[l]] ||= { n: 0, c: {} }); cell.n += 1; cell.c[e] = (cell.c[e] || 0) + 1; }
  }
  return tables;
}
function buildBelow(rows, alphaCell, alphaHour = 20) {
  const hour = {}; const hourGap = {}; const global = { n: 0, below: 0 }; const deficit = { n: 0, c: {} };
  for (const r of rows) {
    const k = tempCellKeys({ station: r.station, h: r.h, M: r.M, D: r.D, g: r.g }); const b = r.E < 0 ? 1 : 0;
    (hour[k.hour] ||= { n: 0, below: 0 }).n += 1; hour[k.hour].below += b;
    (hourGap[k.hour_gap] ||= { n: 0, below: 0 }).n += 1; hourGap[k.hour_gap].below += b;
    global.n += 1; global.below += b;
    if (b) { const d = Math.min(DEFICIT_MAX, -r.E); deficit.n += 1; deficit.c[d] = (deficit.c[d] || 0) + 1; }
  }
  return { definition: 'y < M: final CLI max below the rounded observed max so far (hourly tmpf + 6-h max groups), pooled across stations', alpha_cell: alphaCell, alpha_hour: alphaHour, global, hour, hour_gap: hourGap, deficit };
}
const tempArt = (tables, levels, alphas, anchor) => ({ support: SUPPORT, anchor, levels, alphas, tables });
const pY = (d, y) => { const i = y - d.lo; return i >= 0 && i < d.p.length ? d.p[i] : 0; };
const exactLL = (art, rows) => { let s = 0; for (const r of rows) s -= Math.log(clampP(pY(tempFinalDistribution(art, r), r.y_max), 0.001, 0.999)); return s / rows.length; };

const CANDIDATES = {};
for (const anchor of ['obs_max', 'max_obs_guidance']) {
  const a = anchor === 'obs_max' ? 'M' : 'A';
  Object.assign(CANDIDATES, {
    [`${a}1_hour_gap`]: { anchor, levels: ['hour', 'hour_gap'] },
    [`${a}2_hour_gap_drop`]: { anchor, levels: ['hour', 'hour_gap', 'hour_gap_drop'] },
    [`${a}3_group`]: { anchor, levels: ['hour', 'hour_gap', 'hour_gap_drop', 'group_hour_gap_drop'] },
    [`${a}4_station`]: { anchor, levels: ['hour', 'hour_gap', 'hour_gap_drop', 'station_hour_gap_drop'] },
    [`${a}5_station_gap_then_drop`]: { anchor, levels: ['hour', 'hour_gap', 'hour_gap_drop', 'station_hour_gap', 'station_hour_gap_drop'] },
  });
}
const ALPHA_GRID = [2, 10, 40, 160];
const fitT = T.filter((r) => r.split === 'fit'); const valT = T.filter((r) => r.split === 'val');
const fitTablesBy = { obs_max: buildTables(fitT, LEVELS_ALL, 'obs_max'), max_obs_guidance: buildTables(fitT, LEVELS_ALL, 'max_obs_guidance') };
const selection = {};
for (const [name, { anchor, levels }] of Object.entries(CANDIDATES)) {
  const alphas = { hour: 1 };
  for (const l of levels.slice(1)) {
    let best = null;
    for (const a of ALPHA_GRID) { const ll = exactLL(tempArt(fitTablesBy[anchor], levels.slice(0, levels.indexOf(l) + 1), { ...alphas, [l]: a }, anchor), valT); if (!best || ll < best.ll) best = { a, ll }; }
    alphas[l] = best.a;
  }
  selection[name] = { anchor, levels, alphas, val_exact_log_loss: +exactLL(tempArt(fitTablesBy[anchor], levels, alphas, anchor), valT).toFixed(5) };
  log('candidate', name, selection[name].val_exact_log_loss);
}
const selected = Object.entries(selection).sort((a, b) => a[1].val_exact_log_loss - b[1].val_exact_log_loss)[0][0];
const { levels: TL, alphas: TA, anchor: TANCHOR } = selection[selected];
const belowSelection = { none: selection[selected].val_exact_log_loss };
for (const a of [20, 100, 400]) belowSelection[`pooled_alpha_${a}`] = +exactLL({ ...tempArt(fitTablesBy[TANCHOR], TL, TA, TANCHOR), below_obs_max: buildBelow(fitT, a) }, valT).toFixed(5);
const belowChoice = Object.entries(belowSelection).sort((a, b) => a[1] - b[1])[0][0];
// v2.0 on the same validation cases (its frozen artifact was trained on fit+val, so this is informational only)
log('selected', selected, JSON.stringify(belowSelection), belowChoice);
const trainT = T.filter((r) => r.split !== 'test'); const testT = T.filter((r) => r.split === 'test');
const finalArt = { ...tempArt(buildTables(trainT, TL, TANCHOR), TL, TA, TANCHOR), ...(belowChoice === 'none' ? {} : { below_obs_max: buildBelow(trainT, Number(belowChoice.split('_').pop())) }) };

// ---- methods ----
function v1Range(r, lo, hi) {
  const art = r.pre_art === 'v1.1' ? tempV11 : tempV1;
  const t = art.station_residuals?.[r.station]?.[r.pre_lb] || art.pooled_residuals[r.pre_lb];
  let hit = 0;
  for (const [e, c] of Object.entries(t.counts)) { const y = Math.round(r.pre_g + Number(e)); if (y >= lo && y <= hi) hit += c; }
  return clampP((hit + 0.5) / (t.n + 1), ...art.probability_bounds);
}
const Phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function climRange(r, lo, hi) {
  const cdf = (k) => (k < r.M ? 0 : Phi((k + 0.5 - r.clim_mean) / r.clim_sd));
  const a = Math.max(lo, r.M); if (hi < a) return 0;
  return cdf(Math.min(hi, 400)) - (a - 1 < r.M ? 0 : cdf(a - 1));
}
const dist21 = (r) => r._d21 || (r._d21 = tempFinalDistribution(finalArt, r));
const dist20 = (r) => r._d20 || (r._d20 = tempFinalDistribution(tempV20, { station: r.station, h: r.h, M: r.M0, D: r.D, g: r.g }));
const METHODS = {
  intraday_v21: (r, lo, hi) => rangeProbability(dist21(r), lo, hi),
  intraday_v20: (r, lo, hi) => rangeProbability(dist20(r), lo, hi),
  prewindow_v11: v1Range,
  persistence: (r, lo, hi) => (r.M >= lo && r.M <= hi ? 1 : 0),
  climatology_remaining: climRange,
};
const EXACT = {
  intraday_v21: (r) => clampP(pY(dist21(r), r.y_max), 0.001, 0.999),
  intraday_v20: (r) => clampP(pY(dist20(r), r.y_max), 0.001, 0.999),
  prewindow_v11: (r) => v1Range(r, r.y_max, r.y_max),
  persistence: (r) => (r.y_max === r.M ? 0.99 : 0.01),
  climatology_remaining: (r) => clampP(climRange(r, r.y_max, r.y_max), 0.001, 0.999),
};
const bucketsFor = (r) => { const c = Math.round(r.pre_g); return [[-Infinity, c - 6], [c - 5, c - 4], [c - 3, c - 2], [c - 1, c], [c + 1, c + 2], [c + 3, c + 4], [c + 5, Infinity]]; };
function losses(rows) {
  const out = {}; const calib = {};
  for (const m of Object.keys(METHODS)) { out[m] = { brier: new Float64Array(rows.length), bll: new Float64Array(rows.length), exact: new Float64Array(rows.length) }; calib[m] = Array.from({ length: 10 }, () => ({ n: 0, sp: 0, so: 0 })); }
  rows.forEach((r, i) => {
    const bk = bucketsFor(r);
    for (const [m, fn] of Object.entries(METHODS)) {
      let br = 0; let ll = 0;
      for (const [lo, hi] of bk) {
        const p = clampP(fn(r, lo, hi), 0.01, 0.99); const o = r.y_max >= lo && r.y_max <= hi ? 1 : 0;
        br += (p - o) ** 2; ll -= o ? Math.log(p) : Math.log(1 - p);
        const cb = calib[m][Math.min(9, Math.floor(p * 10))]; cb.n += 1; cb.sp += p; cb.so += o;
      }
      out[m].brier[i] = br / bk.length; out[m].bll[i] = ll / bk.length; out[m].exact[i] = -Math.log(EXACT[m](r));
    }
    r._d21 = null; r._d20 = null;
  });
  return { out, calib };
}
function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapReport(rows, series, base, groupFns) {
  const dates = [...new Set(rows.map((r) => r.date))].sort(); const di = new Map(dates.map((d, i) => [d, i]));
  const methods = Object.keys(series); const groups = new Map();
  const ensure = (g) => { if (!groups.has(g)) groups.set(g, { n: new Float64Array(dates.length), s: Object.fromEntries(methods.map((m) => [m, new Float64Array(dates.length)])) }); return groups.get(g); };
  rows.forEach((r, i) => { const d = di.get(r.date); for (const g of ['ALL', ...groupFns.map((f) => f(r))]) { const G = ensure(g); G.n[d] += 1; for (const m of methods) G.s[m][d] += series[m][i]; } });
  const rnd = mulberry(20261004);
  const draws = Array.from({ length: B }, () => Array.from({ length: dates.length }, () => Math.floor(rnd() * dates.length)));
  const report = {};
  for (const [g, G] of groups) {
    const N = G.n.reduce((a, b) => a + b, 0);
    const mean = Object.fromEntries(methods.map((m) => [m, G.s[m].reduce((a, b) => a + b, 0) / N]));
    const diffs = {};
    for (const m of methods) {
      if (m === base) continue;
      const ds = [];
      for (const draw of draws) { let n = 0; let a = 0; let b = 0; for (const k of draw) { n += G.n[k]; a += G.s[base][k]; b += G.s[m][k]; } if (n) ds.push((b - a) / n); }
      ds.sort((x, y) => x - y);
      diffs[m] = { diff: +(mean[m] - mean[base]).toFixed(5), ci95: [+ds[Math.floor(0.025 * ds.length)].toFixed(5), +ds[Math.floor(0.975 * ds.length) - 1].toFixed(5)] };
    }
    report[g] = { n: N, mean: Object.fromEntries(Object.entries(mean).map(([k, v]) => [k, +v.toFixed(5)])), baseline_minus_intraday: diffs };
  }
  return report;
}
const gfns = [(r) => `group:${stationGroup(r.station)}`, (r) => `hour:${hourBucket(r.h)}`, (r) => `group_hour:${stationGroup(r.station)}|${hourBucket(r.h)}`];
log('scoring holdout', testT.length);
const L = losses(testT);
const report = {};
for (const metric of ['brier', 'bll', 'exact']) report[metric] = bootstrapReport(testT, Object.fromEntries(Object.entries(L.out).map(([m, v]) => [m, v[metric]])), 'intraday_v21', gfns);
const BASELINES = ['intraday_v20', 'prewindow_v11', 'persistence', 'climatology_remaining'];
const gate = Object.fromEntries(BASELINES.map((m) => [m, ['brier', 'bll'].every((k) => report[k].ALL.baseline_minus_intraday[m].ci95[0] > 0)]));
const state = Object.values(gate).every(Boolean) ? 'RESEARCH' : 'SHADOW';
const worse = []; for (const k of ['brier', 'bll']) for (const [g, v] of Object.entries(report[k])) for (const m of ['intraday_v20', 'prewindow_v11', 'persistence']) if (v.baseline_minus_intraday[m].ci95[1] < 0) worse.push({ metric: k, group: g, vs: m, ...v.baseline_minus_intraday[m], n: v.n });
const lastCut = trainT.filter((r) => r.h === 22); const eHist = {}; for (const r of lastCut) eHist[r.E] = (eHist[r.E] || 0) + 1;
const now = new Date().toISOString();
const artifact = {
  model_id: 'pbe-weather-maxtemp-intraday', version: '2.1.0', generation: 'intraday-v2', state, record_type: 'live', event_type: 'MAX_TEMP_BUCKET', designation_rules: 'designation-intraday/1',
  supersedes_input_of: '2.0.0 (adds METAR 6-hour maximum groups to the observed max so far; v2.0 artifact unchanged)',
  method: `As v2.0, with M = round(max(hourly/special ASOS tmpf, METAR 6-h max groups whose whole 6-h period lies inside the window)). Anchor ${TANCHOR}; levels ${TL.join(' -> ')}; selected on 2025-01..06 validation exact-degree log loss.`,
  selected_candidate: selected, selection_validation: selection, below_obs_max_selection: belowSelection,
  support: SUPPORT, anchor: TANCHOR, levels: TL, alphas: TA, tables: finalArt.tables, below_obs_max: finalArt.below_obs_max ?? null,
  six_hour_max_rule: { field: 'max6_f (METAR remarks 1snTTT, tenths degC -> degF)', attributed_to: 'METAR valid time', counted_if: 'valid_at - 6 h >= window start AND valid_at < window end AND available_at <= now', available_at: `valid_at + ${OBS_PUBLICATION_LAG_MIN} min`, source: 'IEM ASOS archive raw METAR (data=metar, routine reports), decoded by parseMetarSixHour' },
  rounding_conversion_risk: { definition: 'E at the 22 LST cutoff (training): CLI max minus round(max(hourly tmpf, usable 6-h max))', e_histogram: eHist, n: lastCut.length },
  observation_rule: { exact_station_only: true, valid_inside_window: true, publication_lag_min: OBS_PUBLICATION_LAG_MIN },
  guidance_rule: `NBM (NBS) day max; run usable at cycle + 5 h and <= ${GUIDANCE_MAX_AGE_H} h old; GFS fallback unvalidated (engine fails closed by default)`,
  split: { selection_fit: '2023-01-03..2024-12-31', selection_validate: '2025-01-01..2025-06-30', final_train: '2023-01-03..2025-06-30', holdout: '2025-07-01..2026-09-29 (scored once for v2.1)' },
  cutoffs_local_standard_hours: TEMP_HOURS, station_groups: STATION_GROUPS, target: 'NOAA RCC-ACIS daily max at the CLI site (final NWS CLI)',
  publication: 'rawProbability is the calibrated table value; probability is whole-percent with a 1%/99% publication-precision floor/ceiling (not a model bound)',
  training: { cases: trainT.length, with_max6: trainT.filter((r) => r.max6 !== null).length },
  holdout: { cases: testT.length, gate, gate_rule: 'RESEARCH only if the 95% date-cluster bootstrap CI of (baseline - v2.1) is > 0 on the full holdout for 2-degree-bucket Brier AND bucket log loss vs v2.0, pre-window v1.1, persistence and climatology-of-remaining', significant_worse_subgroups: worse },
  generated_at: now,
};
await writeFile('src/weather/artifacts/temp-intraday-v2.1.json', JSON.stringify(artifact) + '\n');
const calibTable = (c) => c.map((b, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, n: b.n, mean_p: b.n ? +(b.sp / b.n).toFixed(4) : null, observed: b.n ? +(b.so / b.n).toFixed(4) : null }));
await writeFile(join(DIR, 'evidence-v21.json'), JSON.stringify({ generated_at: now, selected, selection, belowSelection, state, gate, report, worse, calibration: Object.fromEntries(Object.entries(L.calib).map(([m, c]) => [m, calibTable(c)])), eHist }, null, 1));
log('STATE', state, JSON.stringify(gate));
for (const k of ['brier', 'bll', 'exact']) log(k, JSON.stringify(report[k].ALL));
log('worse', JSON.stringify(worse));
