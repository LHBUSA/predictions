// Research pull for maxtemp-intraday v2.1: METAR 6-hour maximum (1sTTT) and minimum (2sTTT) groups.
// IEM asos.py does not expose max_tmpf_6hr as a CSV column, so the raw METAR (data=metar, routine reports) is fetched
// and only the decoded groups are kept: asos-max6/<ICAO>.csv  station,valid,max6_f,min6_f  (valid = METAR valid time).
//   node scripts/research/intraday/fetch-asos-max6.mjs [outDir]
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_STATIONS } from '../../../src/weather/stations.js';
import { parseMetarSixHour } from '../../../src/weather/intraday/observations.js';

const OUT = process.argv[2] || 'D:/Workers/scratch/predictions-intraday';
const UA = 'PropBetEdgePredictions/0.1 research (+https://predictions.propbetedge.ai; data@propbetedge.ai)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
await mkdir(join(OUT, 'asos-max6'), { recursive: true });
for (const st of Object.values(CLI_STATIONS)) {
  const path = join(OUT, 'asos-max6', `${st.icao}.csv`);
  if (await exists(path)) continue;
  const id = st.icao.replace(/^K/, '');
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${id}&data=metar&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&direct=no&report_type=3&year1=2023&month1=1&day1=1&year2=2026&month2=10&day2=1`;
  let text = null;
  for (let attempt = 1; attempt <= 4 && text === null; attempt += 1) {
    try { const res = await fetch(url, { headers: { 'user-agent': UA } }); if (res.ok) text = await res.text(); else { console.error(`  ${res.status} ${id}`); await sleep(15000 * attempt); } }
    catch (e) { console.error(`  ${e.message} ${id}`); await sleep(15000 * attempt); }
  }
  if (text === null) { console.error(`FAILED ${id}`); continue; }
  const out = ['station,valid,max6_f,min6_f'];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i1 = line.indexOf(','); const i2 = line.indexOf(',', i1 + 1);
    if (i2 < 0) continue;
    const g = parseMetarSixHour(line.slice(i2 + 1));
    if (g.max6_f !== null || g.min6_f !== null) out.push(`${st.icao},${line.slice(i1 + 1, i2)},${g.max6_f ?? ''},${g.min6_f ?? ''}`);
  }
  await writeFile(path, out.join('\n') + '\n');
  console.log(`max6 ${st.icao} ${out.length - 1} groups (${text.length}B raw) ${new Date().toISOString()}`);
  await sleep(3000);
}
console.log('done');
