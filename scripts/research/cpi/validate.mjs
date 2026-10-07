#!/usr/bin/env node
// CPI V1 chronological (expanding-window, rolling-origin) validation.
//
// For each evaluation release, every family is refit on the observations whose
// CPI release was PUBLISHED at or before that row's forecast cutoff, then
// scored on the published value. No random splits anywhere.
//
// Usage: node scripts/research/cpi/validate.mjs [dataset.json] [out-evidence.json]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { FAMILIES, FEATURE_SETS, HYPER, MODEL_VERSION, withHyper } from '../../../src/macro/cpi/models.js';
import { TARGETS } from '../../../src/macro/cpi/features.js';
import { blockBootstrap, mulberry32, pitHistogram, reliability, scoreDistribution, scoreThresholds, thresholdsFor } from '../../../src/macro/cpi/scoring.js';
import { probabilityAboveInflationThreshold } from '../../../src/models/inflation-v0.js';

export const VALIDATION_VERSION = 'cpi-v1-validation/1';
const CANDIDATE = 'RIDGE_T_EWMA';
const BASELINES = ['CLIMATOLOGY', 'PERSISTENCE_GAUSS', 'PERSISTENCE_EMPIRICAL', 'ROLLING_MEAN_GAUSS'];
const RANDOM_LABEL_SEEDS = [11, 23, 37, 41, 53];

export function trainingRows(rows, row) {
  const cutoff = Date.parse(row.cutoffAt);
  return rows.filter((r) => Date.parse(r.releaseAt) <= cutoff);
}

function requiredFeatures(target) {
  const s = new Set();
  for (const f of Object.values(FAMILIES)) for (const n of f.features(target)) s.add(n);
  if (target === 'headline_yoy') ['H_YOY_L1', 'C_YOY_L1', 'H_L1', 'C_L1'].forEach((n) => s.add(n));
  return [...s];
}

function v0Prob(row, t) {
  // inflation-threshold-baseline 0.1.0 fed exactly what it was built to read:
  // point-in-time YoY/MoM values. energyMoM/shelterYoY are omitted, so v0 applies
  // its own built-in defaults (0 and coreYoY) - those defaults are part of the
  // baseline being measured, not features of CPI V1.
  const f = row.features;
  return probabilityAboveInflationThreshold({
    headlineYoY: f.H_YOY_L1,
    coreYoY: f.C_YOY_L1,
    headlineMoM: f.H_L1,
    coreMoM: f.C_L1,
    priorHeadlineYoY: row.priorHeadlineYoY
  }, t).probability;
}

function regimeOf(row) {
  const y = row.features.H_YOY_L1;
  if (!Number.isFinite(y)) return 'unknown';
  if (y < 2) return 'low (<2%)';
  if (y < 4) return 'moderate (2-4%)';
  return 'high (>=4%)';
}

function periodOf(month) {
  if (month < '2012-01') return 'pre-2012';
  if (month < '2020-03') return '2012-01..2020-02 calm';
  if (month < '2021-04') return '2020-03..2021-03 covid';
  if (month < '2023-07') return '2021-04..2023-06 surge';
  return '2023-07..present';
}

function summarize(scores) {
  const n = scores.length;
  const avg = (k) => scores.reduce((s, x) => s + x[k], 0) / n;
  return {
    n,
    brier: avg('brier'),
    logLoss: avg('logLoss'),
    rps: n && scores[0].rps !== undefined ? avg('rps') : null,
    bucketLogScore: n && scores[0].bucketLogScore !== undefined ? avg('bucketLogScore') : null,
    mae: n && scores[0].absError !== undefined ? avg('absError') : null,
    rmse: n && scores[0].sqError !== undefined ? Math.sqrt(avg('sqError')) : null,
    sharpnessSd: n && scores[0].sharpnessSd !== undefined ? avg('sharpnessSd') : null
  };
}

