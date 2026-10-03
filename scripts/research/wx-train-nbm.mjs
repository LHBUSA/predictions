// Rain model v1.1 (GFS MOS + NBM + climatology) vs v1 (GFS MOS + climatology) on the SAME cases.
// Same point-in-time rule (runtime + 5 h), same splits as wx-train.mjs. Writes src/weather/artifacts/precip-nbm-v1.1.json.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../src/weather/stations.js';
import { parseAcisValue } from '../../src/weather/acis.js';
import { parseMosCsv, latestRunAtOrBefore, windowPrecipFeatures, MOS_AVAILABLE_LAG_H } from '../../src/weather/mos.js';
import { cliWindow } from '../../src/weather/time.js';
import { fitLogistic, precipFeatureVectorNbm, PRECIP_FEATURES_NBM, predictPrecip } from '../../src/weather/precip-model.js';
import precipV1 from '../../src/weather/artifacts/precip-v1.json' with { type: 'json' };
import climatology from '../../src/weather/artifacts/climatology-v1.json' with { type: 'json' };

const DATA = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const TRAIN_END = '2025-07-01';
const LEADS = [6, 18, 30, 42];
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const files = await readdir(join(DATA, 'mos'));
const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.runtime)) m.set(r.runtime, []); m.get(r.runtime).push(r); } return m; };
const rows = [];
for (const st of Object.values(CLI_STATIONS)) {
  const acis = JSON.parse(await readFile(join(DATA, 'acis', `${st.icao}.json`), 'utf8'));
  const daily = new Map(acis.data.map(([d, p]) => [d, parseAcisValue(p)]));
  const load = async (prefix) => { const out = []; for (const f of files.filter((n) => n.startsWith(prefix))) out.push(...parseMosCsv(await readFile(join(DATA, 'mos', f), 'utf8'))); return group(out); };
  const gfs = await load(`${st.icao}-`); const nbm = await load(`NBS-${st.icao}-`);
  const gRuns = [...gfs.keys()].sort(); const nRuns = [...nbm.keys()].sort();
  for (let d = '2023-01-03'; d <= '2026-09-30'; d = addDays(d, 1)) {
    const o = daily.get(d); if (!o || o.kind === 'missing') continue;
    const clim = climatology.stations[st.cli].by_month_day[d.slice(5)][0]; if (clim == null) continue;
    const win = cliWindow(d, st);
    for (const h of LEADS) {
      const cutoff = new Date(Date.parse(win.start) - h * 3600000).toISOString();
      const gr = latestRunAtOrBefore(gRuns, cutoff); const nr = latestRunAtOrBefore(nRuns, cutoff);
      if (!gr || !nr) continue;
      if (Date.parse(cutoff) - Date.parse(nr) > 24 * 3600000) continue; // stale NBM (archive gap) -> not a v1.1 case
      const g = windowPrecipFeatures(gfs.get(gr), win); const n = windowPrecipFeatures(nbm.get(nr), win);
      if (!g || !n) continue;
      rows.push({ station: st.cli, date: d, h, y: o.kind === 'value' && o.value > 0 ? 1 : 0, clim, pop_union: g.pop_union, pop_max: g.pop_max, nbm_pop_union: n.pop_union, nbm_pop_max: n.pop_max, runLeadH: (Date.parse(win.start) - Date.parse(gr)) / 3600000, split: d < TRAIN_END ? 'train' : 'test' });
    }
  }
  console.log(st.cli, rows.length);
}
const train = rows.filter((r) => r.split === 'train'); const test = rows.filter((r) => r.split === 'test');
const fit = fitLogistic(train.map(precipFeatureVectorNbm), train.map((r) => r.y), { ridge: 1e-3 });
const art = { model_id: 'pbe-weather-precip', version: '1.1.0', status: 'RESEARCH', features: PRECIP_FEATURES_NBM, coefficients: fit.coefficients.map((c) => +c.toFixed(6)), probability_bounds: [0.02, 0.98] };
const score = (fn) => { let b = 0; let l = 0; for (const r of test) { const p = fn(r); b += (p - r.y) ** 2; l -= r.y ? Math.log(p) : Math.log(1 - p); } return { brier: +(b / test.length).toFixed(4), log_loss: +(l / test.length).toFixed(4) }; };
const m = {
  v1_1_gfs_nbm: score((r) => predictPrecip(art, r).probability),
  v1_gfs_only: score((r) => predictPrecip(precipV1, r).probability),
  nbm_raw_union: score((r) => Math.min(0.98, Math.max(0.02, r.nbm_pop_union))),
  climatology: score((r) => r.clim),
};
const out = {
  ...art,
  target: precipV1.target,
  inputs: ['NWS GFS MOS (MAV) 6-h PoP', 'NWS National Blend of Models (NBM, NBS text) 6-h PoP', 'NOAA RCC-ACIS 1991-2020 station climatology'],
  use_rule: 'Used when an NBM run published by the cutoff (runtime + ' + MOS_AVAILABLE_LAG_H + ' h) is <= 24 h old and covers the window; otherwise the engine falls back to precip-v1 (GFS MOS only).',
  training: { cases: train.length, from: '2023-01-03', to_exclusive: TRAIN_END, note: 'IEM NBM archive has month-long gaps (e.g. 2024-01, 2025-01, 2026-06); only days with both guidance sets are used' },
  holdout: { cases: test.length, same_cases_comparison: m },
  generated_at: new Date().toISOString(),
};
await writeFile('src/weather/artifacts/precip-nbm-v1.1.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ train: train.length, test: test.length, m, coef: out.coefficients }, null, 1));
