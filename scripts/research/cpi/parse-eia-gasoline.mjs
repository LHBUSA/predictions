#!/usr/bin/env node
// Parse EIA weekly U.S. regular-and-all-grades retail gasoline prices
// (series EMM_EPM0_PTE_NUS_DPG, $/gal, survey as of Monday 8:00 a.m. local)
// from the EIA history page into a JSON week list.
//
// Usage: node scripts/research/cpi/parse-eia-gasoline.mjs <LeafHandler.html> <out.json>

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { monthIndex } from '../../../src/macro/cpi/timeline.js';

export const EIA_SERIES = 'EMM_EPM0_PTE_NUS_DPG';
export const EIA_SOURCE_URL = 'https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=EMM_EPM0_PTE_NUS_DPG&f=W';

export function parseEiaWeekly(html) {
  const weeks = [];
  const rowRe = /<td class='B6'>(?:&nbsp;)*\s*(\d{4})-([A-Za-z]{3})<\/td>([\s\S]*?)<\/tr>/g;
  let row;
  while ((row = rowRe.exec(html))) {
    const year = Number(row[1]);
    const month = monthIndex(row[2]);
    const cellRe = /<td class='B5'>(\d{2})\/(\d{2})(?:&nbsp;)*<\/td>\s*<td class='B3'>([\d.]+)(?:&nbsp;)*<\/td>/g;
    let cell;
    while ((cell = cellRe.exec(row[3]))) {
      const mm = Number(cell[1]);
      const dd = Number(cell[2]);
      // A row is labelled by the month of its first week; a week in the row can
      // never belong to an earlier month, so a lower month number means a new year.
      const y = mm < month ? year + 1 : year;
      weeks.push({ date: `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, price: Number(cell[3]) });
    }
  }
  weeks.sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < weeks.length; i += 1) {
    const gap = (Date.parse(weeks[i].date) - Date.parse(weeks[i - 1].date)) / 86400000;
    if (gap <= 0) throw new Error(`EIA weeks out of order at ${weeks[i].date}`);
  }
  return weeks;
}

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