// Observations usable for a target: published target value and every feature
// any compared family needs (one common sample for all families).
export function usableRows(observations, target, horizon) {
  const need = requiredFeatures(target);
  return observations
    .filter((o) => o.horizon === horizon && Number.isFinite(o.targets[target]))
    .filter((o) => need.every((n) => Number.isFinite(o.features[n])))
    .map((o) => ({ ...o, y: o.targets[target] }))
    .sort((a, b) => a.releaseAt.localeCompare(b.releaseAt));
}

export function runTarget(observations, target, horizon, { permuteSeed = null, only = null } = {}) {
  const rows = usableRows(observations, target, horizon);
  // prior headline YoY for the v0 baseline = first print for M-2 = the
  // anchor of the previous row (both published before this cutoff)
  rows.forEach((r, i) => { r.priorHeadlineYoY = i > 0 ? rows[i - 1].features.H_YOY_L1 : r.features.H_YOY_L1; });

  const evalRows = [];
  for (const row of rows) {
    let train = trainingRows(rows, row);
    if (train.length < HYPER.minTrain) continue;
    if (train.some((r) => r.referenceMonth >= row.referenceMonth)) throw new Error(`fold leak at ${row.referenceMonth}`);
    if (permuteSeed !== null) {
      const rand = mulberry32(permuteSeed + evalRows.length);
      const ys = train.map((r) => r.y);
      for (let i = ys.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [ys[i], ys[j]] = [ys[j], ys[i]]; }
      train = train.map((r, i) => ({ ...r, y: ys[i] }));
    }
    const th = thresholdsFor(target, row);
    const result = { referenceMonth: row.referenceMonth, cutoffAt: row.cutoffAt, trainN: train.length, trainLast: train[train.length - 1].referenceMonth, y: row.y, regime: regimeOf(row), period: periodOf(row.referenceMonth), scores: {} };
    const families = permuteSeed !== null ? [CANDIDATE] : only ? [only] : Object.keys(FAMILIES);
    for (const name of families) {
      const predict = FAMILIES[name].fit(train, target);
      const dist = predict(row);
      result.scores[name] = scoreDistribution(dist, row.y, th);
      if (name === CANDIDATE) {
        result.candidate = { median: dist.quantile(0.5), mean: dist.mean(), sd: dist.sd(), p10: dist.quantile(0.1), p90: dist.quantile(0.9) };
      }
    }
    if (target === 'headline_yoy' && permuteSeed === null && !only) {
      result.scores.INFLATION_V0 = scoreThresholds((t) => v0Prob(row, t), row.y, th);
    }
    evalRows.push(result);
  }
  return { rows: evalRows, usable: rows.length };
}

function aggregate(evalRows, target) {
  const names = Object.keys(evalRows[0].scores);
  const pooled = {};
  for (const n of names) pooled[n] = summarize(evalRows.map((r) => r.scores[n]));
  const slice = (keyFn) => {
    const groups = {};
    for (const r of evalRows) (groups[keyFn(r)] ??= []).push(r);
    const out = {};
    for (const [k, rs] of Object.entries(groups)) {
      out[k] = {};
      for (const n of names) out[k][n] = summarize(rs.map((r) => r.scores[n]));
    }
    return out;
  };
  const vs = {};
  for (const b of [...BASELINES, ...(target === 'headline_yoy' ? ['INFLATION_V0'] : []), 'RIDGE_GAUSS', 'RIDGE_EMPIRICAL', 'RIDGE_T_EWMA_NO_GAS']) {
    if (!pooled[b]) continue;
    vs[b] = {};
    for (const metric of ['brier', 'logLoss', ...(b === 'INFLATION_V0' ? [] : ['rps'])]) {
      // positive = candidate better (baseline score minus candidate score)
      const diffs = evalRows.map((r) => r.scores[b][metric] - r.scores[CANDIDATE][metric]);
      vs[b][metric] = blockBootstrap(diffs);
    }
  }
  const calibration = {};
  for (const n of names) {
    const pairs = evalRows.flatMap((r) => r.scores[n].pairs);
    calibration[n] = { ece: reliability(pairs).ece, ...(n === CANDIDATE || n === 'PERSISTENCE_GAUSS' ? { reliability: reliability(pairs).bins } : {}) };
    if (evalRows[0].scores[n].pitLow !== undefined) calibration[n].pit = pitHistogram(evalRows.map((r) => r.scores[n]));
  }
  // central interval coverage of the candidate
  const cov80 = evalRows.filter((r) => r.y >= r.candidate.p10 && r.y <= r.candidate.p90).length / evalRows.length;
  return {
    pooled,
    byYear: slice((r) => r.referenceMonth.slice(0, 4)),
    byRegime: slice((r) => r.regime),
    byPeriod: slice((r) => r.period),
    candidateVsOthers: vs,
    calibration,
    candidateCoverage80: cov80
  };
}

