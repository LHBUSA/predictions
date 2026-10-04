// Parity (maxtemp-intraday 2.2.0): the production engine (forecastIntraday, tempModelVersion '2.2.0') on archived raw
// inputs (IEM ASOS tmpf + METAR 6-h max + present weather/sky, NBS runs with TMP) reproduces the research case features
// (cases-v22.csv) and the research probability from the frozen 2.2 artifact. One station, first N holdout days, h = 1..23.
//   node scripts/research/intraday/engine-parity-v22.mjs [CLIPHL] [days]
import { readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { parseMosCsv } from '../../../src/weather/mos.js';
import { cliWindow } from '../../../src/weather/time.js';
import { parseIemAsosCsv, iemWeatherFields } from '../../../src/weather/intraday/observations.js';
import { forecastIntraday } from '../../../src/weather/intraday/engine.js';
import '../../../src/weather/intraday/temp-v22.js';
import { tempFinalDistribution22, rangeProbability, gapGuidance22 } from '../../../src/weather/intraday/models.js';
import art from '../../../src/weather/artifacts/temp-intraday-v2.2.json' with { type: 'json' };

const CLI = process.argv[2] || 'CLIPHL'; const DAYS = Number(process.argv[3] || 20);
const WX = 'D:/Workers/scratch/predictions-wx'; const DIR = 'D:/Workers/scratch/predictions-intraday';
const st = CLI_STATIONS[CLI];
const isoOf = (s) => new Date(Date.parse(s.replace(' ', 'T') + ':00Z')).toISOString();
const files = await readdir(join(WX, 'mos'));
const runsOf = async (prefix) => { const by = new Map(); for (const f of files.filter((n) => n.startsWith(prefix) && /202[56]/.test(n))) for (const r of parseMosCsv(await readFile(join(WX, 'mos', f), 'utf8'))) { if (!by.has(r.runtime)) by.set(r.runtime, []); by.get(r.runtime).push(r); } return [...by].map(([runtime, rows]) => ({ icao: st.icao, runtime, rows })); };
const nbm = await runsOf(`NBS-${st.icao}-`);
const max6 = new Map(); for (const l of (await readFile(join(DIR, 'asos-max6', `${st.icao}.csv`), 'utf8')).trim().split(/\r?\n/).slice(1)) { const c = l.split(','); if (c[2]) max6.set(isoOf(c[1]), Number(c[2])); }
const wx = new Map(); for (const l of (await readFile(join(DIR, 'asos-wx', `${st.icao}.csv`), 'utf8')).split(/\r?\n/).slice(1)) { const c = l.split(','); if (c.length >= 11) wx.set(isoOf(c[1]), iemWeatherFields(c[2], c.slice(3, 7), c.slice(7, 11))); }
const obs = parseIemAsosCsv(await readFile(join(DIR, 'asos', `${st.icao}.csv`), 'utf8')).filter((r) => r.station === st.icao && r.valid_at >= '2025-06-30')
  .map((r) => { const w = wx.get(r.valid_at); return { ...r, max6_f: max6.get(r.valid_at) ?? null, wxcodes: w ? w.wxcodes : null, sky: w ? w.sky : null }; });

const cases = [];
const rl = createInterface({ input: createReadStream(join(DIR, 'cases-v22.csv')) }); let head = null;
for await (const line of rl) { if (!head) { head = line.split(','); continue; } if (!line.startsWith(CLI + ',')) continue; const c = line.split(','); const o = Object.fromEntries(head.map((h, i) => [h, c[i]])); if (o.split === 'test') cases.push(o); }
const days = [...new Set(cases.map((c) => c.date))].sort().slice(0, DAYS);
const num = (v) => (v === '' ? null : Number(v));
let n = 0; let maxD = 0; const mism = []; const featMism = [];
for (const c of cases.filter((x) => days.includes(x.date))) {
  const win = cliWindow(c.date, st); const now = new Date(Date.parse(win.start) + Number(c.h) * 3600000).toISOString();
  const near = (r) => Math.abs(Date.parse(r.runtime) - Date.parse(now)) < 36 * 3600000;
  const src = { obs: obs.filter((r) => r.valid_at >= win.start && r.valid_at < win.end), nbm: nbm.filter(near) };
  const cc = Math.round(Number(c.pre_g));
  const t = forecastIntraday({ event_type: 'MAX_TEMP_BUCKET', station_id: CLI, observation_start: win.start, observation_end: win.end, detail: { climate_date: c.date }, resolution_authority: 'test', comparator: 'between', threshold_low: cc - 1, threshold_high: cc }, src, { now, tempModelVersion: '2.2.0' });
  const obsMax = Number(c.obs_max); const m6 = num(c.max6);
  const x = { station: CLI, h: art.calibration_resolution === 'hourly' ? Number(c.h) : Math.min(22, Math.max(2, Math.floor(Number(c.h) / 2) * 2)), M: Math.round(m6 !== null ? Math.max(obsMax, m6) : obsMax), D: Math.round(Number(c.cur)), txn: Number(c.g),
    wx: c.wx_regime, obsc: c.wx_obsc === '1', sky_rank: num(c.sky_rank), ceil: num(c.ceil), resid: num(c.resid), rem_peak: num(c.rem_peak), rem_peak_lead: num(c.rem_peak_lead), s1: num(c.s1), s3: num(c.s3), path_chg: num(c.path_chg) };
  x.g = gapGuidance22(art.gap_source, x);
  const research = rangeProbability(tempFinalDistribution22(art, x), cc - 1, cc);
  n += 1;
  if (t.status !== 'OK') { mism.push({ date: c.date, h: c.h, status: t.status, reason: t.reason }); continue; }
  const f = t.features;
  const fe = { M: f.obs_max_so_far_int_f === x.M, wx: f.present_weather_regime === x.wx, resid: f.obs_minus_nbm_path_f === x.resid, peak: f.nbm_remaining_peak_f === x.rem_peak, s3: f.nbm_slope_3h_f === x.s3, pc: f.nbm_run_change_f === x.path_chg };
  if (Object.values(fe).some((v) => !v)) featMism.push({ date: c.date, h: c.h, fe, engine: { M: f.obs_max_so_far_int_f, wx: f.present_weather_regime, resid: f.obs_minus_nbm_path_f, peak: f.nbm_remaining_peak_f, s3: f.nbm_slope_3h_f, pc: f.nbm_run_change_f }, research: { M: x.M, wx: x.wx, resid: x.resid, peak: x.rem_peak, s3: x.s3, pc: x.path_chg } });
  const d = Math.abs(t.rawProbability - research); maxD = Math.max(maxD, d);
  if (d > 1e-9) mism.push({ date: c.date, h: c.h, engine: t.rawProbability, research });
}
console.log(JSON.stringify({ station: CLI, cases: n, max_abs_diff_temp: maxD, n_mismatch: mism.length, mismatches: mism.slice(0, 6), n_feature_mismatch: featMism.length, feature_mismatches: featMism.slice(0, 4) }, null, 1));
