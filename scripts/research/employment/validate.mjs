#!/usr/bin/env node
// Employment V1, Stages 4-6: chronological walk-forward validation and the PRE-REGISTERED gate (protocol section 5 +
// Amendment A1) for one target. Reads only the frozen as-published ledgers in data/employment (hashes checked against
// data/employment/LEDGER_FREEZE.json). Writes the evidence JSON.
//   node scripts/research/employment/validate.mjs u3|payrolls [out.json]
// U-3 first; payrolls only after the U-3 verdict is recorded (owner order).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { blockBootstrap, pitHistogram, reliability, scoreDistribution, scoreThresholds } from '../../../src/macro/cpi/scoring.js';
import { buildDataset, CUTOFF_RULE, FEATURE_VERSION } from '../../../src/macro/employment/features.js';
import { HYPER, MODEL_VERSION, PAY_FAMILIES, payLadder, toPayUnits, U3_FAMILIES, u3Ladder } from '../../../src/macro/employment/models.js';

const targetName = process.argv[2];
const TARGETS = {
  // y in published units: U-3 percent (0.1 grid); payrolls in 10k-person units (0.1 grid step = 1,000 persons)
  u3: { kalshi: 'KXU3', families: U3_FAMILIES, status: (r) => r.u3, y: (r) => r.target.u3, releaseAt: (r) => r.target.u3_release_at, ladder: (r) => u3Ladder(r.anchor_u3), anchor: (r) => r.anchor_u3 },
  payrolls: { kalshi: 'KXPAYROLLS', families: PAY_FAMILIES, status: (r) => r.payroll, y: (r) => (r.target.payroll_change_k === null ? null : toPayUnits(r.target.payroll_change_k)), releaseAt: (r) => r.target.payroll_release_at, ladder: () => payLadder(), anchor: (r) => r.features.PAY_L1 },
};
const T = TARGETS[targetName];
if (!T) { console.error('usage: validate.mjs u3|payrolls [out.json]'); process.exit(2); }
const out = process.argv[3] || `docs/research/employment-v1-${targetName}-evidence.json`;
const read = (p) => readFileSync(p, 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const files = { releases: 'data/employment/bls-empsit-releases-v1.json', firstPrints: 'data/employment/bls-empsit-first-prints-v1.json', claims: 'data/employment/dol-claims-releases-v1.json' };
const raw = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, read(p)]));
// the ledgers must be byte-identical to the freeze recorded (and committed) before any fit
const freeze = JSON.parse(read('data/employment/LEDGER_FREEZE.json'));
for (const [k, p] of Object.entries(files)) if (freeze.files[p]?.sha256 !== sha(raw[k])) throw new Error(`ledger ${p} differs from LEDGER_FREEZE.json`);
const releases = JSON.parse(raw.releases).releases;
const firstPrints = JSON.parse(raw.firstPrints).months;
const claims = JSON.parse(raw.claims).records;

const GATE = Object.freeze({ metric: 'mean per-origin ladder binary log loss (floor 1e-4)', ciLowerAbove: 0, coverage80: [0.72, 0.88], bootstrap: { block: 12, reps: 2000, seed: 20261008 } });

// ---------------------------------------------------------------- dataset + leakage guards
const rows = buildDataset({ releases, claims, firstPrints }).sort((a, b) => a.month.localeCompare(b.month));
for (const r of rows) {
  if (T.status(r).status === 'OK' && !(r.inputs_available_at_max <= r.cutoff_at)) throw new Error(`LEAK: ${r.month} input available ${r.inputs_available_at_max} after cutoff ${r.cutoff_at}`);
  if (!(r.cutoff_at < r.release_at)) throw new Error(`cutoff not before release for ${r.month}`);
}
const datasetSha = sha(JSON.stringify(rows));
const usable = rows.filter((r) => T.status(r).status === 'OK' && T.y(r) !== null);
const noForecast = rows.filter((r) => T.status(r).status !== 'OK' || T.y(r) === null).map((r) => ({ month: r.month, reason: T.status(r).status !== 'OK' ? T.status(r).reason : 'TARGET_NEVER_PUBLISHED', missing: T.status(r).missing ?? null }));

// ---------------------------------------------------------------- walk-forward
const models = Object.keys(T.families);
const perOrigin = [];
for (const origin of usable) {
  const train = usable.filter((r) => r.month < origin.month && T.releaseAt(r) <= origin.cutoff_at);
  for (const r of train) if (!(T.releaseAt(r) <= origin.cutoff_at) || !(r.cutoff_at < origin.cutoff_at)) throw new Error('fold guard'); // explicit
  if (train.length < HYPER.minTrain) continue;
  const y = T.y(origin); const ladder = T.ladder(origin);
  const rec = { month: origin.month, cutoff_at: origin.cutoff_at, anchor: T.anchor(origin), y, n_train: train.length, scores: {} };
  for (const m of models) {
    const fam = T.families[m];
    const pred = fam.fit(train)(origin);
    if (pred === null) { rec.scores[m] = null; continue; }
    if (fam.kind === 'threshold-function') { const s = scoreThresholds(pred.probAbove, y, ladder); rec.scores[m] = { brier: s.brier, logLoss: s.logLoss, pairs: s.pairs }; continue; }
    const s = scoreDistribution(pred, y, ladder);
    const q10 = pred.quantile(0.1); const q90 = pred.quantile(0.9);
    rec.scores[m] = { ...s, median: pred.quantile(0.5), q10, q90, in80: y >= q10 - 1e-9 && y <= q90 + 1e-9 };
  }
  perOrigin.push(rec);
}