function stripPairs(rows) {
  return rows.map((r) => ({
    ...r,
    scores: Object.fromEntries(Object.entries(r.scores).map(([k, v]) => {
      const { pairs, ...rest } = v;
      return [k, rest];
    }))
  }));
}

// One-at-a-time sensitivity of the candidate to its pre-declared settings.
// Reported only; the frozen settings are never changed on these numbers.
export const SENSITIVITY = Object.freeze([
  { label: 'declared', override: {} },
  { label: 'ridgeLambda=0.5', override: { ridgeLambda: 0.5 } },
  { label: 'ridgeLambda=8', override: { ridgeLambda: 8 } },
  { label: 'ewmaHalfLife=12', override: { ewmaHalfLifeMonths: 12 } },
  { label: 'ewmaHalfLife=48', override: { ewmaHalfLifeMonths: 48 } },
  { label: 'studentNu=4', override: { studentNu: 4 } },
  { label: 'studentNu=10', override: { studentNu: 10 } }
]);

function sensitivity(observations, target) {
  return SENSITIVITY.map(({ label, override }) => {
    const rows = withHyper(override, () => runTarget(observations, target, 'T-1D', { only: CANDIDATE }).rows);
    return { label, ...summarize(rows.map((r) => r.scores[CANDIDATE])) };
  });
}

// SHADOW gate, per target, on the primary horizon (T-1D).
export const GATE = Object.freeze({
  baselines: BASELINES,
  requireCiLowerAboveZero: ['brier', 'logLoss'],
  maxEce: 0.05,
  coverage80: [0.72, 0.95],
  maxSliceBrierRatioVsBestBaseline: 1.15,
  minSliceN: 10
});

export function gateTarget(r) {
  const failures = [];
  for (const b of GATE.baselines) {
    for (const m of GATE.requireCiLowerAboveZero) {
      const ci = r.candidateVsOthers[b][m].ci95;
      if (!(ci[0] > 0)) failures.push(`${m} vs ${b}: 95% CI [${ci.map((x) => x.toFixed(4)).join(', ')}] does not exclude 0`);
    }
  }
  const ece = r.calibration[CANDIDATE].ece;
  if (ece > GATE.maxEce) failures.push(`ECE ${ece.toFixed(3)} > ${GATE.maxEce}`);
  const cov = r.candidateCoverage80;
  if (cov < GATE.coverage80[0] || cov > GATE.coverage80[1]) failures.push(`80% interval coverage ${cov.toFixed(2)} outside ${GATE.coverage80.join('-')}`);
  for (const [sliceName, slices] of [['period', r.byPeriod], ['regime', r.byRegime]]) {
    for (const [k, v] of Object.entries(slices)) {
      if (v[CANDIDATE].n < GATE.minSliceN) continue;
      const best = Math.min(...GATE.baselines.map((b) => v[b].brier));
      const ratio = v[CANDIDATE].brier / best;
      if (ratio > GATE.maxSliceBrierRatioVsBestBaseline) failures.push(`${sliceName} ${k}: Brier ${ratio.toFixed(2)}x best baseline`);
    }
  }
  return { verdict: failures.length ? 'FAIL' : 'PASS', failures };
}

