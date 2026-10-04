// maxtemp-intraday v2.1 cases: cases.csv (v2.0 pipeline, unchanged) + the METAR 6-hour maximum groups usable at each
// cutoff. A group counts only if its whole 6-h period [valid - 6 h, valid] lies inside the climate-day window and it
// was available (valid + lag) by the cutoff. Writes cases-v21.csv with extra columns max6, n_max6.
//   node scripts/research/intraday/augment-max6.mjs [intradayDir]
import { createReadStream } from 'node:fs';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { cliWindow } from '../../../src/weather/time.js';
import { OBS_PUBLICATION_LAG_MIN } from '../../../src/weather/intraday/features.js';

const DIR = process.argv[2] || 'D:/Workers/scratch/predictions-intraday';
const H = 3600000; const LAG = OBS_PUBLICATION_LAG_MIN * 60000;
const out = join(DIR, 'cases-v21.csv');
let cur = null; let groups = [];
const load = async (cli) => {
  const st = CLI_STATIONS[cli];
  const text = await readFile(join(DIR, 'asos-max6', `${st.icao}.csv`), 'utf8');
  return text.trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).filter((c) => c[2] !== '').map((c) => ({ v: Date.parse(c[1].replace(' ', 'T') + ':00Z'), f: Number(c[2]) })).sort((a, b) => a.v - b.v);
};
const rl = createInterface({ input: createReadStream(join(DIR, 'cases.csv')) });
let head = true; let buf = []; let n = 0; let withMax6 = 0;
for await (const line of rl) {
  if (head) { await writeFile(out, line + ',max6,n_max6\n'); head = false; continue; }
  const c = line.split(',');
  if (c[0] !== cur) { if (buf.length) { await appendFile(out, buf.join('\n') + '\n'); buf = []; } cur = c[0]; groups = await load(cur); }
  const win = cliWindow(c[1], CLI_STATIONS[cur]); const S = Date.parse(win.start); const E = Date.parse(win.end); const t = S + Number(c[3]) * H;
  let m = null; let k = 0;
  for (const g of groups) { if (g.v > t) break; if (g.v - 6 * H >= S && g.v < E && g.v + LAG <= t) { k += 1; if (m === null || g.f > m) m = g.f; } }
  if (m !== null) withMax6 += 1;
  buf.push(`${line},${m ?? ''},${k}`); n += 1;
}
if (buf.length) await appendFile(out, buf.join('\n') + '\n');
console.log({ rows: n, with_max6: withMax6 });
