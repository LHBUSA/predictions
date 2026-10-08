// EIA weekly U.S. all-grades retail gasoline (EMM_EPM0_PTE_NUS_DPG) history-page parser. Pure; shared by the research
// build (scripts/research/cpi/parse-eia-gasoline.mjs) and the pbe-predictions CPI SHADOW first-seen capture.
import { monthIndex } from './timeline.js';

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
