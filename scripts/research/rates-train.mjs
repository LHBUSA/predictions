// Rates path model calibration + chronological holdout (research). Synthetic Kalshi-style monthly "how high / how low"
// contracts on official daily par yields (FRED DGS5/7/10/30 == Treasury par curve). Forecast points: before the month
// (k=0) and after 3, 8, 13 published days. Strikes y0 +/- {0.02..0.30}; contracts already decided are excluded.
// Selection (EWMA lambda, residual model) on 2000-2017 only; holdout 2018-01..2026-09 scored once.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ewmaSigma, trailingSigma, simulateExtremes, crossProbability, seedFrom } from '../../src/rates/rates-model.js';

const DIR = 'D:/Workers/scratch/predictions-wx';
const TENORS = { 5: 'DGS5', 7: 'DGS7', 10: 'DGS10', 30: 'DGS30' };
const OFFSETS = [-0.30, -0.20, -0.12, -0.06, -0.02, 0.02, 0.06, 0.12, 0.20, 0.30];
const KS = [0, 3, 8, 13];
const PATHS = 1500;
const r2 = (x) => Math.round(x * 100) / 100;

const series = {};
for (const [t, id] of Object.entries(TENORS)) {
  const rows = (await readFile(`${DIR}/fred-${id}.csv`, 'utf8')).trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).filter(([, v]) => v && v !== '.').map(([d, v]) => [d, Number(v)]).filter(([, v]) => Number.isFinite(v));
  series[t] = rows;
}

// standardized residuals from TRAINING history only (<= 2017), per tenor, EWMA 0.94 scaled
function residualsFor(rows, lambda, until) {
  const out = []; let v = null;
  for (let i = 1; i < rows.length && rows[i][0] <= until; i += 1) {
    const c = rows[i][1] - rows[i - 1][1];
    if (v !== null && v > 0) out.push(c / Math.sqrt(v));
    v = v === null ? c * c + 1e-6 : lambda * v + (1 - lambda) * c * c;
  }
  return out.filter((z) => Number.isFinite(z) && Math.abs(z) < 12);
}

function cases(tenor, lambda, mode, residuals, from, to) {
  const rows = series[tenor];
  const out = [];
  const byMonth = new Map();
  rows.forEach(([d], i) => { const m = d.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(i); });
  for (const [month, idxs] of byMonth) {
    if (month < from || month > to || idxs.length < 15) continue;
    for (const k of KS) {
      const last = idxs[0] - 1 + k; // index of latest published value at forecast time
      if (last < 260) continue;
      const hist = rows.slice(0, last + 1).map((r) => r[1]);
      const changes = hist.slice(1).map((v, i) => v - hist[i]);
      const sigma = mode === 'baseline' ? trailingSigma(changes, 250) : ewmaSigma(changes.slice(-500), lambda);
      const y0 = hist[hist.length - 1];
      const seen = idxs.slice(0, k).map((i) => rows[i][1]);
      const runMax = seen.length ? Math.max(...seen) : -Infinity; const runMin = seen.length ? Math.min(...seen) : Infinity;
      const steps = idxs.length - k;
      const sim = simulateExtremes({ y0, sigma, steps, paths: PATHS, residuals: mode === 'baseline' ? null : residuals, seed: seedFrom(`${tenor}|${month}|${k}`) });
      const realized = idxs.map((i) => rows[i][1]);
      const fullMax = Math.max(...realized); const fullMin = Math.min(...realized);
      for (const off of OFFSETS) {
        const K = r2(y0 + off);
        if (off > 0 && !(runMax > K)) out.push({ month, tenor, k, dir: 'high', p: crossProbability(sim, { direction: 'high', level: K }), y: fullMax > K ? 1 : 0 });
        if (off < 0 && !(runMin < K)) out.push({ month, tenor, k, dir: 'low', p: crossProbability(sim, { direction: 'low', level: K }), y: fullMin < K ? 1 : 0 });
      }
    }
  }
  return out;
}
const metrics = (rows) => {
  const e = 1e-4; let b = 0; let l = 0;
  for (const r of rows) { const p = Math.min(1 - e, Math.max(e, r.p)); b += (p - r.y) ** 2; l -= r.y ? Math.log(p) : Math.log(1 - p); }
  const bins = Array.from({ length: 10 }, (_, i) => { const s = rows.filter((r) => Math.min(9, Math.floor(r.p * 10)) === i); return s.length ? { bin: `${i / 10}-${(i + 1) / 10}`, n: s.length, mean_p: +(s.reduce((a, r) => a + r.p, 0) / s.length).toFixed(3), observed: +(s.reduce((a, r) => a + r.y, 0) / s.length).toFixed(3) } : null; }).filter(Boolean);
  return { n: rows.length, brier: +(b / rows.length).toFixed(4), log_loss: +(l / rows.length).toFixed(4), base_rate: +(rows.reduce((a, r) => a + r.y, 0) / rows.length).toFixed(3), calibration: bins };
};

