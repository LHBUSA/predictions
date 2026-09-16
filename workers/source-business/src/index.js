import { fail, ok, requireFields } from '../../_shared/contract.js';
import { BusinessIntelligenceAdapter } from '../../../src/business-intelligence.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

function adapterFor(env) {
  const serviceBinding = env.BUSINESS_INTEL || null;
  const baseUrl = env.BUSINESS_INTEL_BASE_URL || null;
  const apiKey = env.BUSINESS_INTEL_KEY || null;
  if (!serviceBinding && !baseUrl) throw new TypeError('BUSINESS_INTEL service binding or BUSINESS_INTEL_BASE_URL is required');
  if (!apiKey) throw new TypeError('BUSINESS_INTEL_KEY is required');
  return new BusinessIntelligenceAdapter({ serviceBinding, baseUrl, apiKey });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['mode']);
      const adapter = adapterFor(env);
      const capturedAt = new Date().toISOString();
      let payload;
      let sourceId;

      if (body.mode === 'ein') {
        requireFields(body, ['ein']);
        payload = await adapter.lookup(body.ein);
        sourceId = payload.sourceId;
      } else if (body.mode === 'search') {
        requireFields(body, ['name']);
        payload = await adapter.search(body.name, body.state || null);
        sourceId = payload.sourceId;
      } else {
        return fail('UNSUPPORTED_MODE', 'mode must be ein or search', 422);
      }

      const observation = createSourceObservation({
        provider: payload.provider,
        sourceId,
        sourceClass: 'proprietary',
        observedAt: body.observedAt || payload.fetchedAt || capturedAt,
        availableAt: payload.fetchedAt || capturedAt,
        capturedAt,
        data: payload.data,
        geography: body.state ? { state: String(body.state).toUpperCase() } : null,
        vintage: payload.fetchedAt || capturedAt,
        provenance: {
          route: payload.route,
          transport: payload.transport,
          upstreamSources: payload.upstreamSources || payload.data?.data_sources || [],
          normalizationLayer: 'PropTechUSA Business Intelligence API',
          note: 'Company identity and classification data is source context, not a standalone earnings forecast signal.'
        }
      });

      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, { source: 'PropTechUSA Business Intelligence', mode: body.mode });
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
