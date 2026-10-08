// CPI V1 SHADOW runtime calendar and known model-availability constraints.
//
// Release dates come from the BLS schedule (https://www.bls.gov/schedule/news_release/cpi.htm, read 2026-10-07).
// Every CPI release is 08:30 ET. The forecast horizon is the artifact's T-1D cutoff: 20:00 ET on the calendar day
// before the release, exactly as scripts/research/cpi/build-dataset.mjs HORIZONS['T-1D'] builds the training rows.
// BLS had not posted its 2027 schedule on 2026-10-07; months missing here get no forecast run (the admin report
// shows the calendar horizon so the gap is visible before it matters).

import { addDaysYmd, etToUtcIso } from './timeline.js';

export const CALENDAR_VERSION = 'cpi-calendar/1';
export const CALENDAR_SOURCE = Object.freeze({ url: 'https://www.bls.gov/schedule/news_release/cpi.htm', read: '2026-10-07' });

// reference month -> release date (ET)
export const RELEASE_DATES = Object.freeze({
  '2026-08': '2026-09-11',
  '2026-09': '2026-10-14',
  '2026-10': '2026-11-10',
  '2026-11': '2026-12-10'
});

export const HORIZON = 'T-1D';

export function releaseFor(referenceMonth) {
  const releaseDate = RELEASE_DATES[referenceMonth];
  if (!releaseDate) return null;
  return {
    referenceMonth,
    releaseDate,
    releaseAt: etToUtcIso(releaseDate, 8, 30),
    cutoffAt: etToUtcIso(addDaysYmd(releaseDate, -1), 20, 0)
  };
}

export function calendarHorizon() {
  return Object.keys(RELEASE_DATES).sort().at(-1);
}

// Known input gaps, hard-coded so the lane can never paper over them. The y/y models need the M-12 SA 1-month
// first print (H_BASE / C_BASE). The 2025 federal shutdown means BLS never published October 2025 CPI, and the
// November 2025 release carried no 1-month SA change. So the 2026-10 and 2026-11 y/y forecasts have no legitimate
// input: they are recorded as NO_FORECAST / INPUT_UNAVAILABLE, never as 0, a fallback model, an imputed value or a
// stale earlier forecast. The y/y lanes resume with 2026-12. buildFeatures() independently reports the same inputs
// missing (pinned by test/cpi-shadow.test.js), so this table and the data cannot disagree silently.
export const KNOWN_INPUT_GAPS = Object.freeze([
  Object.freeze({
    targets: Object.freeze(['headline_yoy', 'core_yoy']),
    referenceMonths: Object.freeze(['2026-10', '2026-11']),
    status: 'NO_FORECAST',
    reason: 'INPUT_UNAVAILABLE',
    detail: 'Required M-12 SA 1-month first print (2025-10 / 2025-11) does not exist: 2025 federal shutdown. Yearly lanes resume with 2026-12.'
  })
]);

export function knownGap(target, referenceMonth) {
  return KNOWN_INPUT_GAPS.find((g) => g.targets.includes(target) && g.referenceMonths.includes(referenceMonth)) ?? null;
}
