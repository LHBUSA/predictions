// Fits and freezes the v1.2 SHADOW artifact (candidate D, selected by the pre-registered screen in v12-challenger.mjs).
//   node scripts/research/temp-audit/fit-v12-artifact.mjs <screen.json> [archive-dir]
// After selection the recipe is refit, unchanged, on the whole archive (2023-01-03..2026-09-30). The forward record
// starts after the freeze commit; the artifact's sha256 is pinned in test/temp-prewindow-v12.test.js.
import { readFile, writeFile } from 'node:fs/promises';
import { buildCases } from './cases.mjs';

const [screenPath, dir = 'D:/Workers/scratch/predictions-wx'] = process.argv.slice(2);
if (!screenPath) { console.error('usage: fit-v12-artifact.mjs <screen.json> [archive-dir]'); process.exit(2); }
const screen = JSON.parse(await readFile(screenPath, 'utf8'));
if (!screen.screen?.passed || !/^GFS-NBM regression/.test(screen.screen.candidate)) throw new Error('the pre-registered screen did not select a passing candidate D');
const SHRINK_K = 200; const MIN_STATION_N = 60;
const cases = await buildCases(dir);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const beta = (rs) => { const xs = rs.map((r) => r.g - r.n); const ys = rs.map((r) => r.y - r.n); const mx = mean(xs); const my = mean(ys); let sxy = 0; let sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; }); return sxx ? sxy / sxx : 0; };
const pooled = beta(cases);
const by = new Map(); for (const r of cases) { if (!by.has(r.s)) by.set(r.s, []); by.get(r.s).push(r); }
const station = {}; const raw = {};
for (const [s, rs] of [...by].sort()) { raw[s] = +beta(rs).toFixed(4); station[s] = +((rs.length * beta(rs) + SHRINK_K * pooled) / (rs.length + SHRINK_K)).toFixed(4); }
const center = (r) => r.n + station[r.s] * (r.g - r.n);
const t = new Map(); const pool = new Map();
for (const r of cases) { const e = +(r.y - center(r)).toFixed(3); const k = `${r.s}|${r.lb}`; if (!t.has(k)) t.set(k, []); t.get(k).push(e); if (!pool.has(r.lb)) pool.set(r.lb, []); pool.get(r.lb).push(e); }
// Residuals keep 0.001 F resolution (the screened recipe used real residuals; temp-model.js reads any numeric key) and
// the prediction is round(center + e), as in the screen.
const hist = (v) => { const h = {}; for (const e of v) h[e] = (h[e] || 0) + 1; return { n: v.length, counts: Object.fromEntries(Object.entries(h).sort((a, b) => a[0] - b[0])) }; };
const station_residuals = {}; for (const [k, v] of [...t].sort()) { const [s, lb] = k.split('|'); (station_residuals[s] ||= {})[lb] = v.length >= MIN_STATION_N ? hist(v) : null; }
const art = {
  model_id: 'pbe-weather-maxtemp', version: '1.2.0', status: 'SHADOW', guidance: 'nbm+gfs-regression',
  method: 'v1.1 empirical error tables re-centred on NBM + beta_station * (GFS MOS - NBM); beta = per-station least squares on (CLI - NBM) ~ (GFS - NBM), shrunk toward the pooled beta with k = 200 cases',
  use_rule: 'SHADOW research only. Needs both an NBM run (runtime + 5 h, <= 24 h old) and a GFS MOS run at the cutoff; otherwise NO_GFS (no forecast). Never public, never designated, never a CALL.',
  probability_bounds: [0.01, 0.99], beta: { pooled: +pooled.toFixed(4), shrink_k: SHRINK_K, station, station_unshrunk: raw },
  station_residuals, pooled_residuals: Object.fromEntries([...pool].sort().map(([k, v]) => [k, hist(v)])),
  training: { from: '2023-01-03', to: '2026-09-30', cases: cases.length, note: 'refit on the whole archive after the pre-registered selection; same case rules as v1.1' },
  selection: { prereg: 'docs/research/TEMP_PREWINDOW_V12_PREREG.md (eaa9f41)', candidate: screen.screen.candidate, validation: screen.validation,
    retrospective_screen: { passed: screen.screen.passed, pristine: false, checks: screen.screen.checks,
      log_loss_A_minus_cand: { diff: +screen.screen.log_loss.diff.toFixed(4), ci95: screen.screen.log_loss.ci.map((x) => +x.toFixed(4)) },
      brier_2f_A_minus_cand: { diff: +screen.screen.brier_2f.diff.toFixed(5), ci95: screen.screen.brier_2f.ci.map((x) => +x.toFixed(5)) } } },
  forward_gate: { min_resolved_dates: 30, min_stations: 25, rule: 'date-clustered 95% CI of (v1.1 - v1.2) > 0 for exact-degree log loss AND 2F Brier on all-station replay; Kalshi-7 bucket events: v1.2 not worse than v1.1 by point estimate; markets reported, never a gate' },
};
const out = 'src/weather/artifacts/temp-prewindow-v1.2.json';
await writeFile(out, JSON.stringify(art, null, 1) + '\n');
console.log(JSON.stringify({ out, cases: cases.length, beta: art.beta }, null, 1));
