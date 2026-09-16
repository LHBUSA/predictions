import { CloudflareSourceTransport } from './cloudflare-source.js';

function normalizeZip(raw) {
  const value = String(raw ?? '').replace(/\D/g, '').slice(0, 5);
  if (!/^\d{5}$/.test(value)) throw new TypeError('zip must be 5 digits');
  return value;
}

function normalizeState(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) throw new TypeError('state must be a 2-letter code');
  return value;
}

export class CensusIntelligenceAdapter {
  constructor({ serviceBinding = null, baseUrl = null, apiKey = null, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.transport = new CloudflareSourceTransport({ serviceBinding, baseUrl, apiKey, fetchImpl, timeoutMs });
  }

  async zip(zip) {
    const value = normalizeZip(zip);
    const response = await this.transport.request('/v1/census', { query: { zip: value } });
    return Object.freeze({
      provider: 'PropTechUSA Census Intelligence',
      sourceId: `acs:zcta:${value}`,
      route: response.route,
      fetchedAt: response.fetchedAt,
      transport: response.transport,
      geography: Object.freeze({ zip: value }),
      data: response.data,
      vintage: response.data?.acs_survey?.acs_vintage || response.data?.data_year || null,
      underlyingAuthority: response.data?.data_source || 'US Census Bureau ACS 5-Year Estimates'
    });
  }

  async state(state) {
    const value = normalizeState(state);
    const response = await this.transport.request('/v1/census/state', { query: { state: value } });
    return Object.freeze({
      provider: 'PropTechUSA Census Intelligence',
      sourceId: `acs:state:${value}`,
      route: response.route,
      fetchedAt: response.fetchedAt,
      transport: response.transport,
      geography: Object.freeze({ state: value }),
      data: response.data,
      vintage: response.data?.acs_survey?.acs_vintage || response.data?.data_year || null,
      underlyingAuthority: response.data?.data_source || 'US Census Bureau ACS 5-Year Estimates'
    });
  }

  async county({ state = null, county = null, fips = null } = {}) {
    const query = {};
    if (fips) {
      const value = String(fips).replace(/\D/g, '');
      if (!/^\d{5}$/.test(value)) throw new TypeError('fips must be a 5-digit county FIPS code');
      query.fips = value;
    } else {
      query.state = normalizeState(state);
      const countyName = String(county ?? '').trim();
      if (!countyName) throw new TypeError('county is required when fips is not supplied');
      query.county = countyName;
    }
    const response = await this.transport.request('/v1/census/county', { query });
    return Object.freeze({
      provider: 'PropTechUSA Census Intelligence',
      sourceId: query.fips ? `acs:county:${query.fips}` : `acs:county:${query.state}:${query.county.toLowerCase()}`,
      route: response.route,
      fetchedAt: response.fetchedAt,
      transport: response.transport,
      geography: Object.freeze({ ...query }),
      data: response.data,
      vintage: response.data?.acs_survey?.acs_vintage || response.data?.data_year || null,
      underlyingAuthority: response.data?.data_source || 'US Census Bureau ACS 5-Year Estimates'
    });
  }
}

export { normalizeZip as normalizeCensusZip, normalizeState as normalizeCensusState };
