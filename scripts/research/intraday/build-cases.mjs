// Weather intraday v2 research cases. Streams station by station (low memory) and writes one CSV row per
// (station, climate date, cutoff local-standard hour). Every feature is point-in-time at the cutoff:
//   obs: exact-station ASOS valid inside the CLI window, available (valid + 10 min) <= cutoff
//   guidance: GFS MOS / NBM runs usable at cycle + 5 h, <= 24 h old (v1 rule)
//   pre-window baseline: the frozen v1.1 forecast as the engine would have produced it at window start
// Targets: ACIS (GHCN-D / CLI) daily max (int degF) and precip (> 0.00 in; trace = 0).
//   node scripts/research/intraday/build-cases.mjs [wxDir] [intradayDir]
import { readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { parseAcisValue } from '../../../src/weather/acis.js';
import { parseMosCsv, windowPrecipFeatures, maxTempGuidance, nbmMaxTempGuidance, MOS_AVAILABLE_LAG_H } from '../../../src/weather/mos.js';
import { cliWindow } from '../../../src/weather/time.js';
import { predictPrecip } from '../../../src/weather/precip-model.js';
import { leadBucket } from '../../../src/weather/temp-model.js';
import { parseIemAsosCsv } from '../../../src/weather/intraday/observations.js';
import { obsSummary, dayMaxFromRuns, remainingPop } from '../../../src/weather/intraday/features.js';
import precipV1 from '../../../src/weather/artifacts/precip-v1.json' with { type: 'json' };
import precipV11 from '../../../src/weather/artifacts/precip-nbm-v1.1.json' with { type: 'json' };
import climatology from '../../../src/weather/artifacts/climatology-v1.json' with { type: 'json' };

const WX = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const OUT = process.argv[3] || 'D:/Workers/scratch/predictions-intraday';
const HOURS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
const FIRST = '2023-01-03'; const LAST = '2026-09-29'; // ASOS pull ends 2026-10-01 00Z
const H = 3600000;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const split = (d) => (d < '2025-01-01' ? 'fit' : d < '2025-07-01' ? 'val' : 'test');
const files = await readdir(join(WX, 'mos'));
const COLS = ['station', 'date', 'split', 'h', 'n_obs', 'obs_max', 'cur', 'meas', 'meas_straddle', 'trace', 'g', 'gsrc', 'rem_pop', 'rem_src', 'rem_h', 'clim_rate', 'clim_mean', 'clim_sd', 'pre_g', 'pre_art', 'pre_lb', 'pre_p_rain', 'y_max', 'y_rain'];
const outPath = join(OUT, 'cases.csv');
await writeFile(outPath, COLS.join(',') + '\n');

async function loadRuns(prefix) {
  const by = new Map();
  for (const f of files.filter((n) => n.startsWith(prefix)).sort()) {
    for (const r of parseMosCsv(await readFile(join(WX, 'mos', f), 'utf8'))) { if (!by.has(r.runtime)) by.set(r.runtime, []); by.get(r.runtime).push(r); }
  }
  const runtimes = [...by.keys()].sort();
  const avail = runtimes.map((r) => Date.parse(r) + MOS_AVAILABLE_LAG_H * H);
  const runs = runtimes.map((r) => ({ runtime: r, rows: by.get(r) }));
  // newest-first usable runs at cutoff ms (published, <= 24 h old)
  const usable = (ms) => {
    let lo = 0; let hi = avail.length - 1; let best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (avail[m] <= ms) { best = m; lo = m + 1; } else hi = m - 1; }
    const out = [];
    for (let i = best; i >= 0 && ms - Date.parse(runtimes[i]) <= 24 * H; i -= 1) out.push(runs[i]);
    return out;
  };
  return { usable, n: runs.length };
}

