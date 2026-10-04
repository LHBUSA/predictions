// pbe-weather-maxtemp-intraday v2.2 (RESEARCH/SHADOW build): candidate live-weather features, selected on the
// 2025-01..06 validation split only (fit 2023-01..2024-12), exactly the v2.0/v2.1 split discipline.
// Candidates (each must earn its place on validation exact-degree log loss; MIN_GAIN nats, else dropped):
//   R  calibration resolution: 2-hourly (v2.x) vs hourly cutoffs
//   G  gap guidance: NBS TXN (v2.x) vs projected remaining peak (NBM TMP path peak + current obs-vs-path residual)
//   F  one extra table level keyed by a live-weather bucket: present weather regime, precip flag, sky, ceiling,
//      obscuration, obs-vs-guidance residual, remaining warming, NBM slope (1 h / 3 h), latest-vs-prior run change,
//      hours to the forecast peak — greedy, at most two, each placed mid-chain or last.
// The holdout (2025-07..2026-09) was ALREADY INSPECTED during v2.0/v2.1: it is scored once here for COMPARATIVE research
// only, never used for selection, and the result is not pristine validation. NO market data is read anywhere.
// Writes src/weather/artifacts/temp-intraday-v2.2.json (state SHADOW, research_gate_passed recorded separately)
// and <dir>/evidence-v22.json.
//   node --max-old-space-size=3500 scripts/research/intraday/train-eval-v22.mjs [intradayDir]
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { STATION_GROUPS, stationGroup, tempCellKeys, tempFinalDistribution, DEFICIT_MAX, rangeProbability, tableHour, tableHour22, tempCellKeys22, gapGuidance22, FEATURE_BUCKETS } from '../../../src/weather/intraday/models.js';
import { OBS_PUBLICATION_LAG_MIN, GUIDANCE_MAX_AGE_H } from '../../../src/weather/intraday/features.js';
import tempV1 from '../../../src/weather/artifacts/temp-v1.json' with { type: 'json' };
import tempV11 from '../../../src/weather/artifacts/temp-nbm-v1.1.json' with { type: 'json' };
import tempV20 from '../../../src/weather/artifacts/temp-intraday-v2.0.json' with { type: 'json' };
import tempV21 from '../../../src/weather/artifacts/temp-intraday-v2.1.json' with { type: 'json' };

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-intraday';
const B = Number(process.env.BOOT || 1000);
const MIN_GAIN = 0.002; // nats of validation exact-degree log loss a candidate must add to be kept
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const clampP = (p, a, b) => Math.min(b, Math.max(a, p));
const hourBucket = (h) => (h <= 6 ? 'h01-06' : h <= 12 ? 'h07-12' : h <= 16 ? 'h13-16' : 'h17-23');

// ---- load (compact rows) ----
const T = [];
let dropNoPath = 0;
{
  const rl = createInterface({ input: createReadStream(join(DIR, 'cases-v22.csv')) });
  let head = null; let I = null;
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  for await (const line of rl) {
    if (!head) { head = line.split(','); I = Object.fromEntries(head.map((h, i) => [h, i])); continue; }
    const c = line.split(',');
    const obsMax = num(c[I.obs_max]); const max6 = num(c[I.max6]);
    const r = {
      station: c[I.station], date: c[I.date], split: c[I.split], hh: +c[I.h], h: 0,
      M0: Math.round(obsMax), M: Math.round(max6 !== null ? Math.max(obsMax, max6) : obsMax), D: Math.round(num(c[I.cur])), txn: num(c[I.g]), g: 0,
      wx: c[I.wx_regime], obsc: c[I.wx_obsc] === '1', sky_rank: num(c[I.sky_rank]), ceil: num(c[I.ceil]),
      resid: num(c[I.resid]), rem_peak: num(c[I.rem_peak]), rem_peak_lead: num(c[I.rem_peak_lead]), s1: num(c[I.s1]), s3: num(c[I.s3]), path_chg: num(c[I.path_chg]),
      y_max: num(c[I.y_max]), pre_g: num(c[I.pre_g]), pre_art: c[I.pre_art], pre_lb: c[I.pre_lb], clim_mean: num(c[I.clim_mean]), clim_sd: num(c[I.clim_sd]),
    };
    if (r.rem_peak === null || r.resid === null) { dropNoPath += 1; continue; } // same case set for every method
    T.push(r);
  }
}
log('cases', T.length, 'dropped (no NBM TMP path at cutoff)', dropNoPath);

