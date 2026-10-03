// Max-temperature method comparison on the 2025-07..2026-09 holdout (research). Scores the probability the
// method gives to the integer CLI value actually reported (log loss) and to 2-degree buckets (Brier),
// which is how Kalshi KXHIGH contracts pay. Training data: 2023-01..2025-06 only.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../src/weather/stations.js';
import { parseAcisValue } from '../../src/weather/acis.js';
import { parseMosCsv, latestRunAtOrBefore, maxTempGuidance } from '../../src/weather/mos.js';
import { cliWindow } from '../../src/weather/time.js';
import { normalCdf } from '../../src/models/probability-utils.js';
import { leadBucket } from '../../src/weather/temp-model.js';

const DATA = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const TRAIN_END = '2025-07-01';
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const rows = [];
const files = await readdir(join(DATA, 'mos'));
for (const st of Object.values(CLI_STATIONS)) {
  const acis = JSON.parse(await readFile(join(DATA, 'acis', `${st.icao}.json`), 'utf8'));
  const daily = new Map(acis.data.map(([d, , x]) => [d, parseAcisValue(x)]));
  const runs = [];
  for (const f of files.filter((n) => n.startsWith(st.icao + '-'))) runs.push(...parseMosCsv(await readFile(join(DATA, 'mos', f), 'utf8')));
  const byRun = new Map(); for (const r of runs) { if (!byRun.has(r.runtime)) byRun.set(r.runtime, []); byRun.get(r.runtime).push(r); }
  const runtimes = [...byRun.keys()].sort();
  for (let d = '2023-01-03'; d <= '2026-09-30'; d = addDays(d, 1)) {
    const a = daily.get(d); if (a?.kind !== 'value') continue;
    const win = cliWindow(d, st);
    for (const leadH of [6, 18, 30, 42]) {
      const rt = latestRunAtOrBefore(runtimes, new Date(Date.parse(win.start) - leadH * 3600000).toISOString());
      if (!rt) continue;
      const g = maxTempGuidance(byRun.get(rt), d); if (g === null) continue;
      rows.push({ s: st.cli, d, g, y: a.value, lb: leadBucket((Date.parse(win.start) - Date.parse(rt)) / 3600000), split: d < TRAIN_END ? 'train' : 'test' });
    }
  }
}
const train = rows.filter((r) => r.split === 'train');
const test = rows.filter((r) => r.split === 'test');
const key = (r) => `${r.s}|${r.lb}`;
const resid = new Map();
for (const r of train) { const k = key(r); if (!resid.has(k)) resid.set(k, []); resid.get(k).push(r.y - r.g); }
const pooled = new Map();
for (const r of train) { if (!pooled.has(r.lb)) pooled.set(r.lb, []); pooled.get(r.lb).push(r.y - r.g); }
const stat = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return { m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)), sd0: Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) }; };
const S = new Map([...resid].map(([k, v]) => [k, { ...stat(v), v }]));
const P = new Map([...pooled].map(([k, v]) => [k, { ...stat(v), v }]));
const get = (r) => { const s = S.get(key(r)); return s && s.v.length >= 60 ? s : P.get(r.lb); };
// methods return P(reported integer in [lo, hi])
const M = {
  normal_bias: (r, lo, hi) => { const s = get(r); return normalCdf(hi + 0.5, r.g + s.m, s.sd) - normalCdf(lo - 0.5, r.g + s.m, s.sd); },
  normal_nobias: (r, lo, hi) => { const s = get(r); return normalCdf(hi + 0.5, r.g, s.sd0) - normalCdf(lo - 0.5, r.g, s.sd0); },
  empirical: (r, lo, hi) => { const s = get(r); const n = s.v.length; let c = 0; for (const e of s.v) { const t = Math.round(r.g + e); if (t >= lo && t <= hi) c += 1; } return (c + 0.5) / (n + 1); },
  empirical_shrunk_bias: (r, lo, hi) => { const s = get(r); const p = P.get(r.lb); const w = s.v.length / (s.v.length + 400); const shift = w * s.m + (1 - w) * p.m; let c = 0; for (const e of s.v) { const t = Math.round(r.g + (e - s.m) + shift); if (t >= lo && t <= hi) c += 1; } return (c + 0.5) / (s.v.length + 1); },
};
const out = {};
for (const [name, fn] of Object.entries(M)) {
  let ll = 0; let br = 0; let nb = 0;
  for (const r of test) {
    const p = Math.max(1e-4, fn(r, r.y, r.y)); ll -= Math.log(p);
    // Kalshi-like 2-degree buckets around the guidance: [g-5,g-4],[g-3,g-2],...,[g+4,g+5]
    for (let lo = Math.round(r.g) - 5; lo <= Math.round(r.g) + 4; lo += 2) { const q = fn(r, lo, lo + 1); const o = r.y >= lo && r.y <= lo + 1 ? 1 : 0; br += (q - o) ** 2; nb += 1; }
  }
  out[name] = { log_loss_exact_integer: +(ll / test.length).toFixed(4), brier_2deg_buckets: +(br / nb).toFixed(5) };
}
console.log(JSON.stringify({ train: train.length, test: test.length, out }, null, 2));

// artifact: integer residual histograms (reported max - MOS guidance) per station x run-lead bucket (train split only)
const hist = (v) => { const h = {}; for (const e of v) h[e] = (h[e] || 0) + 1; return { n: v.length, counts: h }; };
const stationHist = {};
for (const [k, v] of resid) { const [s, lb] = k.split('|'); (stationHist[s] ||= {})[lb] = v.length >= 60 ? hist(v) : null; }
const pooledHist = Object.fromEntries([...pooled].map(([lb, v]) => [lb, hist(v)]));
await writeFile('src/weather/artifacts/temp-v1.json', JSON.stringify({
  model_id: 'pbe-weather-maxtemp', version: '1.0.0', status: 'RESEARCH',
  target: 'NWS CLI daily maximum temperature (integer F) at the contract CLI site over the local-standard-time climate day',
  method: 'Empirical error distribution: P(reported max in [lo,hi]) = share of past (reported max - GFS MOS day-max guidance) errors at this station and run lead that land the guidance in [lo,hi]; +0.5/+1 smoothing. Station table needs n>=60 else pooled.',
  lead_buckets: { le30h: 'run issued <=30 h before the window opens', le54h: '30-54 h', gt54h: '>54 h' },
  probability_bounds: [0.01, 0.99],
  station_residuals: stationHist, pooled_residuals: pooledHist,
  training: { cases: train.length, from: '2023-01-03', to_exclusive: TRAIN_END },
  holdout: { cases: test.length, from: TRAIN_END, to: '2026-09-30', methods: out, selected: 'empirical' },
  generated_at: new Date().toISOString(),
}, null, 1) + '\n');
console.log('temp artifact written');
