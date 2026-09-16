import { fail, ok, requireFields } from '../../_shared/contract.js';
import { CensusIntelligenceAdapter } from '../../../src/census-intelligence.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

function adapterFor(env) {
  const serviceBinding = env.CENSUS_INTEL || null;
  const baseUrl = env.CENSUS_INTEL_BASE_URL || null;
  const apiKey = env.CENSUS_INTEL_KEY || null;
  if (!serviceBinding && !baseUrl) throw new TypeError('CENSUS_INTEL service binding or CENSUS_INTEL_BASE_URL is required');
  return new CensusIntelligenceAdapter({ serviceBinding, baseUrl, apiKey });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['geography']);
      const adapter = adapterFor(env);
      let payload;
      const geography = body.geography || {};

      if (geography.zip) {
        payload = await adapter.zip(geography.zip);
      } else if (geography.fips || (geography.state && geography.county)) {
        payload = await adapter.county({ fips: geography.fips, state: geography.state, county: geography.county });
      } else if (geography.state) {
        payload = await adapter.state(geography.state);
      } else {
        return fail('INVALID_GEOGRAPHY', 'geography must include zip, state, or county/fips', 422);
      }

      const capturedAt = new Date().toISOString();
      const observation = createSourceObservation({
        provider: payload.provider,
        sourceId: payload.sourceId,
        sourceClass: 'official',
        observedAt: body.observedAt || payload.fetchedAt || capturedAt,
        availableAt: payload.fetchedAt || capturedAt,
        capturedAt,
        data: payload.data,
        geography: payload.geography,
        vintage: payload.vintage,
        provenance: {
          route: payload.route,
          transport: payload.transport,
          normalizationLayer: 'PropTechUSA Census Intelligence API',
          underlyingAuthority: payload.underlyingAuthority,
          acsVintage: payload.vintage,
          note: 'ACS is slow-moving structural context; do not treat it as a real-time event trigger.'
        }
      });

      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, { source: 'PropTechUSA Census Intelligence', geography: payload.geography });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message)
        ? 'POST_CUTOFF_SOURCE'
        : /required|must/.test(error.message)
          ? 'INVALID_SOURCE_REQUEST'
          : 'SOURCE_FETCH_FAILED';
      return fail(code, error.message, 422);
    }
  }
};
