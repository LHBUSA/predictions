// Max-temp v1.1 selection: GFS MOS vs NBM vs blend, empirical guidance-error tables per station x lead.
// Selection on fit 2023-01..2024-12 / validate 2025-01..2025-06; the 2025-07+ holdout is scored once at the end.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../src/weather/stations.js';
import { parseAcisValue } from '../../src/weather/acis.js';
import { parseMosCsv, latestRunAtOrBefore, maxTempGuidance, nbmMaxTempGuidance } from '../../src/weather/mos.js';
import { cliWindow } from '../../src/weather/time.js';
import { leadBucket } from '../../src/weather/temp-model.js';

const DATA = 'D:/Workers/scratch/predictions-wx';
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const files = await readdir(join(DATA, 'mos'));
const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.runtime)) m.set(r.runtime, []); m.get(r.runtime).push(r); } return m; };
const rows = [];
for (const st of Object.values(CLI_STATIONS)) {
  const acis = JSON.parse(await readFile(join(DATA, 'acis', `${st.icao}.json`), 'utf8'));
  const daily = new Map(acis.data.map(([d, , x]) => [d, parseAcisValue(x)]));
  const load = async (prefix) => { const out = []; for (const f of files.filter((n) => n.startsWith(prefix))) out.push(...parseMosCsv(await readFile(join(DATA, 'mos', f), 'utf8'))); return group(out); };
  const gfs = await load(`${st.icao}-`); const nbm = await load(`NBS-${st.icao}-`);
  const gR = [...gfs.keys()].sort(); const nR = [...nbm.keys()].sort();
  for (let d = '2023-01-03'; d <= '2026-09-30'; d = addDays(d, 1)) {
    const a = daily.get(d); if (a?.kind !== 'value') continue;
    const win = cliWindow(d, st);
    for (const h of [6, 18, 30, 42]) {
      const cutoff = new Date(Date.parse(win.start) - h * 3600000).toISOString();
      const gr = latestRunAtOrBefore(gR, cutoff); const nr = latestRunAtOrBefore(nR, cutoff);
      if (!gr || !nr || Date.parse(cutoff) - Date.parse(nr) > 24 * 3600000) continue;
      const g = maxTempGuidance(gfs.get(gr), d); const n = nbmMaxTempGuidance(nbm.get(nr), d);
      if (g === null || !n) continue;
      rows.push({ s: st.cli, d, y: a.value, g, n: n.max, lb: leadBucket((Date.parse(win.start) - Date.parse(gr)) / 3600000) });
    }
  }
}
const guid = { gfs: (r) => r.g, nbm: (r) => r.n, blend: (r) => Math.round((r.g + r.n) / 2) };
function tables(train, gf) {
  const t = new Map(); const pooled = new Map();
  for (const r of train) { const e = r.y - gf(r); const k = `${r.s}|${r.lb}`; if (!t.has(k)) t.set(k, []); t.get(k).push(e); if (!pooled.has(r.lb)) pooled.set(r.lb, []); pooled.get(r.lb).push(e); }
  pooled.set('all', [...pooled.values()].flat());
  return { t, pooled };
}
function score(test, train, gf) {
  const { t, pooled } = tables(train, gf);
  let ll = 0; let br = 0; let nb = 0;
  for (const r of test) {
    const v = (t.get(`${r.s}|${r.lb}`)?.length >= 60 ? t.get(`${r.s}|${r.lb}`) : (pooled.get(r.lb) || pooled.get('all')));
    const g = gf(r);
    const p = (lo, hi) => (v.filter((e) => { const x = Math.round(g + e); return x >= lo && x <= hi; }).length + 0.5) / (v.length + 1);
    ll -= Math.log(p(r.y, r.y));
    const c = Math.round(g);
    for (let lo = c - 5; lo <= c + 4; lo += 2) { const q = p(lo, lo + 1); const o = r.y >= lo && r.y <= lo + 1 ? 1 : 0; br += (q - o) ** 2; nb += 1; }
  }
  return { log_loss_exact: +(ll / test.length).toFixed(4), brier_2deg: +(br / nb).toFixed(5), n: test.length };
}
const fit = rows.filter((r) => r.d < '2025-01-01'); const val = rows.filter((r) => r.d >= '2025-01-01' && r.d < '2025-07-01');
const selection = Object.fromEntries(Object.entries(guid).map(([k, gf]) => [k, score(val, fit, gf)]));
const best = Object.entries(selection).sort((a, b) => a[1].log_loss_exact - b[1].log_loss_exact)[0][0];
const train = rows.filter((r) => r.d < '2025-07-01'); const test = rows.filter((r) => r.d >= '2025-07-01');
const holdout = Object.fromEntries(Object.entries(guid).map(([k, gf]) => [k, score(test, train, gf)]));
console.log(JSON.stringify({ selection_validation: selection, selected: best, holdout_read_once: holdout }, null, 1));
const { t, pooled } = tables(train, guid[best]);
const hist = (v) => { const h = {}; for (const e of v) h[e] = (h[e] || 0) + 1; return { n: v.length, counts: h }; };
const station = {}; for (const [k, v] of t) { const [s, lb] = k.split('|'); (station[s] ||= {})[lb] = v.length >= 60 ? hist(v) : null; }
await writeFile('src/weather/artifacts/temp-nbm-v1.1.json', JSON.stringify({
  model_id: 'pbe-weather-maxtemp', version: '1.1.0', status: 'RESEARCH', guidance: best,
  method: `Empirical error distribution of the ${best === 'blend' ? 'GFS MOS / NBM average' : best.toUpperCase()} day-max guidance per station and run lead; selected on 2025-01..06 validation`,
  use_rule: 'Used when an NBM run published by the cutoff (runtime + 5 h) is <= 24 h old; otherwise temp-v1 (GFS MOS) applies.',
  probability_bounds: [0.01, 0.99], station_residuals: station, pooled_residuals: Object.fromEntries([...pooled].map(([k, v]) => [k, hist(v)])),
  selection_validation: selection, holdout: { from: '2025-07-01', to: '2026-09-30', methods: holdout, selected: best },
  generated_at: new Date().toISOString(),
}, null, 1) + '\n');
