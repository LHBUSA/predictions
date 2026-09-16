import { CloudflareSourceTransport } from './cloudflare-source.js';

function normalizeEin(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length !== 9) throw new TypeError('ein must contain exactly 9 digits');
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

export class BusinessIntelligenceAdapter {
  constructor({ serviceBinding = null, baseUrl = null, apiKey = null, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.transport = new CloudflareSourceTransport({ serviceBinding, baseUrl, apiKey, fetchImpl, timeoutMs });
  }

  async lookup(ein) {
    const normalized = normalizeEin(ein);
    const response = await this.transport.request('/v1/business', { query: { ein: normalized } });
    return Object.freeze({
      provider: 'PropTechUSA Business Intelligence',
      sourceId: `ein:${normalized.replace(/\D/g, '')}`,
      route: response.route,
      fetchedAt: response.fetchedAt,
      transport: response.transport,
      data: response.data,
      upstreamSources: Object.freeze([...(response.data?.data_sources || [])])
    });
  }

  async search(name, state = null) {
    const query = String(name ?? '').trim();
    if (query.length < 2) throw new TypeError('business name must contain at least 2 characters');
    if (state !== null && state !== undefined && !/^[A-Za-z]{2}$/.test(String(state))) {
      throw new TypeError('state must be a 2-letter code');
    }
    const response = await this.transport.request('/v1/business/search', {
      query: { name: query, state: state ? String(state).toUpperCase() : null }
    });
    return Object.freeze({
      provider: 'PropTechUSA Business Intelligence',
      sourceId: `search:${query.toLowerCase()}:${state ? String(state).toUpperCase() : 'US'}`,
      route: response.route,
      fetchedAt: response.fetchedAt,
      transport: response.transport,
      data: response.data
    });
  }
}

export { normalizeEin as normalizeBusinessEin };
