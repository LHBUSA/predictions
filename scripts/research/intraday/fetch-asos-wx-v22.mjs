// Research pull for maxtemp-intraday v2.2 candidates: METAR present-weather and sky-cover state.
// IEM ASOS archive (asos.py) decoded METAR fields: wxcodes (present-weather group, e.g. "-RA BR"), skyc1..4 (FEW/SCT/BKN/OVC/
// VV/CLR/SKC), skyl1..4 (layer base, ft AGL). Routine (3) + special (4) reports, the same report set as asos/<ICAO>.csv,
// 2023-01-01..2026-10-01 UTC. Writes asos-wx/<ICAO>.csv: station,valid,wxcodes,skyc1,skyc2,skyc3,skyc4,skyl1,skyl2,skyl3,skyl4
// Sequential, polite, existing files kept. Not a product runtime.
//   node scripts/research/intraday/fetch-asos-wx-v22.mjs [outDir]
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';

const OUT = process.argv[2] || 'D:/Workers/scratch/predictions-intraday';
const UA = 'PropBetEdgePredictions/0.1 research (+https://predictions.propbetedge.ai; data@propbetedge.ai)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
await mkdir(join(OUT, 'asos-wx'), { recursive: true });
const FIELDS = ['wxcodes', 'skyc1', 'skyc2', 'skyc3', 'skyc4', 'skyl1', 'skyl2', 'skyl3', 'skyl4'];
for (const st of Object.values(CLI_STATIONS)) {
  const path = join(OUT, 'asos-wx', `${st.icao}.csv`);
  if (await exists(path)) continue;
  const id = st.icao.replace(/^K/, '');
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${id}&${FIELDS.map((f) => `data=${f}`).join('&')}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&direct=no&report_type=3&report_type=4&year1=2023&month1=1&day1=1&year2=2026&month2=10&day2=1`;
  let text = null;
  for (let attempt = 1; attempt <= 4 && text === null; attempt += 1) {
    try { const res = await fetch(url, { headers: { 'user-agent': UA } }); if (res.ok) text = await res.text(); else { console.error(`  ${res.status} ${id} attempt ${attempt}`); await sleep(15000 * attempt); } }
    catch (e) { console.error(`  ${e.message} ${id} attempt ${attempt}`); await sleep(15000 * attempt); }
  }
  if (text === null) { console.error(`FAILED ${id}`); continue; }
  await writeFile(path, text);
  console.log(`asos-wx ${st.icao} ${text.length}B ${new Date().toISOString()}`);
  await sleep(3000);
}
console.log('done');
