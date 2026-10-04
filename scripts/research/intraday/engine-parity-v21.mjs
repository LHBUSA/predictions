// Parity (maxtemp-intraday 2.1.0, METAR 6-h max merged into obs rows): the production engine (forecastIntraday) on archived raw inputs reproduces the research case features and
// probabilities used for the holdout. One station, first N holdout days, every cutoff hour.
//   node scripts/research/intraday/engine-parity.mjs [CLIPHL] [days]
import { readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { parseMosCsv } from '../../../src/weather/mos.js';
import { cliWindow } from '../../../src/weather/time.js';
import { parseIemAsosCsv } from '../../../src/weather/intraday/observations.js';
import { forecastIntraday } from '../../../src/weather/intraday/engine.js';
import { tempFinalDistribution, rangeProbability, precipIntradayProbability } from '../../../src/weather/intraday/models.js';
import tempArt from '../../../src/weather/artifacts/temp-intraday-v2.1.json' with { type: 'json' };
import precipArt from '../../../src/weather/artifacts/precip-intraday-v2.0.json' with { type: 'json' };

const CLI = process.argv[2] || 'CLIPHL'; const DAYS = Number(process.argv[3] || 20);
const WX = 'D:/Workers/scratch/predictions-wx'; const DIR = 'D:/Workers/scratch/predictions-intraday';
const st = CLI_STATIONS[CLI];
const files = await readdir(join(WX, 'mos'));
const runsOf = async (prefix) => { const by = new Map(); for (const f of files.filter((n) => n.startsWith(prefix) && /202[56]/.test(n))) for (const r of parseMosCsv(await readFile(join(WX, 'mos', f), 'utf8'))) { if (!by.has(r.runtime)) by.set(r.runtime, []); by.get(r.runtime).push(r); } return [...by].map(([runtime, rows]) => ({ icao: st.icao, runtime, rows })); };
const gfs = await runsOf(`${st.icao}-`); const nbm = await runsOf(`NBS-${st.icao}-`);
const max6 = new Map((await readFile(join(DIR, 'asos-max6', `${st.icao}.csv`), 'utf8')).trim().split(String.fromCharCode(10)).slice(1).map((l) => l.trim().split(',')).filter((c) => c[2] !== '').map((c) => [new Date(Date.parse(c[1].replace(' ', 'T') + ':00Z')).toISOString(), Number(c[2])]));
const obs = parseIemAsosCsv(await readFile(join(DIR, 'asos', `${st.icao}.csv`), 'utf8')).filter((r) => r.station === st.icao).map((r) => ({ ...r, max6_f: max6.get(r.valid_at) ?? null }));
// a 6-h group on a report absent from the tmpf pull (none expected: both are routine METARs) would be dropped here

const cases = [];
const rl = createInterface({ input: createReadStream(join(DIR, 'cases-v21.csv')) }); let head = null;
for await (const line of rl) { if (!head) { head = line.split(','); continue; } if (!line.startsWith(CLI + ',')) continue; const c = line.split(','); const o = Object.fromEntries(head.map((h, i) => [h, c[i]])); if (o.split === 'test') cases.push(o); }
const days = [...new Set(cases.map((c) => c.date))].sort().slice(0, DAYS);
let n = 0; let maxDT = 0; let maxDR = 0; const mism = [];
for (const c of cases.filter((x) => days.includes(x.date))) {
  const win = cliWindow(c.date, st); const now = new Date(Date.parse(win.start) + Number(c.h) * 3600000).toISOString();
  const near = (r) => Math.abs(Date.parse(r.runtime) - Date.parse(now)) < 36 * 3600000;
  const src = { obs: obs.filter((r) => r.valid_at >= win.start && r.valid_at < win.end), nbm: nbm.filter(near), mos: gfs.filter(near) };
  const base = { station_id: CLI, observation_start: win.start, observation_end: win.end, detail: { climate_date: c.date }, resolution_authority: 'test' };
  const M = Math.round(c.max6 !== '' ? Math.max(Number(c.obs_max), Number(c.max6)) : Number(c.obs_max)); const cc = Math.round(Number(c.pre_g));
  const t = forecastIntraday({ ...base, event_type: 'MAX_TEMP_BUCKET', comparator: 'between', threshold_low: cc - 1, threshold_high: cc }, src, { now, tempModelVersion: '2.1.0' });
  const research = rangeProbability(tempFinalDistribution(tempArt, { station: CLI, h: Number(c.h), M, D: Math.round(Number(c.cur)), g: Number(c.g) }), cc - 1, cc);
  const r = forecastIntraday({ ...base, event_type: 'PRECIP_ANY', comparator: '>', threshold_low: 0, threshold_high: null }, src, { now });
  const rr = precipIntradayProbability(precipArt, { station: CLI, measured_in_window: c.meas === '1' && c.meas_straddle !== '1', straddle: c.meas_straddle === '1', trace: c.trace === '1', rem_pop: Number(c.rem_pop), rem_h: Number(c.rem_h), rem_src: c.rem_src, clim_rate: Number(c.clim_rate) }).probability;
  n += 1;
  if (t.status !== 'OK' || r.status !== 'OK') { mism.push({ date: c.date, h: c.h, t: t.status, r: r.status }); continue; }
  const dT = Math.abs(t.rawProbability - research); const dR = Math.abs(r.rawProbability - rr);
  maxDT = Math.max(maxDT, dT); maxDR = Math.max(maxDR, dR);
  if (dT > 1e-9 || dR > 1e-3) mism.push({ date: c.date, h: c.h, engine_t: t.rawProbability, research_t: research, engine_r: r.rawProbability, research_r: rr });
}
console.log(JSON.stringify({ station: CLI, cases: n, max_abs_diff_temp: maxDT, max_abs_diff_rain: maxDR, mismatches: mism.slice(0, 10), n_mismatch: mism.length }, null, 1));
