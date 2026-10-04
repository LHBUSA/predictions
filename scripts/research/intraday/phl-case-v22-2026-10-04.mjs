// DIAGNOSTIC ONLY (never training truth, never used for selection): KXHIGHPHIL-26OCT04 at 18:18Z and 18:33Z.
// Inputs: live api.weather.gov KPHL METARs/specials (kphl-obs-2026-10-04-v22.json, METARs only, available = valid + 10 min),
// IEM NBS runs 2026-10-04 06Z and 12Z (rows incl. 3-hourly TMP and TXN). Runs maxtemp-intraday 2.0.0 / 2.1.0 / 2.2.0 on
// identical inputs. No market data is read.
//   node scripts/research/intraday/phl-case-v22-2026-10-04.mjs
import { readFileSync } from 'node:fs';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { cliWindow } from '../../../src/weather/time.js';
import { normalizeMosRow } from '../../../src/weather/mos.js';
import { parseNwsObservationsV22 } from '../../../src/weather/intraday/observations.js';
import { forecastIntraday } from '../../../src/weather/intraday/engine.js';
import '../../../src/weather/intraday/temp-v22.js';

const DIR = 'D:/Workers/scratch/predictions-intraday';
const payload = JSON.parse(readFileSync(`${DIR}/kphl-obs-2026-10-04-v22.json`, 'utf8'));
const st = CLI_STATIONS.CLIPHL; const win = cliWindow('2026-10-04', st);
const run = (h) => { const b = JSON.parse(readFileSync(`${DIR}/nbs-kphl-2026-10-04T${h}Z.json`, 'utf8')); const rows = b.data.map(normalizeMosRow).filter((r) => r.runtime && r.ftime); return { icao: 'KPHL', runtime: rows[0].runtime, rows, url: `https://mesonet.agron.iastate.edu/api/1/mos.json?station=KPHL&model=NBS&runtime=2026-10-04T${h}:00Z` }; };
const nbm = [run('12'), run('06')];
const allObs = parseNwsObservationsV22(payload);
const buckets = [['63 or below', 'less', null, 64], ['64-65', 'between', 64, 65], ['66-67', 'between', 66, 67], ['68-69', 'between', 68, 69], ['70-71', 'between', 70, 71], ['72 or above', 'greater', 71, null]];
const out = {};
for (const NOW of ['2026-10-04T18:18:00.000Z', '2026-10-04T18:33:00.000Z']) {
  const obs = allObs.filter((r) => Date.parse(r.available_at) <= Date.parse(NOW));
  out[NOW] = {};
  for (const v of ['2.0.0', '2.1.0', '2.2.0']) {
    const row = {};
    for (const [label, comparator, lo, hi] of buckets) {
      const c = { event_type: 'MAX_TEMP_BUCKET', station_id: 'CLIPHL', observation_start: win.start, observation_end: win.end, detail: { climate_date: '2026-10-04' }, comparator, threshold_low: lo, threshold_high: hi, resolution_authority: 'TWC' };
      const f = forecastIntraday(c, { obs, nbm }, { now: NOW, tempModelVersion: v });
      row[label] = f.status === 'OK' ? +f.rawProbability.toFixed(4) : f.status;
      if (label === '64-65' && f.status === 'OK' && v === '2.2.0') {
        const F = f.features;
        row._inputs = { M: F.obs_max_so_far_int_f, current: F.current_temp_f, h: F.calibration_hour_lst, wx: F.present_weather_regime, sky: F.sky_cover_rank, ceil: F.ceiling_ft, txn: F.guidance_max_temp_f, nbm_now: F.nbm_path_at_current_report_f, resid: F.obs_minus_nbm_path_f, rem_peak: F.nbm_remaining_peak_f, lead: F.nbm_remaining_peak_lead_h, s1: F.nbm_slope_1h_f, s3: F.nbm_slope_3h_f, run_change: F.nbm_run_change_f, gap_guidance: F.gap_guidance_f, cells: f.explanation.calibration_cells, keys: f.explanation.calibration_keys, last_ob: obs[obs.length - 1].valid_at };
      }
      if (label === '64-65' && f.status === 'OK' && v !== '2.2.0') row._inputs = { M: f.features.obs_max_so_far_int_f, h: f.features.calibration_hour_lst, g: f.features.guidance_max_temp_f };
    }
    out[NOW][v] = row;
  }
}
console.log(JSON.stringify(out, null, 1));
