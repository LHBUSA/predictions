const DEFAULT_BASE_URL = 'https://propdata-api-worker.sales-fd3.workers.dev';

function locationParams(location = {}) {
  const entries = ['zip', 'state', 'metro']
    .filter(key => location[key] !== undefined && location[key] !== null && location[key] !== '')
    .map(key => [key, String(location[key])]);
  if (entries.length !== 1) throw new TypeError('exactly one of zip, state, or metro is required');
  if (entries[0][0] === 'zip' && !/^\d{5}$/.test(entries[0][1])) throw new TypeError('zip must be 5 digits');
  if (entries[0][0] === 'state' && !/^[A-Za-z]{2}$/.test(entries[0][1])) throw new TypeError('state must be a 2-letter code');
  return entries[0];
}

export class PropDataAdapter {
  constructor({ apiKey, fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, timeoutMs = 10000 } = {}) {
    if (!apiKey) throw new TypeError('PropData apiKey is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async market(location) {
    const [key, value] = locationParams(location);
    const url = new URL(`${this.baseUrl}/v1/market`);
    url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'x-api-key': this.apiKey },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`PropData market request failed: ${response.status}`);
      const payload = await response.json();
      return Object.freeze({
        provider: 'propdata',
        route: '/v1/market',
        location: Object.freeze({ [key]: value }),
        fetchedAt: new Date().toISOString(),
        data: payload
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export { locationParams as normalizePropDataLocation };
