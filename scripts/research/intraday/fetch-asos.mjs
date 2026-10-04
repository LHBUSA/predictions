// Research data pull for weather intraday v2 (not a product runtime).
//   node scripts/research/intraday/fetch-asos.mjs [outDir]
// Writes asos/<ICAO>.csv per CLI station: IEM ASOS archive (official NWS/FAA METARs as decoded by the Iowa
// Environmental Mesonet), routine (report_type 3) + special (4) reports, tmpf + p01i, 2023-01-01..2026-10-01 UTC.
// Sequential, one request per station, pause between requests, existing files kept.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';

const OUT = process.argv[2] || 'D:/Workers/scratch/predictions-intraday';
const UA = 'PropBetEdgePredictions/0.1 research (+https://predictions.propbetedge.ai; data@propbetedge.ai)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
await mkdir(join(OUT, 'asos'), { recursive: true });
for (const st of Object.values(CLI_STATIONS)) {
  const path = join(OUT, 'asos', `${st.icao}.csv`);
  if (await exists(path)) continue;
  const id = st.icao.replace(/^K/, '');
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${id}&data=tmpf&data=p01i&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3&report_type=4&year1=2023&month1=1&day1=1&year2=2026&month2=10&day2=1`;
  let text = null;
  for (let attempt = 1; attempt <= 4 && text === null; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      if (res.ok) text = await res.text(); else { console.error(`  ${res.status} ${id} attempt ${attempt}`); await sleep(15000 * attempt); }
    } catch (e) { console.error(`  ${e.message} ${id} attempt ${attempt}`); await sleep(15000 * attempt); }
  }
  if (text === null) { console.error(`FAILED ${id}`); continue; }
  await writeFile(path, text);
  console.log(`asos ${st.icao} ${text.length}B ${new Date().toISOString()}`);
  await sleep(3000);
}
console.log('done');
