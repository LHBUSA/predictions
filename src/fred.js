const FRED_BASE_URL = 'https://api.stlouisfed.org/fred';

const SERIES = Object.freeze({
  cpi: 'CPIAUCSL',
  coreCpi: 'CPILFESL',
  cpiNsa: 'CPIAUCNS',
  coreCpiNsa: 'CPILFENS',
  unemployment: 'UNRATE',
  payrolls: 'PAYEMS',
  initialClaims: 'ICSA',
  continuingClaims: 'CCSA',
  industrialProduction: 'INDPRO',
  federalFundsTargetUpper: 'DFEDTARU',
  federalFundsTargetLower: 'DFEDTARL',
  treasury10: 'DGS10',
  mortgage30: 'MORTGAGE30US',
  realGdp: 'GDPC1'
});

export { SERIES as FRED_SERIES };

export class FredAdapter {
  constructor({ apiKey, fetchImpl = globalThis.fetch, baseUrl = FRED_BASE_URL } = {}) {
    if (!apiKey) throw new TypeError('FRED apiKey is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async observations(seriesId, {
    limit = 24,
    sortOrder = 'desc',
    observationStart,
    observationEnd,
    realtimeStart,
    realtimeEnd,
    vintageDates,
    units,
    outputType = 1
  } = {}) {
    if (!seriesId) throw new TypeError('seriesId is required');
    const url = new URL(`${this.baseUrl}/series/observations`);
    url.searchParams.set('series_id', seriesId);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sort_order', sortOrder);
    url.searchParams.set('output_type', String(outputType));
    if (observationStart) url.searchParams.set('observation_start', observationStart);
    if (observationEnd) url.searchParams.set('observation_end', observationEnd);
    if (realtimeStart) url.searchParams.set('realtime_start', realtimeStart);
    if (realtimeEnd) url.searchParams.set('realtime_end', realtimeEnd);
    if (vintageDates) url.searchParams.set('vintage_dates', Array.isArray(vintageDates) ? vintageDates.join(',') : String(vintageDates));
    if (units) url.searchParams.set('units', units);

    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`FRED observations request failed: ${response.status}`);
    const payload = await response.json();

    return Object.freeze({
      provider: 'fred',
      seriesId,
      fetchedAt: new Date().toISOString(),
      realtimeStart: payload.realtime_start ?? realtimeStart ?? null,
      realtimeEnd: payload.realtime_end ?? realtimeEnd ?? null,
      observations: (payload.observations ?? []).map((row) => Object.freeze({
        date: row.date,
        value: row.value === '.' ? null : Number(row.value),
        realtimeStart: row.realtime_start ?? null,
        realtimeEnd: row.realtime_end ?? null
      }))
    });
  }
}
