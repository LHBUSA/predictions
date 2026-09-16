import {
  latestMonthlyObservation,
  levelChangeCalendarMonths,
  observationForMonth,
  shiftMonthKey
} from './time-series.js';

function latestDatedObservation(series, field) {
  const row = (series?.observations ?? [])
    .filter((item) => item?.date && item?.value !== null && item?.value !== undefined && Number.isFinite(Number(item.value)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  if (!row) throw new Error(`missing usable observation for ${field}`);
  return Object.freeze({ ...row, value: Number(row.value) });
}

export function buildEmploymentReplayFeatures({
  unemployment,
  payrolls,
  initialClaims,
  continuingClaims,
  capturedAt = new Date().toISOString()
}) {
  const unemploymentLatest = latestMonthlyObservation(unemployment, 'unemployment');
  const unemploymentPrior = observationForMonth(
    unemployment,
    shiftMonthKey(unemploymentLatest.month, -1),
    'priorUnemployment'
  );
  const payrollLatest = latestMonthlyObservation(payrolls, 'payrolls');
  const initialClaimsLatest = latestDatedObservation(initialClaims, 'initialClaims');
  const continuingClaimsLatest = latestDatedObservation(continuingClaims, 'continuingClaims');

  // PAYEMS is a payroll-employment level measured in thousands of persons.
  // The specialist model consumes monthly changes in thousands, so compute
  // exact calendar-month level differences from the vintage-visible series.
  const payrollChangeK = levelChangeCalendarMonths(payrolls, 1, 'payrollChangeK');
  const priorPayrollChangeK = levelChangeCalendarMonths(payrolls, 1, 'priorPayrollChangeK', 1);

  // ICSA and CCSA are weekly person counts. Normalize once here so downstream
  // model code always receives the units its contract declares.
  const initialClaimsK = initialClaimsLatest.value / 1_000;
  const continuingClaimsM = continuingClaimsLatest.value / 1_000_000;

  return Object.freeze({
    id: `employment-features:${capturedAt}`,
    capturedAt,
    features: Object.freeze({
      unemploymentRate: unemploymentLatest.value,
      priorUnemploymentRate: unemploymentPrior.value,
      payrollChangeK,
      priorPayrollChangeK,
      initialClaimsK,
      continuingClaimsM
    }),
    observations: Object.freeze({
      unemploymentDate: unemploymentLatest.date,
      payrollDate: payrollLatest.date,
      initialClaimsDate: initialClaimsLatest.date,
      continuingClaimsDate: continuingClaimsLatest.date
    }),
    provenance: Object.freeze([
      { provider: unemployment.provider ?? 'unknown', seriesId: unemployment.seriesId ?? null, transform: 'level-and-calendar-1m-change', role: 'unemployment' },
      { provider: payrolls.provider ?? 'unknown', seriesId: payrolls.seriesId ?? null, transform: 'calendar-1m-level-change', role: 'payroll-momentum' },
      { provider: initialClaims.provider ?? 'unknown', seriesId: initialClaims.seriesId ?? null, transform: 'persons-to-thousands', role: 'initial-claims' },
      { provider: continuingClaims.provider ?? 'unknown', seriesId: continuingClaims.seriesId ?? null, transform: 'persons-to-millions', role: 'continuing-claims' }
    ])
  });
}