let total = 0;
for (const st of Object.values(CLI_STATIONS)) {
  const acis = JSON.parse(await readFile(join(WX, 'acis', `${st.icao}.json`), 'utf8'));
  const daily = new Map(acis.data.filter(([d]) => d >= '2022-12-01').map(([d, p, x]) => [d, { p: parseAcisValue(p), x: parseAcisValue(x) }]));
  const obs = parseIemAsosCsv(await readFile(join(OUT, 'asos', `${st.icao}.csv`), 'utf8')).filter((r) => r.station === st.icao);
  const obsMs = obs.map((r) => Date.parse(r.valid_at));
  const gfs = await loadRuns(`${st.icao}-`); const nbm = await loadRuns(`NBS-${st.icao}-`);
  const lines = [];
  const lowerBound = (ms) => { let lo = 0; let hi = obsMs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (obsMs[m] < ms) lo = m + 1; else hi = m; } return lo; };
  for (let d = FIRST; d <= LAST; d = addDays(d, 1)) {
    const a = daily.get(d); if (!a) continue;
    const yMax = a.x.kind === 'value' ? a.x.value : '';
    const yRain = a.p.kind === 'missing' ? '' : a.p.kind === 'value' && a.p.value > 0 ? 1 : 0;
    if (yMax === '' && yRain === '') continue;
    const win = cliWindow(d, st); const S = Date.parse(win.start); const E = Date.parse(win.end);
    const clim = climatology.stations[st.cli].by_month_day[d.slice(5)];
    // frozen pre-window v1.1 (engine rules at window start)
    const gPre = gfs.usable(S - 1); const nPre = nbm.usable(S - 1);
    let preG = ''; let preArt = ''; let preLb = ''; let preP = '';
    const gRun = gPre[0] || null;
    if (gRun) {
      const runLeadH = (S - Date.parse(gRun.runtime)) / H;
      const gMax = maxTempGuidance(gRun.rows, d);
      const nMax = nPre[0] ? nbmMaxTempGuidance(nPre[0].rows, d) : null;
      if (gMax !== null) { preG = nMax ? nMax.max : gMax; preArt = nMax ? 'v1.1' : 'v1'; preLb = leadBucket(runLeadH); }
      const f = windowPrecipFeatures(gRun.rows, win);
      if (f && clim?.[0] != null) {
        const n = nPre[0] ? windowPrecipFeatures(nPre[0].rows, win) : null;
        preP = predictPrecip(n ? precipV11 : precipV1, { pop_union: f.pop_union, pop_max: f.pop_max, nbm_pop_union: n?.pop_union, nbm_pop_max: n?.pop_max, clim: clim[0], runLeadH }).probability.toFixed(5);
      }
    }
    const i0 = lowerBound(S);
    for (const h of HOURS) {
      const t = S + h * H;
      const rows = [];
      for (let i = i0; i < obs.length && obsMs[i] < Math.min(t, E); i += 1) if (Date.parse(obs[i].available_at) <= t) rows.push(obs[i]);
      if (!rows.length) continue;
      const s = obsSummary(rows, win);
      const nU = nbm.usable(t); const gU = gfs.usable(t);
      const gn = dayMaxFromRuns(nU, d, 'nbm'); const gg = gn ? null : dayMaxFromRuns(gU, d, 'gfs');
      const rn = remainingPop(nU, t, E); const rg = rn ? null : remainingPop(gU, t, E);
      const rem = rn || rg;
      lines.push([st.cli, d, split(d), h, s.n_temp, s.obs_max_f ?? '', s.current_f ?? '', s.measurable ? 1 : 0, s.measurable_straddle_only ? 1 : 0, s.trace ? 1 : 0,
        gn ? gn.max : gg ? gg.max : '', gn ? 'nbm' : gg ? 'gfs' : '', rem ? rem.pop.toFixed(5) : '', rn ? 'nbm' : rg ? 'gfs' : '', rem ? rem.hours : '',
        clim?.[0] ?? '', clim?.[3] ?? '', clim?.[4] ?? '', preG, preArt, preLb, preP, yMax, yRain].join(','));
    }
  }
  await appendFile(outPath, lines.join('\n') + '\n');
  total += lines.length;
  console.log(st.cli, lines.length, `obs=${obs.length} gfsRuns=${gfs.n} nbmRuns=${nbm.n}`, new Date().toISOString());
}
console.log('cases', total);