const SUPPORT = [-10, 45];
const ANCHOR = 'max_obs_guidance'; // v2.1's selected anchor; kept fixed (not re-searched)
const BASE_LEVELS = ['hour', 'hour_gap', 'hour_gap_drop', 'station_hour_gap', 'station_hour_gap_drop'];
const ALPHA_GRID = [2, 10, 40, 160];
const anchorOf = (r) => Math.max(r.M, Math.round(r.g));
function setMode(rows, { res, gap }) {
  for (const r of rows) { r.h = res === 'hourly' ? r.hh : tableHour(r.hh); r.g = gapGuidance22(gap, r); }
}
function buildTables(rows, levels) {
  const tables = Object.fromEntries(levels.map((l) => [l, {}]));
  for (const r of rows) {
    const keys = tempCellKeys22(r, levels);
    const e = Math.max(SUPPORT[0], Math.min(SUPPORT[1], r.y_max - anchorOf(r)));
    for (const l of levels) { const cell = (tables[l][keys[l]] ||= { n: 0, c: {} }); cell.n += 1; cell.c[e] = (cell.c[e] || 0) + 1; }
  }
  return tables;
}
function buildBelow(rows, alphaCell, alphaHour = 20) {
  const hour = {}; const hourGap = {}; const global = { n: 0, below: 0 }; const deficit = { n: 0, c: {} };
  for (const r of rows) {
    const k = tempCellKeys(r); const b = r.y_max < r.M ? 1 : 0;
    (hour[k.hour] ||= { n: 0, below: 0 }).n += 1; hour[k.hour].below += b;
    (hourGap[k.hour_gap] ||= { n: 0, below: 0 }).n += 1; hourGap[k.hour_gap].below += b;
    global.n += 1; global.below += b;
    if (b) { const d = Math.min(DEFICIT_MAX, r.M - r.y_max); deficit.n += 1; deficit.c[d] = (deficit.c[d] || 0) + 1; }
  }
  return { definition: 'y < M: final CLI max below the rounded observed max so far (hourly tmpf + 6-h max groups), pooled across stations', alpha_cell: alphaCell, alpha_hour: alphaHour, global, hour, hour_gap: hourGap, deficit };
}
const art = (tables, levels, alphas, below = null) => ({ support: SUPPORT, anchor: ANCHOR, levels, alphas, tables, ...(below ? { below_obs_max: below } : {}) });
const dist22 = (a, r) => tempFinalDistribution(a, r, tempCellKeys22(r, a.levels));
const pY = (d, y) => { const i = y - d.lo; return i >= 0 && i < d.p.length ? d.p[i] : 0; };
const exactLL = (a, rows) => { let s = 0; for (const r of rows) s -= Math.log(clampP(pY(dist22(a, r), r.y_max), 0.001, 0.999)); return s / rows.length; };

const fitT = T.filter((r) => r.split === 'fit'); const valT = T.filter((r) => r.split === 'val');
const trainT = T.filter((r) => r.split !== 'test'); const testT = T.filter((r) => r.split === 'test');
log('fit', fitT.length, 'val', valT.length, 'test', testT.length);

