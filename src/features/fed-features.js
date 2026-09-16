function latestValue(series, field) {
  const observations = series?.observations ?? [];
  const row = observations.find((item) => item?.value !== null && item?.value !== undefined && Number.isFinite(Number(item.value)));
  if (!row) throw new Error(`missing usable observation for ${field}`);
  return { value: Number(row.value), date: row.date ?? null };
}

function changeFromNewest(series, periods, field) {
  const observations = (series?.observations ?? [])
    .filter((item) => item?.value !== null && item?.value !== undefined && Number.isFinite(Number(item.value)));
  if (observations.length <= periods) throw new Error(`insufficient history for ${field}`);
  return Number(observations[0].value) - Number(observations[periods].value);
}

export function buildFedFeatureSnapshot({ coreInflation, headlineInflation, unemployment, capturedAt = new Date().toISOString() }) {
  const core = latestValue(coreInflation, 'coreInflation');
  const headline = latestValue(headlineInflation, 'headlineInflation');
  const jobless = latestValue(unemployment, 'unemployment');

  return Object.freeze({
    id: `fed-features:${capturedAt}`,
    capturedAt,
    features: Object.freeze({
      coreInflationYoY: core.value,
      headlineInflationYoY: headline.value,
      unemploymentRate: jobless.value,
      unemploymentChange3m: changeFromNewest(unemployment, 3, 'unemploymentChange3m')
    }),
    observations: Object.freeze({
      coreInflationDate: core.date,
      headlineInflationDate: headline.date,
      unemploymentDate: jobless.date
    }),
    provenance: Object.freeze([
      { provider: coreInflation.provider ?? 'unknown', seriesId: coreInflation.seriesId ?? null },
      { provider: headlineInflation.provider ?? 'unknown', seriesId: headlineInflation.seriesId ?? null },
      { provider: unemployment.provider ?? 'unknown', seriesId: unemployment.seriesId ?? null }
    ])
  });
}