// ---- selection on training years only
const selection = {};
const residualSets = {};
for (const lambda of [0.90, 0.94, 0.97]) {
  const all = [];
  for (const t of Object.keys(TENORS)) { const res = residualsFor(series[t], lambda, '2017-12-31'); residualSets[`${t}|${lambda}`] = res; all.push(...cases(t, lambda, 'candidate', res, '2000-01', '2017-12')); }
  selection[`candidate_lambda_${lambda}`] = metrics(all);
  console.log('train candidate', lambda, selection[`candidate_lambda_${lambda}`].log_loss);
}
{ const all = []; for (const t of Object.keys(TENORS)) all.push(...cases(t, null, 'baseline', null, '2000-01', '2017-12')); selection.baseline = metrics(all); console.log('train baseline', selection.baseline.log_loss); }
const bestLambda = [0.90, 0.94, 0.97].sort((a, b) => selection[`candidate_lambda_${a}`].log_loss - selection[`candidate_lambda_${b}`].log_loss)[0];

// ---- holdout, read once
const hold = { candidate: [], baseline: [] };
for (const t of Object.keys(TENORS)) {
  hold.candidate.push(...cases(t, bestLambda, 'candidate', residualSets[`${t}|${bestLambda}`], '2018-01', '2026-09'));
  hold.baseline.push(...cases(t, null, 'baseline', null, '2018-01', '2026-09'));
}
const holdout = { candidate: metrics(hold.candidate), baseline: metrics(hold.baseline), by_tenor: Object.fromEntries(Object.keys(TENORS).map((t) => [`${t}Y`, { candidate: metrics(hold.candidate.filter((r) => r.tenor === t)), baseline: metrics(hold.baseline.filter((r) => r.tenor === t)) }])) };
for (const t of Object.keys(holdout.by_tenor)) { delete holdout.by_tenor[t].candidate.calibration; delete holdout.by_tenor[t].baseline.calibration; }
console.log(JSON.stringify({ bestLambda, holdout_candidate: { ...holdout.candidate, calibration: undefined }, holdout_baseline: { ...holdout.baseline, calibration: undefined } }));

// residual artifact (training-era standardized changes, thinned to 4000 per tenor for the Worker bundle)
const thin = (a) => { const step = Math.max(1, Math.floor(a.length / 4000)); return a.filter((_, i) => i % step === 0).slice(0, 4000).map((z) => +z.toFixed(4)); };
await mkdir(new URL('../../src/rates/artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../../src/rates/artifacts/rates-path-v1.json', import.meta.url), JSON.stringify({
  model_id: 'pbe-rates-path', version: '1.0.0', status: 'RESEARCH',
  target: 'P(Daily Treasury Par Yield Curve Rate for the tenor crosses K on any remaining business day of the period | path published so far)',
  method: `Monte Carlo of daily changes: EWMA(lambda=${bestLambda}) volatility x bootstrapped standardized historical changes (training 1962-2017), published values rounded to 0.01; baseline = Gaussian with trailing-250-day volatility`,
  ewma_lambda: bestLambda, paths: 4000, probability_bounds: [0.01, 0.99],
  residuals: Object.fromEntries(Object.keys(TENORS).map((t) => [`${t}`, thin(residualSets[`${t}|${bestLambda}`])])),
  selection_train_2000_2017: Object.fromEntries(Object.entries(selection).map(([k, v]) => [k, { n: v.n, brier: v.brier, log_loss: v.log_loss }])),
  holdout_2018_2026: holdout,
  generated_at: new Date().toISOString(),
}) + '\n');
console.log('artifact written');
