function usableObservations(series) {
  return (series?.observations ?? [])
    .filter((item) => item?.value !== null && item?.value !== undefined && Number.isFinite(Number(item.value)))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

function latestValue(series, field) {
  const observations = usableObservations(series);
  const row = observations[0];
  if (!row) throw new Error(`missing usable observation for ${field}`);
  return { value: Number(row.value), date: row.date ?? null };
}

function changeFromNewest(series, periods, field) {
  const observations = usableObservations(series);
  if (observations.length <= periods) throw new Error(`insufficient history for ${field}`);
  return Number(observations[0].value) - Number(observations[periods].value);
}

function percentChangeFromNewest(series, periods, field) {
  const observations = usableObservations(series);
  if (observations.length <= periods) throw new Error(`insufficient history for ${field}`);
  const newest = Number(observations[0].value);
  const prior = Number(observations[periods].value);
  if (!Number.isFinite(newest) || !Number.isFinite(prior) || prior === 0) {
    throw new Error(`invalid index history for ${field}`);
  }
  return ((newest / prior) - 1) * 100;
}

export function buildFedFeatureSnapshot({ coreInflation, headlineInflation, unemployment, capturedAt = new Date().toISOString() }) {
  const coreLatest = latestValue(coreInflation, 'coreInflation');
  const headlineLatest = latestValue(headlineInflation, 'headlineInflation');
  const jobless = latestValue(unemployment, 'unemployment');

  // CPIAUCSL and CPILFESL are price-index levels. The Fed model consumes
  // year-over-year inflation rates, so reconstruct the 12-month percent
  // change from the vintage-visible index observations rather than treating
  // an index level as a percentage.
  const coreInflationYoY = percentChangeFromNewest(coreInflation, 12, 'coreInflationYoY');
  const headlineInflationYoY = percentChangeFromNewest(headlineInflation, 12, 'headlineInflationYoY');

  return Object.freeze({
    id: `fed-features:${capturedAt}`,
    capturedAt,
    features: Object.freeze({
      coreInflationYoY,
      headlineInflationYoY,
      unemploymentRate: jobless.value,
      unemploymentChange3m: changeFromNewest(unemployment, 3, 'unemploymentChange3m')
    }),
    observations: Object.freeze({
      coreInflationDate: coreLatest.date,
      headlineInflationDate: headlineLatest.date,
      unemploymentDate: jobless.date
    }),
    provenance: Object.freeze([
      { provider: coreInflation.provider ?? 'unknown', seriesId: coreInflation.seriesId ?? null, transform: '12m-percent-change' },
      { provider: headlineInflation.provider ?? 'unknown', seriesId: headlineInflation.seriesId ?? null, transform: '12m-percent-change' },
      { provider: unemployment.provider ?? 'unknown', seriesId: unemployment.seriesId ?? null, transform: 'level-and-3m-change' }
    ])
  });
}
