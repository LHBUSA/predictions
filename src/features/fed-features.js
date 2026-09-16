import {
  latestMonthlyObservation,
  levelChangeCalendarMonths,
  percentChangeCalendarMonths
} from './time-series.js';

export function buildFedFeatureSnapshot({ coreInflation, headlineInflation, unemployment, capturedAt = new Date().toISOString() }) {
  const coreLatest = latestMonthlyObservation(coreInflation, 'coreInflation');
  const headlineLatest = latestMonthlyObservation(headlineInflation, 'headlineInflation');
  const jobless = latestMonthlyObservation(unemployment, 'unemployment');

  // CPIAUCSL and CPILFESL are price-index levels. Use the observation for the
  // exact calendar month one year earlier rather than assuming the 12th prior
  // row is twelve months ago. That remains correct when a release month is
  // missing from the historical series.
  const coreInflationYoY = percentChangeCalendarMonths(coreInflation, 12, 'coreInflationYoY');
  const headlineInflationYoY = percentChangeCalendarMonths(headlineInflation, 12, 'headlineInflationYoY');

  return Object.freeze({
    id: `fed-features:${capturedAt}`,
    capturedAt,
    features: Object.freeze({
      coreInflationYoY,
      headlineInflationYoY,
      unemploymentRate: jobless.value,
      unemploymentChange3m: levelChangeCalendarMonths(unemployment, 3, 'unemploymentChange3m')
    }),
    observations: Object.freeze({
      coreInflationDate: coreLatest.date,
      headlineInflationDate: headlineLatest.date,
      unemploymentDate: jobless.date
    }),
    provenance: Object.freeze([
      { provider: coreInflation.provider ?? 'unknown', seriesId: coreInflation.seriesId ?? null, transform: 'calendar-12m-percent-change' },
      { provider: headlineInflation.provider ?? 'unknown', seriesId: headlineInflation.seriesId ?? null, transform: 'calendar-12m-percent-change' },
      { provider: unemployment.provider ?? 'unknown', seriesId: unemployment.seriesId ?? null, transform: 'level-and-calendar-3m-change' }
    ])
  });
}
