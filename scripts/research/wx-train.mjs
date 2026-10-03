// Weather engine v1 calibration (research script; output artifacts are committed, raw data is not).
//   node scripts/research/wx-train.mjs [dataDir]
// Inputs (from wx-fetch.mjs): ACIS daily station records + archived NWS GFS MOS (MAV) runs.
// Point-in-time rule: a forecast at cutoff C may only use a MOS run whose runtime + MOS_AVAILABLE_LAG_H <= C,
// and climatology from 1991-2020 only. Kalshi data is never read here.
// Outputs:
//   src/weather/artifacts/precip-v1.json   logistic calibration P(CLI daily precip > 0) + holdout report
//   src/weather/artifacts/climatology-v1.json  per-station day-of-year climatology (ACIS)
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../src/weather/stations.js';
import { climatologyRate, climatologyMaxTemp, parseAcisValue } from '../../src/weather/acis.js';
import { parseMosCsv, latestRunAtOrBefore, windowPrecipFeatures, MOS_AVAILABLE_LAG_H } from '../../src/weather/mos.js';
import { cliWindow } from '../../src/weather/time.js';
import { fitLogistic, precipFeatureVector, PRECIP_FEATURES } from '../../src/weather/precip-model.js';

const DATA = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const TRAIN_END = '2025-07-01';
const CUTOFF_LEADS_H = [6, 18, 30, 42]; // hours before the CLI window opens
const day = (iso) => iso.slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function brier(rows, key) { return rows.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / rows.length; }
function logloss(rows, key) { const e = 1e-6; return -rows.reduce((s, r) => { const p = Math.min(1 - e, Math.max(e, r[key])); return s + (r.y ? Math.log(p) : Math.log(1 - p)); }, 0) / rows.length; }
function reliability(rows, key, bins = 10) {
  const out = [];
  for (let b = 0; b < bins; b += 1) {
    const lo = b / bins; const hi = (b + 1) / bins;
    const sel = rows.filter((r) => r[key] >= lo && (b === bins - 1 ? r[key] <= hi : r[key] < hi));
    if (sel.length) out.push({ bin: `${lo.toFixed(1)}-${hi.toFixed(1)}`, n: sel.length, mean_forecast: +(sel.reduce((s, r) => s + r[key], 0) / sel.length).toFixed(3), observed: +(sel.reduce((s, r) => s + r.y, 0) / sel.length).toFixed(3) });
  }
  return out;
}

const precipRows = [];
const mosFiles = await readdir(join(DATA, 'mos'));

for (const st of Object.values(CLI_STATIONS)) {
  const acis = JSON.parse(await readFile(join(DATA, 'acis', `${st.icao}.json`), 'utf8'));
  const daily = new Map(acis.data.map(([d, p, x]) => [d, { pcpn: parseAcisValue(p), maxt: parseAcisValue(x) }]));
  const runs = [];
  for (const f of mosFiles.filter((n) => n.startsWith(st.icao + '-'))) runs.push(...parseMosCsv(await readFile(join(DATA, 'mos', f), 'utf8')));
  const byRun = new Map();
  for (const r of runs) { if (!byRun.has(r.runtime)) byRun.set(r.runtime, []); byRun.get(r.runtime).push(r); }
  const runtimes = [...byRun.keys()].sort();
  let n = 0;
  for (let d = '2023-01-03'; d <= '2026-09-30'; d = addDays(d, 1)) {
    const obs = daily.get(d);
    if (!obs) continue;
    const win = cliWindow(d, st);
    const clim = climatologyRate(acis.data, d, { startYear: 1991, endYear: 2020, halfWindowDays: 10 });
    for (const leadH of CUTOFF_LEADS_H) {
      const cutoff = new Date(Date.parse(win.start) - leadH * 3600000).toISOString();
      const runtime = latestRunAtOrBefore(runtimes, cutoff);
      if (!runtime) continue;
      const rows = byRun.get(runtime);
      const runLeadH = (Date.parse(win.start) - Date.parse(runtime)) / 3600000;
      if (obs.pcpn.kind !== 'missing' && clim.rate !== null) {
        const f = windowPrecipFeatures(rows, win);
        if (f) {
          const y = obs.pcpn.kind === 'value' && obs.pcpn.value > 0 ? 1 : 0; // trace and 0.00 count as NO (contract rule)
          precipRows.push({ station: st.cli, date: d, cutoffLeadH: leadH, runLeadH, runtime, y, clim: clim.rate, ...f, split: d < TRAIN_END ? 'train' : 'test' });
          n += 1;
        }
      }
    }
  }
  console.log(st.cli, 'precip cases', n);
}

