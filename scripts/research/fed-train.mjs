// Fed decision model v1 calibration (research). Every scheduled FOMC decision 1994+ (data/fomc/scheduled-decisions.json).
// Point-in-time: features at cutoff C use daily H.15 values dated <= C - 2 days (published with a lag; never revised).
// Train: meetings 1994-2015. Holdout: 2016-2026. Baselines: training climatology and previous-decision persistence.
//   node scripts/research/fed-train.mjs [scratchDir]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FED_OUTCOMES, FED_FEATURES, outcomeOfChange, fedFeatureVector, fitOrderedLogit, orderedProbabilities, parseFredCsv, valueAsOf, targetMidAsOf } from '../../src/macro/fed-model.js';

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const HORIZONS = [1, 7, 14, 21, 28];
const csv = async (id) => parseFredCsv(await readFile(join(DIR, `fred-${id}.csv`), 'utf8'));
const [cmt6, legacy, upper, lower] = await Promise.all(['DGS6MO', 'DFEDTAR', 'DFEDTARU', 'DFEDTARL'].map(csv));
const reg = JSON.parse(await readFile(new URL('../../data/fomc/scheduled-decisions.json', import.meta.url), 'utf8')).meetings;
const decided = reg.filter((m) => m.changeBps !== null);
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const cases = [];
for (let i = 1; i < decided.length; i += 1) {
  const m = decided[i];
  const prev = Math.sign(decided[i - 1].changeBps);
  for (const h of HORIZONS) {
    const asOf = shift(m.meetingDate, -h - 2);
    const base = shift(decided[i - 1].meetingDate, 2);
    if (base > asOf) continue;
    const spreadAt = (d) => { const b = valueAsOf(cmt6, d); const mid = targetMidAsOf({ legacy, upper, lower }, d); return b && mid ? b.value - mid.value : null; };
    const c6 = spreadAt(asOf); const b6 = spreadAt(base);
    if (c6 === null || b6 === null) continue;
    cases.push({ date: m.meetingDate, h, d6: c6 - b6, c6, prev, horizonDays: h, y: FED_OUTCOMES.indexOf(outcomeOfChange(m.changeBps)), split: m.meetingDate < '2016-01-01' ? 'train' : 'test' });
  }
}
const train = cases.filter((c) => c.split === 'train');
const test = cases.filter((c) => c.split === 'test');
const params = fitOrderedLogit(train.map(fedFeatureVector), train.map((c) => c.y));

const clim = FED_OUTCOMES.map((_, k) => (train.filter((c) => c.y === k).length + 0.5) / (train.length + 2.5));
const persist = {};
for (const p of [-1, 0, 1]) { const rows = train.filter((c) => c.prev === p); persist[p] = FED_OUTCOMES.map((_, k) => (rows.filter((c) => c.y === k).length + 0.5) / (rows.length + 2.5)); }
const methods = { model: (c) => orderedProbabilities(params, fedFeatureVector(c)), climatology: () => clim, persistence: (c) => persist[c.prev] };
function evaluate(rows) {
  return Object.fromEntries(Object.entries(methods).map(([name, fn]) => {
    let brier = 0; let ll = 0; let hits = 0;
    for (const c of rows) { const p = fn(c); brier += p.reduce((s, v, k) => s + (v - (k === c.y ? 1 : 0)) ** 2, 0); ll -= Math.log(Math.max(1e-6, p[c.y])); if (p.indexOf(Math.max(...p)) === c.y) hits += 1; }
    return [name, { multiclass_brier: +(brier / rows.length).toFixed(4), log_loss: +(ll / rows.length).toFixed(4), top_outcome_accuracy: +(hits / rows.length).toFixed(3) }];
  }));
}
const artifact = {
  model_id: 'pbe-fed-decision', version: '1.0.0', status: 'SHADOW',
  target: 'Change in the federal funds target (upper bound) announced at a scheduled FOMC meeting, bucketed as Kalshi KXFEDDECISION: cut >25 / cut 25 / hold / hike 25 / hike >25 bps',
  method: 'Ordered logit on the official daily 6-month constant-maturity Treasury yield (H.15) minus the target midpoint and its change since the previous decision, previous decision direction and horizon; features chosen on 1994-2007/2008-2015 validation; trained on scheduled meetings 1994-2015',
  outcomes: FED_OUTCOMES, features: FED_FEATURES, params, probability_bounds: [0.01, 0.97],
  point_in_time_rule: 'features use daily values dated <= cutoff - 2 days; target from DFEDTAR (<=2008-12-15) / DFEDTARU+DFEDTARL',
  training: { meetings_from: '1994', meetings_to: '2015-12', cases: train.length, horizons_days: HORIZONS },
  holdout: { meetings_from: '2016-01', meetings_to: decided.at(-1).meetingDate, cases: test.length, metrics: evaluate(test), by_horizon: Object.fromEntries(HORIZONS.map((h) => [`${h}d`, evaluate(test.filter((c) => c.h === h)).model])) },
  in_sample: evaluate(train),
  registry: { meetings: reg.length, decided: decided.length },
  generated_at: new Date().toISOString(),
};
await mkdir(new URL('../../src/macro/artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../../src/macro/artifacts/fed-v1.json', import.meta.url), JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ params, holdout: artifact.holdout.metrics, by_horizon: artifact.holdout.by_horizon, train: train.length, test: test.length }, null, 1));
