// maxtemp-intraday v2.2 research cases (candidate live-weather features). Streams ONE station at a time (low memory) and
// writes one row per (station, climate date, cutoff hour h = 1..23 hours after the LST window opened). Every feature is
// point-in-time at the cutoff t = window start + h:
//   obs (IEM ASOS archive, exact station, routine + special METARs): valid inside the CLI window, available = valid + 10 min <= t
//     tmpf / hourly max / current temp (v2.0), METAR 6-h max groups fully inside the window (v2.1, asos-max6/),
//     present weather + sky cover of the newest usable report (asos-wx/, IEM-decoded METAR groups)
//   guidance: NBS runs usable at cycle + 5 h and <= 24 h old (v1 rule): TXN day max (v2.x) and the 3-hourly TMP path
//     (linearly interpolated; trajectoryFeatures in src/weather/intraday/features.js — the same code the engine runs)
//   frozen pre-window v1.1 at window start (same as build-cases.mjs)
// Target: ACIS daily max at the CLI site. NO market data. Writes cases-v22.csv.
//   node scripts/research/intraday/build-cases-v22.mjs [wxDir] [intradayDir]
import { readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { parseAcisValue } from '../../../src/weather/acis.js';
import { parseMosCsv, maxTempGuidance, nbmMaxTempGuidance, MOS_AVAILABLE_LAG_H } from '../../../src/weather/mos.js';
import { cliWindow } from '../../../src/weather/time.js';
import { leadBucket } from '../../../src/weather/temp-model.js';
import { parseIemAsosCsv, iemWeatherFields } from '../../../src/weather/intraday/observations.js';
import { obsSummary, obsMax6, dayMaxFromRuns, latestWeather, weatherRegime, trajectoryFeatures } from '../../../src/weather/intraday/features.js';
import climatology from '../../../src/weather/artifacts/climatology-v1.json' with { type: 'json' };

const WX = process.argv[2] || 'D:/Workers/scratch/predictions-wx';
const OUT = process.argv[3] || 'D:/Workers/scratch/predictions-intraday';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const HOURS = Array.from({ length: 23 }, (_, i) => i + 1);
const FIRST = '2023-01-03'; const LAST = '2026-09-29';
const H = 3600000;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const split = (d) => (d < '2025-01-01' ? 'fit' : d < '2025-07-01' ? 'val' : 'test');
const files = await readdir(join(WX, 'mos'));
const COLS = ['station', 'date', 'split', 'h', 'n_obs', 'obs_max', 'max6', 'cur', 'cur_age_min', 'g', 'g_rt', 'wx_regime', 'wx_obsc', 'sky_rank', 'ceil', 'wx_age_min',
  'nbm_now', 'resid', 'rem_peak', 'rem_peak_lead', 's1', 's2', 's3', 'path_chg', 'y_max', 'pre_g', 'pre_art', 'pre_lb', 'clim_mean', 'clim_sd'];
const outPath = join(OUT, process.env.OUTFILE || 'cases-v22.csv');
await writeFile(outPath, COLS.join(',') + '\n');
const f2 = (v) => (v === null || v === undefined ? '' : Number.isInteger(v) ? v : +v.toFixed(2));
const isoOf = (s) => new Date(Date.parse(s.replace(' ', 'T') + ':00Z')).toISOString();

async function loadRuns(prefix) {
  const by = new Map();
  for (const f of files.filter((n) => n.startsWith(prefix)).sort()) {
    for (const r of parseMosCsv(await readFile(join(WX, 'mos', f), 'utf8'))) { if (!by.has(r.runtime)) by.set(r.runtime, []); by.get(r.runtime).push(r); }
  }
  const runtimes = [...by.keys()].sort();
  const avail = runtimes.map((r) => Date.parse(r) + MOS_AVAILABLE_LAG_H * H);
  const runs = runtimes.map((r) => ({ runtime: r, rows: by.get(r) }));
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
  if (ONLY && !ONLY.includes(st.cli)) continue;
  const acis = JSON.parse(await readFile(join(WX, 'acis', `${st.icao}.json`), 'utf8'));
  const daily = new Map(acis.data.filter((row) => row[0] >= '2022-12-01').map((row) => [row[0], parseAcisValue(row[2])]));
  const max6 = new Map();
  for (const l of (await readFile(join(OUT, 'asos-max6', `${st.icao}.csv`), 'utf8')).trim().split(/\r?\n/).slice(1)) {
    const c = l.split(','); if (c[2] !== '' && c[2] !== undefined) max6.set(isoOf(c[1]), Number(c[2]));
  }
  const wx = new Map();
  for (const l of (await readFile(join(OUT, 'asos-wx', `${st.icao}.csv`), 'utf8')).split(/\r?\n/).slice(1)) {
    const c = l.split(','); if (c.length < 11) continue;
    wx.set(isoOf(c[1]), iemWeatherFields(c[2], c.slice(3, 7), c.slice(7, 11)));
  }
  const obs = parseIemAsosCsv(await readFile(join(OUT, 'asos', `${st.icao}.csv`), 'utf8')).filter((r) => r.station === st.icao)
    .map((r) => { const w = wx.get(r.valid_at); return { ...r, max6_f: max6.get(r.valid_at) ?? null, wxcodes: w ? w.wxcodes : null, sky: w ? w.sky : null }; });
  wx.clear(); max6.clear();
  const obsMs = obs.map((r) => Date.parse(r.valid_at));
  const gfs = await loadRuns(`${st.icao}-`); const nbm = await loadRuns(`NBS-${st.icao}-`);
  const lines = [];
  const lowerBound = (ms) => { let lo = 0; let hi = obsMs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (obsMs[m] < ms) lo = m + 1; else hi = m; } return lo; };
  for (let d = FIRST; d <= LAST; d = addDays(d, 1)) {
    const x = daily.get(d); if (!x || x.kind !== 'value') continue;
    const yMax = x.value;
    const win = cliWindow(d, st); const S = Date.parse(win.start); const E = Date.parse(win.end);
    const clim = climatology.stations[st.cli].by_month_day[d.slice(5)];
    const gPre = gfs.usable(S - 1); const nPre = nbm.usable(S - 1);
    let preG = ''; let preArt = ''; let preLb = '';
    const gRun = gPre[0] || null;
    if (gRun) {
      const gMax = maxTempGuidance(gRun.rows, d);
      const nMax = nPre[0] ? nbmMaxTempGuidance(nPre[0].rows, d) : null;
      if (gMax !== null) { preG = nMax ? nMax.max : gMax; preArt = nMax ? 'v1.1' : 'v1'; preLb = leadBucket((S - Date.parse(gRun.runtime)) / H); }
    }
    if (preG === '') continue; // the frozen pre-window baseline must exist (same filter as v2.0/v2.1 scoring)
    const i0 = lowerBound(S);
    for (const h of HOURS) {
      const t = S + h * H;
      const rows = [];
      for (let i = i0; i < obs.length && obsMs[i] < Math.min(t, E); i += 1) if (Date.parse(obs[i].available_at) <= t) rows.push(obs[i]);
      if (!rows.length) continue;
      const s = obsSummary(rows, win);
      if (s.n_temp === 0) continue;
      const nU = nbm.usable(t);
      const gn = dayMaxFromRuns(nU, d, 'nbm');
      if (!gn) continue; // v2.x temp path requires NBM (GFS fallback is unvalidated and off)
      const six = obsMax6(rows, win);
      let curAt = null; for (let i = rows.length - 1; i >= 0; i -= 1) if (Number.isFinite(rows[i].tmpf)) { curAt = rows[i].valid_at; break; }
      const w = latestWeather(rows);
      const tr = trajectoryFeatures(nU, { now: t, end: E, curValidAt: curAt, cur: s.current_f });
      lines.push([st.cli, d, split(d), h, s.n_temp, s.obs_max_f, f2(six.max6_f), s.current_f, Math.round((t - Date.parse(curAt)) / 60000), gn.max, gn.runtime.slice(0, 13),
        weatherRegime(w), w?.obscuration ? 1 : 0, f2(w?.sky_rank), f2(w?.ceiling_ft), w ? Math.round((t - Date.parse(w.valid_at)) / 60000) : '',
        f2(tr?.nbm_now), f2(tr?.resid), f2(tr?.rem_peak), f2(tr?.rem_peak_lead_h), f2(tr?.slope1), f2(tr?.slope2), f2(tr?.slope3), f2(tr?.path_change),
        yMax, preG, preArt, preLb, clim?.[3] ?? '', clim?.[4] ?? ''].join(','));
    }
  }
  await appendFile(outPath, lines.join('\n') + '\n');
  total += lines.length;
  console.log(st.cli, lines.length, `obs=${obs.length} nbmRuns=${nbm.n}`, new Date().toISOString());
}
console.log('cases', total);
