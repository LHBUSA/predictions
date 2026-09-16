const FRED_BASE_URL = 'https://api.stlouisfed.org/fred';

const SERIES = Object.freeze({
  cpi: 'CPIAUCSL',
  unemployment: 'UNRATE',
  federalFundsTargetUpper: 'DFEDTARU',
  federalFundsTargetLower: 'DFEDTARL',
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

  async observations(seriesId, { limit = 24, sortOrder = 'desc', observationStart, observationEnd, outputType = 1 } = {}) {
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

    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`FRED observations request failed: ${response.status}`);
    const payload = await response.json();

    return Object.freeze({
      provider: 'fred',
      seriesId,
      fetchedAt: new Date().toISOString(),
      observations: (payload.observations ?? []).map((row) => Object.freeze({
        date: row.date,
        value: row.value === '.' ? null : Number(row.value),
        realtimeStart: row.realtime_start ?? null,
        realtimeEnd: row.realtime_end ?? null
      }))
    });
  }
}
