import { CloudflareSourceTransport } from './cloudflare-source.js';

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

function stateCode(value) {
  const state = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw new TypeError('state must be a 2-letter code');
  return state;
}

export class PropDataAdapter {
  constructor({ serviceBinding = null, apiKey, fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, timeoutMs = 10000 } = {}) {
    if (!apiKey) throw new TypeError('PropData apiKey is required');
    this.transport = new CloudflareSourceTransport({
      serviceBinding,
      baseUrl,
      apiKey,
      fetchImpl,
      timeoutMs
    });
  }

  async market(location) {
    const [key, value] = locationParams(location);
    const response = await this.transport.request('/v1/market', { query: { [key]: value } });
    return Object.freeze({
      provider: 'propdata',
      sourceId: `market:${key}:${value}`,
      route: response.route,
      location: Object.freeze({ [key]: value }),
      fetchedAt: response.fetchedAt,
      transport: response.transport,
      data: response.data
    });
  }

  async stateIntel(state) {
    const value = stateCode(state);
    const response = await this.transport.request('/v1/state-intel', { query: { state: value } });
    return Object.freeze({
      provider: 'propdata',
      sourceId: `state-intel:${value}`,
      route: response.route,
      location: Object.freeze({ state: value }),
      fetchedAt: response.fetchedAt,
      transport: response.transport,
      data: response.data
    });
  }
}

export { locationParams as normalizePropDataLocation, stateCode as normalizePropDataState };
