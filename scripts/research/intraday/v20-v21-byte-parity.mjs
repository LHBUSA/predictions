// Byte-parity proof for the 2.2.0 additions: forecastIntraday v2.0.0 / v2.1.0 (temp) and precip 2.0.0 outputs, incl.
// inputHash, must be byte-identical between a reference tree (e.g. a copy of src/ at git HEAD) and the working tree,
// with AND without the new 2.2 observation fields (wxcodes, sky) riding on the obs rows.
//   node scripts/research/intraday/v20-v21-byte-parity.mjs <referenceRootWithSrc> [CLIPHL,CLIDEN] [days]
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { parseMosCsv } from '../../../src/weather/mos.js';
import { cliWindow } from '../../../src/weather/time.js';
import { parseIemAsosCsv, iemWeatherFields } from '../../../src/weather/intraday/observations.js';
import { forecastIntraday as engineNew } from '../../../src/weather/intraday/engine.js';

const REF = resolve(process.argv[2]);
const STATIONS = (process.argv[3] || 'CLIPHL,CLIDEN').split(',');
const DAYS = Number(process.argv[4] || 8);
const { forecastIntraday: engineRef } = await import(pathToFileURL(join(REF, 'src/weather/intraday/engine.js')).href);
const WX = 'D:/Workers/scratch/predictions-wx'; const DIR = 'D:/Workers/scratch/predictions-intraday';
const files = await readdir(join(WX, 'mos'));
const isoOf = (s) => new Date(Date.parse(s.replace(' ', 'T') + ':00Z')).toISOString();
const sha = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
let n = 0; let diff = 0; const firstDiffs = [];
for (const cli of STATIONS) {
  const st = CLI_STATIONS[cli];
  const runsOf = async (prefix) => { const by = new Map(); for (const f of files.filter((x) => x.startsWith(prefix) && /2025/.test(x))) for (const r of parseMosCsv(await readFile(join(WX, 'mos', f), 'utf8'))) { if (!by.has(r.runtime)) by.set(r.runtime, []); by.get(r.runtime).push(r); } return [...by].map(([runtime, rows]) => ({ icao: st.icao, runtime, rows })); };
  const gfs = await runsOf(`${st.icao}-`); const nbm = await runsOf(`NBS-${st.icao}-`);
  const max6 = new Map(); for (const l of (await readFile(join(DIR, 'asos-max6', `${st.icao}.csv`), 'utf8')).trim().split(/\r?\n/).slice(1)) { const c = l.split(','); if (c[2]) max6.set(isoOf(c[1]), Number(c[2])); }
  const wx = new Map(); for (const l of (await readFile(join(DIR, 'asos-wx', `${st.icao}.csv`), 'utf8')).split(/\r?\n/).slice(1)) { const c = l.split(','); if (c.length >= 11) wx.set(isoOf(c[1]), iemWeatherFields(c[2], c.slice(3, 7), c.slice(7, 11))); }
  const obs = parseIemAsosCsv(await readFile(join(DIR, 'asos', `${st.icao}.csv`), 'utf8')).filter((r) => r.station === st.icao && r.valid_at >= '2025-07-01').map((r) => ({ ...r, max6_f: max6.get(r.valid_at) ?? null }));
  const obsWx = obs.map((r) => ({ ...r, ...(wx.get(r.valid_at) || { wxcodes: null, sky: null }) }));
  for (let k = 0; k < DAYS; k += 1) {
    const date = new Date(Date.parse('2025-07-01T00:00:00Z') + k * 13 * 86400000).toISOString().slice(0, 10); // spread over the season
    const win = cliWindow(date, st);
    const near = (r) => Math.abs(Date.parse(r.runtime) - Date.parse(win.start)) < 60 * 3600000;
    const N = nbm.filter(near); const G = gfs.filter(near);
    const inWin = (rows) => rows.filter((r) => r.valid_at >= win.start && r.valid_at < win.end);
    const o1 = inWin(obs); const o2 = inWin(obsWx);
    for (let h = 1; h <= 23; h += 1) {
      const now = new Date(Date.parse(win.start) + h * 3600000 + 7 * 60000).toISOString();
      const base = { station_id: cli, observation_start: win.start, observation_end: win.end, detail: { climate_date: date }, resolution_authority: 'test' };
      const contracts = [{ ...base, event_type: 'MAX_TEMP_BUCKET', comparator: 'between', threshold_low: 70, threshold_high: 71 }, { ...base, event_type: 'MAX_TEMP_BUCKET', comparator: 'less', threshold_low: null, threshold_high: 60 }, { ...base, event_type: 'PRECIP_ANY', comparator: '>', threshold_low: 0, threshold_high: null }];
      for (const c of contracts) for (const v of ['2.0.0', '2.1.0']) {
        if (c.event_type === 'PRECIP_ANY' && v === '2.1.0') continue;
        const ref = sha(engineRef(c, { obs: o1, nbm: N, mos: G }, { now, tempModelVersion: v }));
        const a = sha(engineNew(c, { obs: o1, nbm: N, mos: G }, { now, tempModelVersion: v }));
        const b = sha(engineNew(c, { obs: o2, nbm: N, mos: G }, { now, tempModelVersion: v }));
        n += 1;
        if (a !== ref || b !== ref) { diff += 1; if (firstDiffs.length < 5) firstDiffs.push({ cli, date, h, v, type: c.event_type, a: a === ref, b: b === ref }); }
      }
    }
  }
}
console.log(JSON.stringify({ reference: REF, compared_outputs: n, byte_differences: diff, firstDiffs }));