export function validate(dataset) {
  const out = { targets: {} };
  for (const target of Object.keys(TARGETS)) {
    out.targets[target] = {};
    for (const horizon of dataset.horizons) {
      const { rows, usable } = runTarget(dataset.observations, target, horizon);
      const agg = aggregate(rows, target);
      const randomLabel = RANDOM_LABEL_SEEDS.map((seed) => summarize(runTarget(dataset.observations, target, horizon, { permuteSeed: seed }).rows.map((r) => r.scores[CANDIDATE])));
      out.targets[target][horizon] = {
        usableObservations: usable,
        evaluated: rows.length,
        firstEval: rows[0]?.referenceMonth,
        lastEval: rows[rows.length - 1]?.referenceMonth,
        ...agg,
        randomLabelControl: {
          seeds: RANDOM_LABEL_SEEDS,
          candidate: randomLabel,
          meanBrier: randomLabel.reduce((s, x) => s + x.brier, 0) / randomLabel.length,
          meanLogLoss: randomLabel.reduce((s, x) => s + x.logLoss, 0) / randomLabel.length
        },
        rows: stripPairs(rows)
      };
    }
    out.targets[target].sensitivity = sensitivity(dataset.observations, target);
    out.targets[target].gate = gateTarget(out.targets[target]['T-1D']);
  }
  return out;
}

function main() {
  const [dsPath = 'data/cpi/cpi-v1-dataset.json', out = 'docs/research/cpi-v1-evidence.json'] = process.argv.slice(2);
  const buf = readFileSync(dsPath);
  const dataset = JSON.parse(buf);
  const result = validate(dataset);
  const payload = {
    validationVersion: VALIDATION_VERSION,
    modelVersion: MODEL_VERSION,
    candidate: CANDIDATE,
    hyper: HYPER,
    targetFeatureSets: FEATURE_SETS,
    gateCriteria: GATE,
    dataset: { path: dsPath, sha256: createHash('sha256').update(buf).digest('hex'), datasetVersion: dataset.datasetVersion },
    ...result
  };
  // compact, 6-decimal numbers: the per-release rows make this file large
  const round = (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(6)) : v);
  writeFileSync(out, `${JSON.stringify(payload, round)}\n`);
  for (const [t, hs] of Object.entries(result.targets)) {
    console.log(`
#### ${t} GATE ${hs.gate.verdict}${hs.gate.failures.map((f) => `
   - ${f}`).join('')}`);
    for (const s of hs.sensitivity) console.log(`   sens ${s.label.padEnd(18)} brier ${s.brier.toFixed(4)} ll ${s.logLoss.toFixed(4)}`);
    for (const h of dataset.horizons) {
      const r = hs[h];
      console.log(`\n== ${t} ${h}: usable ${r.usableObservations}, evaluated ${r.evaluated} (${r.firstEval}..${r.lastEval}), cov80 ${r.candidateCoverage80.toFixed(2)}`);
      for (const [n, s] of Object.entries(r.pooled)) {
        console.log(`  ${n.padEnd(22)} brier ${s.brier.toFixed(4)} ll ${s.logLoss.toFixed(4)} rps ${s.rps?.toFixed(4) ?? '   -  '} mae ${s.mae?.toFixed(3) ?? '  - '} ece ${r.calibration[n].ece.toFixed(3)}`);
      }
      console.log(`  RANDOM-LABEL candidate   brier ${r.randomLabelControl.meanBrier.toFixed(4)} ll ${r.randomLabelControl.meanLogLoss.toFixed(4)}`);
      for (const [b, m] of Object.entries(r.candidateVsOthers)) {
        console.log(`  vs ${b.padEnd(22)} dBrier ${m.brier.mean.toFixed(4)} [${m.brier.ci95.map((x) => x.toFixed(4)).join(',')}]  dLL ${m.logLoss.mean.toFixed(4)} [${m.logLoss.ci95.map((x) => x.toFixed(4)).join(',')}]`);
      }
    }
  }
}

if (process.argv[1]?.endsWith('validate.mjs')) main();
