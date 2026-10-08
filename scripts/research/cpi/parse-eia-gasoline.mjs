#!/usr/bin/env node
// Parse EIA weekly U.S. regular-and-all-grades retail gasoline prices
// (series EMM_EPM0_PTE_NUS_DPG, $/gal, survey as of Monday 8:00 a.m. local)
// from the EIA history page into a JSON week list.
//
// Usage: node scripts/research/cpi/parse-eia-gasoline.mjs <LeafHandler.html> <out.json>

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export { EIA_SERIES, EIA_SOURCE_URL, parseEiaWeekly } from '../../../src/macro/cpi/eia-gasoline.js';
import { EIA_SERIES, EIA_SOURCE_URL, parseEiaWeekly } from '../../../src/macro/cpi/eia-gasoline.js';

function main() {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('usage: parse-eia-gasoline.mjs <LeafHandler.html> <out.json>');
    process.exit(2);
  }
  const html = readFileSync(src, 'utf8');
  const weeks = parseEiaWeekly(html);
  if (weeks.length < 500) throw new Error(`only ${weeks.length} EIA weeks parsed`);
  const payload = {
    series: EIA_SERIES,
    title: 'Weekly U.S. All Grades All Formulations Retail Gasoline Prices (Dollars per Gallon)',
    source: 'U.S. Energy Information Administration (public domain)',
    sourceUrl: EIA_SOURCE_URL,
    sourceSha256: createHash('sha256').update(html).digest('hex'),
    publicationRule: 'Survey prices as of Monday 8:00 a.m.; EIA publishes Monday ~5:00 p.m. ET (Tuesday after a federal holiday). CPI V1 treats a week as available only from its date + 1 day 17:00 ET.',
    vintageNote: 'EIA keeps no public vintage archive for this weekly survey. Values are the current EIA history; see the CPI V1 provenance report.',
    weekCount: weeks.length,
    first: weeks[0].date,
    last: weeks[weeks.length - 1].date,
    weeks
  };
  writeFileSync(out, `${JSON.stringify(payload)}\n`);
  console.log(`parsed ${weeks.length} EIA weeks ${payload.first}..${payload.last}`);
}

if (process.argv[1]?.endsWith('parse-eia-gasoline.mjs')) main();
