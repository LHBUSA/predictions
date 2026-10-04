// One-off replay: KXHIGHPHIL-26OCT04 at 18:03Z with the live api.weather.gov KPHL payload (METARs only, through 17:53Z),
// NBM 12Z day max 67 F. Runs maxtemp-intraday 2.0.0 and 2.1.0 on the same inputs. No market data is read.
//   node scripts/research/intraday/phl-case-2026-10-04.mjs [payload.json]
import { readFileSync } from 'node:fs';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { cliWindow } from '../../../src/weather/time.js';
import { parseNwsObservations } from '../../../src/weather/intraday/observations.js';
import { forecastIntraday } from '../../../src/weather/intraday/engine.js';

const payload = JSON.parse(readFileSync(process.argv[2] || 'D:/Workers/scratch/predictions-intraday/kphl-obs-2026-10-04.json', 'utf8'));
const st = CLI_STATIONS.CLIPHL; const win = cliWindow('2026-10-04', st);
const NOW = '2026-10-04T18:03:00.000Z';
const obs = parseNwsObservations(payload).filter((r) => r.valid_at <= '2026-10-04T17:53:00.000Z');
const nbm = { icao: 'KPHL', runtime: '2026-10-04T12:00:00.000Z', url: 'NBM 12Z (as supplied)', observationKey: 'nbm-12z', rows: [{ runtime: '2026-10-04T12:00:00.000Z', ftime: '2026-10-05T00:00:00.000Z', txn: 67, xnd: null, p06: null, n_x: null }] };
const buckets = [['63° or below', 'less', null, 64], ['64° to 65°', 'between', 64, 65], ['66° to 67°', 'between', 66, 67], ['68° to 69°', 'between', 68, 69], ['70° to 71°', 'between', 70, 71], ['72° or above', 'greater', 71, null]];
const out = {};
for (const v of ['2.0.0', '2.1.0']) {
  out[v] = {};
  for (const [label, comparator, lo, hi] of buckets) {
    const c = { event_type: 'MAX_TEMP_BUCKET', station_id: 'CLIPHL', observation_start: win.start, observation_end: win.end, detail: { climate_date: '2026-10-04' }, comparator, threshold_low: lo, threshold_high: hi, resolution_authority: 'TWC' };
    const f = forecastIntraday(c, { obs, nbm }, { now: NOW, tempModelVersion: v });
    out[v][label] = f.status === 'OK' ? { p: f.probability, raw: +f.rawProbability.toFixed(4) } : f.status;
    if (label === '64° to 65°') out[v]._inputs = f.status === 'OK' ? { M: f.features.obs_max_so_far_int_f, obs_max_f: f.features.obs_max_so_far_f, max6: f.features.obs_max6_so_far_f ?? null, current: f.features.current_temp_f, h: f.features.calibration_hour_lst, g: f.features.guidance_max_temp_f, below: f.explanation.prob_below_observed_max, cells: f.explanation.calibration_cells, n_obs: obs.length } : f;
  }
}
console.log(JSON.stringify(out, null, 1));