// ---------------------------------------------------------------- aggregates
const isCovid = (m) => m >= '2020-03' && m <= '2021-12';
const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
function summary(m, subset) {
  const s = subset.map((o) => o.scores[m]).filter(Boolean);
  if (!s.length) return null;
  const out = { n: s.length, brier: avg(s.map((x) => x.brier)), logLoss: avg(s.map((x) => x.logLoss)), ece: reliability(s.flatMap((x) => x.pairs)).ece };
  if (s[0].rps !== undefined) Object.assign(out, { rps: avg(s.map((x) => x.rps)), bucketLogScore: avg(s.map((x) => x.bucketLogScore)), mae: avg(s.map((x) => x.absError)), sharpnessSd: avg(s.map((x) => x.sharpnessSd)), coverage80: avg(s.map((x) => (x.in80 ? 1 : 0))), pit: pitHistogram(s) });
  return out;
}
const all = perOrigin; const covid = perOrigin.filter((o) => isCovid(o.month)); const ex = perOrigin.filter((o) => !isCovid(o.month));
const results = Object.fromEntries(models.map((m) => [m, { all: summary(m, all), ex_2020_21: summary(m, ex), covid_2020_21: summary(m, covid) }]));

// ---------------------------------------------------------------- gate (written before fitting)
const common = perOrigin.filter((o) => models.every((m) => o.scores[m]));
const baselines = models.filter((m) => T.families[m].role === 'baseline');
const meanLL = (m, set) => avg(set.map((o) => o.scores[m].logLoss));
const best = baselines.map((m) => [m, meanLL(m, common)]).sort((a, b) => a[1] - b[1])[0][0];
const diffs = common.map((o) => o.scores[best].logLoss - o.scores.RIDGE_T_EWMA.logLoss); // > 0 = candidate better
const boot = blockBootstrap(diffs, GATE.bootstrap);
const vsEvery = Object.fromEntries(baselines.map((b) => [b, { logLoss: blockBootstrap(common.map((o) => o.scores[b].logLoss - o.scores.RIDGE_T_EWMA.logLoss), GATE.bootstrap), brier: blockBootstrap(common.map((o) => o.scores[b].brier - o.scores.RIDGE_T_EWMA.brier), GATE.bootstrap) }]));
const cov = avg(common.map((o) => (o.scores.RIDGE_T_EWMA.in80 ? 1 : 0)));
const pass = boot.ci95[0] > GATE.ciLowerAbove && cov >= GATE.coverage80[0] && cov <= GATE.coverage80[1];

const finalFit = T.families.RIDGE_T_EWMA.fit(usable.filter((r) => T.releaseAt(r) <= rows.at(-1).cutoff_at));
const evidence = {
  target: T.kalshi, units: targetName === 'u3' ? 'percent' : '10,000 persons (0.1 = 1,000 persons)', model_version: MODEL_VERSION, feature_version: FEATURE_VERSION, cutoff_rule: CUTOFF_RULE, hyper: HYPER, gate: GATE,
  ledger_freeze: { path: 'data/employment/LEDGER_FREEZE.json', sha256: sha(read('data/employment/LEDGER_FREEZE.json')) },
  inputs: Object.fromEntries(Object.entries(files).map(([k, p]) => [k, { path: p, sha256: sha(raw[k]) }])), dataset_sha256: datasetSha,
  origins: { n: perOrigin.length, common: common.length, first: perOrigin[0]?.month, last: perOrigin.at(-1)?.month, no_forecast: noForecast },
  results, best_baseline: best,
  verdict: { candidate: 'RIDGE_T_EWMA', vs_best_baseline: { baseline: best, mean_logloss_gain: boot.mean, ci95: boot.ci95 }, coverage80: cov, gate: pass ? 'PASS' : 'FAIL' },
  vs_every_baseline: vsEvery,
  final_fit_state: finalFit.state,
  per_origin: perOrigin.map((o) => ({ month: o.month, anchor: o.anchor, y: o.y, n_train: o.n_train, ...Object.fromEntries(models.map((m) => [m, o.scores[m] ? { logLoss: +o.scores[m].logLoss.toFixed(5), brier: +o.scores[m].brier.toFixed(5), ...(o.scores[m].median !== undefined ? { median: o.scores[m].median, q10: o.scores[m].q10, q90: o.scores[m].q90 } : {}) } : null])) })),
};
const json = JSON.stringify(evidence, null, 1);
writeFileSync(out, json);
console.log(JSON.stringify({ evidence_sha256: sha(json), dataset_sha256: datasetSha, origins: evidence.origins.n, common: common.length, first: evidence.origins.first, last: evidence.origins.last, no_forecast: noForecast.length, best_baseline: best, verdict: evidence.verdict,
  table: Object.fromEntries(models.map((m) => [m, results[m].all && { n: results[m].all.n, logLoss: +results[m].all.logLoss.toFixed(4), brier: +results[m].all.brier.toFixed(4), rps: results[m].all.rps && +results[m].all.rps.toFixed(4), cov80: results[m].all.coverage80 && +results[m].all.coverage80.toFixed(3), ece: +results[m].all.ece.toFixed(3) }])) }, null, 1));
