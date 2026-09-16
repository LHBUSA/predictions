import {
  latestMonthlyObservation,
  percentChangeCalendarMonths
} from './time-series.js';

export function buildInflationReplayFeatures({
  headlineNsa,
  coreNsa,
  headlineSa,
  coreSa,
  capturedAt = new Date().toISOString()
}) {
  const headlineLatest = latestMonthlyObservation(headlineNsa, 'headlineNsa');
  const coreLatest = latestMonthlyObservation(coreNsa, 'coreNsa');
  const headlineSaLatest = latestMonthlyObservation(headlineSa, 'headlineSa');
  const coreSaLatest = latestMonthlyObservation(coreSa, 'coreSa');

  const headlineYoY = percentChangeCalendarMonths(headlineNsa, 12, 'headlineYoY');
  const priorHeadlineYoY = percentChangeCalendarMonths(headlineNsa, 12, 'priorHeadlineYoY', 1);
  const coreYoY = percentChangeCalendarMonths(coreNsa, 12, 'coreYoY');
  const headlineMoM = percentChangeCalendarMonths(headlineSa, 1, 'headlineMoM');
  const coreMoM = percentChangeCalendarMonths(coreSa, 1, 'coreMoM');

  return Object.freeze({
    id: `inflation-features:${capturedAt}`,
    capturedAt,
    features: Object.freeze({
      headlineYoY,
      coreYoY,
      headlineMoM,
      coreMoM,
      priorHeadlineYoY,
      energyMoM: 0,
      shelterYoY: coreYoY
    }),
    observations: Object.freeze({
      headlineNsaDate: headlineLatest.date,
      coreNsaDate: coreLatest.date,
      headlineSaDate: headlineSaLatest.date,
      coreSaDate: coreSaLatest.date
    }),
    provenance: Object.freeze([
      { provider: headlineNsa.provider ?? 'unknown', seriesId: headlineNsa.seriesId ?? null, transform: 'calendar-12m-percent-change', role: 'headline-yoy' },
      { provider: coreNsa.provider ?? 'unknown', seriesId: coreNsa.seriesId ?? null, transform: 'calendar-12m-percent-change', role: 'core-yoy' },
      { provider: headlineSa.provider ?? 'unknown', seriesId: headlineSa.seriesId ?? null, transform: 'calendar-1m-percent-change', role: 'headline-mom' },
      { provider: coreSa.provider ?? 'unknown', seriesId: coreSa.seriesId ?? null, transform: 'calendar-1m-percent-change', role: 'core-mom' }
    ]),
    approximations: Object.freeze([
      'energyMoM defaults to 0 in inflation-threshold-baseline v0.1.0 replay features until a dedicated energy component source is wired.',
      'shelterYoY uses coreYoY as a disclosed proxy in inflation-threshold-baseline v0.1.0 replay features until a dedicated shelter source is wired.'
    ])
  });
}