// tune alphas for levels[from..] sequentially (earlier alphas fixed), tables from fit, loss on val
function tune(levels, fixed, tables) {
  const alphas = { hour: 1, ...fixed };
  for (const l of levels.slice(1)) {
    if (alphas[l] !== undefined) continue;
    let best = null;
    for (const a of ALPHA_GRID) { const ll = exactLL(art(tables, levels.slice(0, levels.indexOf(l) + 1), { ...alphas, [l]: a }), valT); if (!best || ll < best.ll) best = { a, ll }; }
    alphas[l] = best.a;
  }
  return { alphas, ll: exactLL(art(tables, levels, alphas), valT) };
}
const selectionLog = [];
const record = (step, name, cfg, ll) => { selectionLog.push({ step, name, ...cfg, val_exact_log_loss: +ll.toFixed(5) }); log(step, name, ll.toFixed(5)); };

// ---- step R/G: resolution x gap source on the v2.1 level chain ----
const ALL_FEATS = Object.keys(FEATURE_BUCKETS);
const allLevelsFor = (levels) => levels;
let best = null;
for (const res of ['even', 'hourly']) {
  for (const gap of ['txn', 'proj', 'proj_half']) {
    setMode(T, { res, gap });
    const tables = buildTables(fitT, BASE_LEVELS);
    const { alphas, ll } = tune(BASE_LEVELS, {}, tables);
    record('R/G', `${res}|${gap}`, { res, gap, levels: BASE_LEVELS, alphas }, ll);
    if (!best || ll < best.ll) best = { res, gap, levels: BASE_LEVELS, alphas, ll };
  }
}
// v2.1-equivalent reference on validation (even hours, TXN, v2.1 chain, but fit on all hourly cutoffs): the R/G 'even|txn' row.
const refLL = selectionLog.find((s) => s.name === 'even|txn').val_exact_log_loss;
// prefer the simpler choice unless the gain clears MIN_GAIN
{
  const cand = selectionLog.filter((s) => s.step === 'R/G');
  const simple = cand.find((s) => s.name === 'even|txn');
  const ranked = [...cand].sort((a, b) => a.val_exact_log_loss - b.val_exact_log_loss);
  let pick = simple;
  const resWin = cand.find((s) => s.name === 'hourly|txn');
  if (resWin.val_exact_log_loss < simple.val_exact_log_loss - MIN_GAIN) pick = resWin;
  for (const s of ranked) if (s.gap !== 'txn' && s.res === pick.res && s.val_exact_log_loss < pick.val_exact_log_loss - MIN_GAIN) { pick = s; break; }
  best = { res: pick.res, gap: pick.gap, levels: pick.levels, alphas: pick.alphas, ll: pick.val_exact_log_loss };
}
log('R/G pick', best.res, best.gap, best.ll);

// ---- step F: greedy live-weather levels (max two) ----
setMode(T, best);
const kept = [];
for (let step = 1; step <= 2; step += 1) {
  let stepBest = null;
  for (const f of ALL_FEATS.filter((x) => !kept.some((k) => k.feat === x))) {
    const ext = kept.length ? `${kept[kept.length - 1].level}+${f}` : `hour_gap_drop+${f}`;
    for (const place of ['mid', 'last']) {
      let levels;
      if (place === 'mid') { const i = best.levels.indexOf(kept.length ? kept[kept.length - 1].level : 'hour_gap_drop'); levels = [...best.levels.slice(0, i + 1), ext, ...best.levels.slice(i + 1)]; }
      else levels = [...best.levels, ext];
      const tables = buildTables(fitT, levels);
      const { alphas, ll } = tune(levels, best.alphas, tables);
      record(`F${step}`, `${f}@${place}`, { feat: f, place, levels, alphas }, ll);
      if (!stepBest || ll < stepBest.ll) stepBest = { feat: f, place, level: ext, levels, alphas, ll };
    }
  }
  if (stepBest && stepBest.ll < best.ll - MIN_GAIN) { kept.push(stepBest); best = { ...best, levels: stepBest.levels, alphas: stepBest.alphas, ll: stepBest.ll }; log('KEEP', stepBest.feat, stepBest.place, stepBest.ll); }
  else { log('stop: no feature clears MIN_GAIN', stepBest?.feat, stepBest?.ll); break; }
}

