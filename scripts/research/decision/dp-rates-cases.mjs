// decision-policy-v1 evidence: per-case HOLDOUT predictions for pbe-rates-path@1.0.0 (and its Gaussian baseline).
//   node scripts/research/decision/dp-rates-cases.mjs [dataDir] [outDir]
// Mirrors scripts/research/rates-train.mjs case construction (synthetic monthly "how high / how low" contracts on
// official par yields, forecast points k = 0, 3, 8, 13 published days into the month, strikes y0 +/- offsets, contracts
// already decided by the path excluded) but uses the DEPLOYED artifact (lambda, thinned 1962-2017 residuals, 4000 paths,
// [0.01,0.99] bounds, 2-decimal publication). Holdout months 2018-01..2026-09 (selection used 2000-2017 only).
// A climatology baseline (training-era 2000-2017 hit frequency by direction x offset x k) is also attached.
// No market/venue data is read.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ewmaSigma, trailingSigma, simulateExtremes, crossProbability, seedFrom } from '../../../src/rates/rates-model.js';
import art from '../../../src/rates/artifacts/rates-path-v1.json' with { type: 'json' };

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const OUT = process.argv[3] || 'D:/Workers/scratch/predictions-decision';
const TENORS = { 5: 'DGS5', 7: 'DGS7', 10: 'DGS10', 30: 'DGS30' };
const OFFSETS = [-0.30, -0.20, -0.12, -0.06, -0.02, 0.02, 0.06, 0.12, 0.20, 0.30];
const KS = [0, 3, 8, 13];
const r2 = (x) => Math.round(x * 100) / 100;
const [lo, hi] = art.probability_bounds;
const series = {};
for (const [t, id] of Object.entries(TENORS)) {
  series[t] = (await readFile(`${DIR}/fred-${id}.csv`, 'utf8')).trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).filter(([, v]) => v && v !== '.').map(([d, v]) => [d, Number(v)]).filter(([, v]) => Number.isFinite(v));
}
function build(tenor, from, to, simulate) {
  const rows = series[tenor]; const out = []; const byMonth = new Map();
  rows.forEach(([d], i) => { const m = d.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(i); });
  for (const [month, idxs] of byMonth) {
    if (month < from || month > to || idxs.length < 15) continue;
    for (const k of KS) {
      const last = idxs[0] - 1 + k; if (last < 260) continue;
      const hist = rows.slice(0, last + 1).map((r) => r[1]);
      const y0 = hist[hist.length - 1];
      const seen = idxs.slice(0, k).map((i) => rows[i][1]);
      const runMax = seen.length ? Math.max(...seen) : -Infinity; const runMin = seen.length ? Math.min(...seen) : Infinity;
      const steps = idxs.length - k;
      const realized = idxs.map((i) => rows[i][1]); const fullMax = Math.max(...realized); const fullMin = Math.min(...realized);
      let sim = null; let simB = null;
      if (simulate) {
        const changes = hist.slice(1).map((v, i) => v - hist[i]);
        const sigma = ewmaSigma(changes.slice(-500), art.ewma_lambda);
        const sigmaB = trailingSigma(changes, 250);
        const seed = seedFrom(`${tenor}|${month}|${k}`);
        sim = simulateExtremes({ y0, sigma, steps, paths: art.paths, residuals: art.residuals[String(tenor)], seed });
        simB = simulateExtremes({ y0, sigma: sigmaB, steps, paths: art.paths, residuals: null, seed });
      }
      for (const off of OFFSETS) {
        const K = r2(y0 + off); const dir = off > 0 ? 'high' : 'low';
        if (dir === 'high' && runMax > K) continue; if (dir === 'low' && runMin < K) continue;
        const y = dir === 'high' ? (fullMax > K ? 1 : 0) : (fullMin < K ? 1 : 0);
        const c = { month, tenor: Number(tenor), k, off, dir, d: rows[last][0], y };
        if (simulate) {
          const praw = Math.min(hi, Math.max(lo, crossProbability(sim, { direction: dir, level: K })));
          c.p = Math.round(praw * 100) / 100; c.praw = +praw.toFixed(5);
          c.p_gauss = +Math.min(hi, Math.max(lo, crossProbability(simB, { direction: dir, level: K }))).toFixed(5);
        }
        out.push(c);
      }
    }
  }
  return out;
}
// climatology baseline from training era only
const freq = new Map();
for (const t of Object.keys(TENORS)) for (const c of build(t, '2000-01', '2017-12', false)) { const key = `${c.dir}|${c.off}|${c.k}`; const f = freq.get(key) || { n: 0, y: 0 }; f.n += 1; f.y += c.y; freq.set(key, f); }
const cases = [];
for (const t of Object.keys(TENORS)) {
  for (const c of build(t, '2018-01', '2026-09', true)) { const f = freq.get(`${c.dir}|${c.off}|${c.k}`); c.p_clim = +Math.min(hi, Math.max(lo, (f.y + 0.5) / (f.n + 1))).toFixed(5); c.conf = 'HIGH'; cases.push(c); }
  console.log('tenor', t, cases.length);
}
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'rates-cases.jsonl'), cases.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log('done', cases.length);