// ---------------- precipitation: pooled logistic calibration
const train = precipRows.filter((r) => r.split === 'train');
const test = precipRows.filter((r) => r.split === 'test');
const model = fitLogistic(train.map((r) => precipFeatureVector(r)), train.map((r) => r.y), { ridge: 1e-3 });
const score = (rows) => rows.map((r) => {
  const z = model.coefficients.reduce((s, c, i) => s + c * precipFeatureVector(r)[i], 0);
  return { ...r, p_model: 1 / (1 + Math.exp(-z)), p_clim: r.clim, p_union: r.pop_union, p_max: r.pop_max };
});
const scoredTest = score(test);
const scoredTrain = score(train);
const metric = (rows) => Object.fromEntries(['p_model', 'p_union', 'p_max', 'p_clim'].map((k) => [k, { brier: +brier(rows, k).toFixed(4), log_loss: +logloss(rows, k).toFixed(4) }]));
const byStation = Object.fromEntries(Object.keys(CLI_STATIONS).map((s) => {
  const rows = scoredTest.filter((r) => r.station === s);
  return [s, rows.length ? { n: rows.length, base_rate: +(rows.reduce((a, r) => a + r.y, 0) / rows.length).toFixed(3), ...metric(rows) } : null];
}));
const byLead = Object.fromEntries(CUTOFF_LEADS_H.map((h) => [`${h}h`, metric(scoredTest.filter((r) => r.cutoffLeadH === h))]));
const precipArtifact = {
  model_id: 'pbe-weather-precip', version: '1.0.0', status: 'RESEARCH',
  target: 'P(NWS CLI daily precipitation > 0.00 in) at the contract CLI site over the local-standard-time climate day; trace = NO',
  features: PRECIP_FEATURES,
  coefficients: model.coefficients.map((c) => +c.toFixed(6)),
  probability_bounds: [0.02, 0.98],
  inputs: ['NWS GFS MOS (MAV) 6-h PoP for the CLI window, latest run published before the cutoff (runtime + ' + MOS_AVAILABLE_LAG_H + ' h)', 'NOAA RCC-ACIS 1991-2020 station climatology (+/-10 days)'],
  training: { cases: train.length, from: '2023-01-03', to_exclusive: TRAIN_END, cutoff_leads_h: CUTOFF_LEADS_H, stations: Object.keys(CLI_STATIONS).length, iterations: model.iterations },
  holdout: { cases: test.length, from: TRAIN_END, to: '2026-09-30', overall: metric(scoredTest), by_cutoff_lead: byLead, reliability_model: reliability(scoredTest, 'p_model'), reliability_mos_union: reliability(scoredTest, 'p_union'), by_station: byStation },
  in_sample: { overall: metric(scoredTrain) },
  generated_at: new Date().toISOString(),
};
await writeFile('src/weather/artifacts/precip-v1.json', JSON.stringify(precipArtifact, null, 2) + '\n');
console.log('precip holdout', JSON.stringify(precipArtifact.holdout.overall));

// Temperature calibration lives in wx-temp-eval.mjs (method comparison + temp-v1 artifact).

// ---------------- climatology artifact (point-in-time safe: completed years only) + comparable-condition table
const climatology = { version: '1.0.0', source: 'NOAA RCC-ACIS daily station records (GHCN-D ids); trace = dry', windows: { precip_half_window_days: 10, maxt_half_window_days: 7 }, periods: { normal: '1991-2020', last20: '2006-2025', last10: '2016-2025' }, stations: {} };
const leapDays = []; for (let d = '2024-01-01'; d <= '2024-12-31'; d = addDays(d, 1)) leapDays.push(d);
for (const st of Object.values(CLI_STATIONS)) {
  const acis = JSON.parse(await readFile(join(DATA, 'acis', `${st.icao}.json`), 'utf8'));
  const table = {};
  for (const d of leapDays) {
    const r = (a, b) => { const c = climatologyRate(acis.data, d, { startYear: a, endYear: b, halfWindowDays: 10 }); return c.rate === null ? null : +c.rate.toFixed(4); };
    const t = climatologyMaxTemp(acis.data, d, { startYear: 1991, endYear: 2020, halfWindowDays: 7 });
    table[d.slice(5)] = [r(1991, 2020), r(2006, 2025), r(2016, 2025), t ? +t.mean.toFixed(1) : null, t ? +t.sd.toFixed(2) : null];
  }
  climatology.stations[st.cli] = { ghcn: st.ghcn, acis_name: acis.meta?.name ?? null, columns: ['precip_rate_1991_2020', 'precip_rate_2006_2025', 'precip_rate_2016_2025', 'maxt_mean_1991_2020', 'maxt_sd_1991_2020'], by_month_day: table };
}
await writeFile('src/weather/artifacts/climatology-v1.json', JSON.stringify(climatology) + '\n');

const analogs = {};
for (const s of Object.keys(CLI_STATIONS)) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, wet: 0 }));
  for (const r of train.filter((x) => x.station === s && x.cutoffLeadH === 18)) { const b = Math.min(9, Math.floor(r.pop_union * 10)); bins[b].n += 1; bins[b].wet += r.y; }
  analogs[s] = bins.map((b, i) => ({ pop_union_bin: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`, n: b.n, observed_rate: b.n ? +(b.wet / b.n).toFixed(3) : null }));
}
precipArtifact.comparable_conditions = { definition: 'Past days at the same station (2023-01..2025-06, run ~18 h before the window) whose MOS window PoP fell in the same 10-point bin; observed share with measurable CLI precipitation', by_station: analogs };
await writeFile('src/weather/artifacts/precip-v1.json', JSON.stringify(precipArtifact, null, 2) + '\n');
console.log('climatology + analogs written');