// ---- below-max block (pooled, as v2.1) ----
const fitTables = buildTables(fitT, best.levels);
const belowSelection = { none: +exactLL(art(fitTables, best.levels, best.alphas), valT).toFixed(5) };
for (const a of [20, 100, 400]) belowSelection[`pooled_alpha_${a}`] = +exactLL(art(fitTables, best.levels, best.alphas, buildBelow(fitT, a)), valT).toFixed(5);
const belowChoice = Object.entries(belowSelection).sort((a, b) => a[1] - b[1])[0][0];
log('below', JSON.stringify(belowSelection), belowChoice);
const finalArt = art(buildTables(trainT, best.levels), best.levels, best.alphas, belowChoice === 'none' ? null : buildBelow(trainT, Number(belowChoice.split('_').pop())));
// diagnostic: the R/G-only model (no live-weather level) refit on train, to attribute any holdout change
const rgOnly = selectionLog.find((s) => s.step === 'R/G' && s.res === best.res && s.gap === best.gap);
const rgArt = art(buildTables(trainT, rgOnly.levels), rgOnly.levels, rgOnly.alphas, belowChoice === 'none' ? null : buildBelow(trainT, Number(belowChoice.split('_').pop())));

// ---- holdout scoring (comparative only: holdout already inspected in v2.0/v2.1) ----
function v1Range(r, lo, hi) {
  const a = r.pre_art === 'v1.1' ? tempV11 : tempV1;
  const t = a.station_residuals?.[r.station]?.[r.pre_lb] || a.pooled_residuals[r.pre_lb];
  let hit = 0;
  for (const [e, c] of Object.entries(t.counts)) { const y = Math.round(r.pre_g + Number(e)); if (y >= lo && y <= hi) hit += c; }
  return clampP((hit + 0.5) / (t.n + 1), ...a.probability_bounds);
}
const Phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function climRange(r, lo, hi) {
  const cdf = (k) => (k < r.M ? 0 : Phi((k + 0.5 - r.clim_mean) / r.clim_sd));
  const a = Math.max(lo, r.M); if (hi < a) return 0;
  return cdf(Math.min(hi, 400)) - (a - 1 < r.M ? 0 : cdf(a - 1));
}
setMode(testT, best);
const DIST = {
  intraday_v22: (r) => dist22(finalArt, r),
  v22_rg_only: (r) => dist22(rgArt, r),
  intraday_v21: (r) => tempFinalDistribution(tempV21, { station: r.station, h: tableHour(r.hh), M: r.M, D: r.D, g: r.txn }),
  intraday_v20: (r) => tempFinalDistribution(tempV20, { station: r.station, h: tableHour(r.hh), M: r.M0, D: r.D, g: r.txn }),
};
const METHODS = [...Object.keys(DIST), 'prewindow_v11', 'persistence', 'climatology_remaining'];
const bucketsFor = (r) => { const c = Math.round(r.pre_g); return [[-Infinity, c - 6], [c - 5, c - 4], [c - 3, c - 2], [c - 1, c], [c + 1, c + 2], [c + 3, c + 4], [c + 5, Infinity]]; };
const out = {}; const calib = {};
for (const m of METHODS) { out[m] = { brier: new Float64Array(testT.length), bll: new Float64Array(testT.length), exact: new Float64Array(testT.length) }; calib[m] = Array.from({ length: 10 }, () => ({ n: 0, sp: 0, so: 0 })); }
testT.forEach((r, i) => {
  const bk = bucketsFor(r);
  const d = Object.fromEntries(Object.entries(DIST).map(([m, fn]) => [m, fn(r)]));
  const rangeFn = { ...Object.fromEntries(Object.keys(DIST).map((m) => [m, (lo, hi) => rangeProbability(d[m], lo, hi)])), prewindow_v11: (lo, hi) => v1Range(r, lo, hi), persistence: (lo, hi) => (r.M >= lo && r.M <= hi ? 1 : 0), climatology_remaining: (lo, hi) => climRange(r, lo, hi) };
  const exactFn = { ...Object.fromEntries(Object.keys(DIST).map((m) => [m, () => clampP(pY(d[m], r.y_max), 0.001, 0.999)])), prewindow_v11: () => v1Range(r, r.y_max, r.y_max), persistence: () => (r.y_max === r.M ? 0.99 : 0.01), climatology_remaining: () => clampP(climRange(r, r.y_max, r.y_max), 0.001, 0.999) };
  for (const m of METHODS) {
    let br = 0; let ll = 0;
    for (const [lo, hi] of bk) {
      const p = clampP(rangeFn[m](lo, hi), 0.01, 0.99); const o = r.y_max >= lo && r.y_max <= hi ? 1 : 0;
      br += (p - o) ** 2; ll -= o ? Math.log(p) : Math.log(1 - p);
      const cb = calib[m][Math.min(9, Math.floor(p * 10))]; cb.n += 1; cb.sp += p; cb.so += o;
    }
    out[m].brier[i] = br / bk.length; out[m].bll[i] = ll / bk.length; out[m].exact[i] = -Math.log(exactFn[m]());
  }
});
log('scored holdout', testT.length);
function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapReport(rows, series, base, groupFns) {
  const dates = [...new Set(rows.map((r) => r.date))].sort(); const di = new Map(dates.map((d, i) => [d, i]));
  const methods = Object.keys(series); const groups = new Map();
  const ensure = (g) => { if (!groups.has(g)) groups.set(g, { n: new Float64Array(dates.length), s: Object.fromEntries(methods.map((m) => [m, new Float64Array(dates.length)])) }); return groups.get(g); };
  rows.forEach((r, i) => { const d = di.get(r.date); for (const g of ['ALL', ...groupFns.map((f) => f(r))]) { const G = ensure(g); G.n[d] += 1; for (const m of methods) G.s[m][d] += series[m][i]; } });
  const rnd = mulberry(20261004);
  const draws = Array.from({ length: B }, () => Int32Array.from({ length: dates.length }, () => Math.floor(rnd() * dates.length)));
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
const gfns = [(r) => `group:${stationGroup(r.station)}`, (r) => `hour:${hourBucket(r.hh)}`, (r) => `group_hour:${stationGroup(r.station)}|${hourBucket(r.hh)}`, (r) => `regime:${r.wx}`, (r) => `regime_hour:${r.wx}|${hourBucket(r.hh)}`, (r) => `parity:${r.hh % 2 ? 'odd' : 'even'}`];
const report = {};
for (const metric of ['brier', 'bll', 'exact']) { report[metric] = bootstrapReport(testT, Object.fromEntries(Object.entries(out).map(([m, v]) => [m, v[metric]])), 'intraday_v22', gfns); log('boot', metric); }
const BASELINES = ['intraday_v21', 'intraday_v20', 'prewindow_v11', 'persistence', 'climatology_remaining'];
const gate = Object.fromEntries(BASELINES.map((m) => [m, ['brier', 'bll'].every((k) => report[k].ALL.baseline_minus_intraday[m].ci95[0] > 0)]));
const researchGatePassed = Object.values(gate).every(Boolean);
const worse = []; for (const k of ['brier', 'bll']) for (const [g, v] of Object.entries(report[k])) for (const m of ['intraday_v21', 'intraday_v20', 'prewindow_v11', 'persistence']) if (v.baseline_minus_intraday[m].ci95[1] < 0) worse.push({ metric: k, group: g, vs: m, ...v.baseline_minus_intraday[m], n: v.n });
const calibTable = (c) => c.map((b, i) => ({ bin: `${i * 10}-${i * 10 + 10}%`, n: b.n, mean_p: b.n ? +(b.sp / b.n).toFixed(4) : null, observed: b.n ? +(b.so / b.n).toFixed(4) : null }));
const now = new Date().toISOString();
const usesWx = best.levels.some((l) => /\+(wx|precip|sky|ceil|obsc)/.test(l));
const usesPath = best.gap !== 'txn' || best.levels.some((l) => /\+(resid|warm|slope3|slope1|path|lead)/.test(l));
const artifact = {
  model_id: 'pbe-weather-maxtemp-intraday', version: '2.2.0', generation: 'intraday-v2', state: 'SHADOW', research_gate_passed: researchGatePassed,
  state_rule: 'Owner 2026-10-04: v2.2 does not replace v2.1 live production; state is SHADOW regardless of the gate. research_gate_passed is the existing gate evaluated on the NON-PRISTINE 2025-07..2026-09 holdout (already inspected during v2.0/v2.1).',
  record_type: 'shadow', event_type: 'MAX_TEMP_BUCKET', designation_rules: 'designation-intraday-shadow/1',
  method: `v2.1 hierarchical empirical E-tables (anchor ${ANCHOR}) with candidate live-weather inputs selected on 2025-01..06 validation: calibration hours ${best.res}; gap guidance ${best.gap}; levels ${best.levels.join(' -> ')}.`,
  calibration_resolution: best.res, gap_source: best.gap, requires: { observation_weather_fields: usesWx, nbm_tmp_path: usesPath },
  selected_features: kept.map((k) => ({ feature: k.feat, placement: k.place, level: k.level })), min_gain_nats: MIN_GAIN, selection_validation: selectionLog, below_obs_max_selection: belowSelection,
  support: SUPPORT, anchor: ANCHOR, levels: best.levels, alphas: best.alphas, tables: finalArt.tables, below_obs_max: finalArt.below_obs_max ?? null,
  feature_buckets: 'FEATURE_BUCKETS in src/weather/intraday/models.js (fixed before fitting)',
  observation_rule: { exact_station_only: true, valid_inside_window: true, publication_lag_min: OBS_PUBLICATION_LAG_MIN, weather_state: 'newest usable report (present-weather group + sky condition)' },
  guidance_rule: `NBS run usable at cycle + 5 h and <= ${GUIDANCE_MAX_AGE_H} h old; TXN day max; TMP path 3-hourly, linearly interpolated, newest usable run covering each hour`,
  split: { selection_fit: '2023-01-03..2024-12-31', selection_validate: '2025-01-01..2025-06-30', final_train: '2023-01-03..2025-06-30', holdout: '2025-07-01..2026-09-29 (NON-PRISTINE: inspected during v2.0/v2.1; comparative research only)' },
  target: 'NOAA RCC-ACIS daily max at the CLI site (final NWS CLI)', station_groups: STATION_GROUPS,
  publication: 'SHADOW: never public. rawProbability is the calibrated table value; probability is whole-percent within [1%, 99%].',
  training: { cases: trainT.length, dropped_no_nbm_path: dropNoPath },
  holdout: { cases: testT.length, pristine: false, gate, research_gate_passed: researchGatePassed, gate_rule: 'research_gate_passed only if the 95% date-cluster bootstrap CI of (baseline - v2.2) is > 0 on the full holdout for 2-degree-bucket Brier AND bucket log loss vs v2.1, v2.0, pre-window v1.1, persistence and climatology-of-remaining', significant_worse_subgroups: worse },
  generated_at: now,
};
await writeFile('src/weather/artifacts/temp-intraday-v2.2.json', JSON.stringify(artifact) + '\n');
await writeFile(join(DIR, 'evidence-v22.json'), JSON.stringify({ generated_at: now, best: { res: best.res, gap: best.gap, levels: best.levels, alphas: best.alphas, val: best.ll }, refLL, kept, selectionLog, belowSelection, gate, researchGatePassed, report, worse, calibration: Object.fromEntries(Object.entries(calib).map(([m, c]) => [m, calibTable(c)])), dropNoPath }, null, 1));
log('GATE', researchGatePassed, JSON.stringify(gate));
for (const k of ['brier', 'bll', 'exact']) log(k, JSON.stringify(report[k].ALL));
log('worse', worse.length, JSON.stringify(worse.slice(0, 20)));
