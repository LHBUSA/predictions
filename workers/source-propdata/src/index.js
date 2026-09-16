import { fail, ok, requireFields } from '../../_shared/contract.js';
import { PropDataAdapter } from '../../../src/propdata.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    if (!env.PROPDATA_API_KEY) return fail('SOURCE_NOT_CONFIGURED', 'PROPDATA_API_KEY is not configured', 503);
    try {
      const body = await request.json();
      requireFields(body, ['location']);
      const adapter = new PropDataAdapter({
        serviceBinding: env.PROPDATA || null,
        apiKey: env.PROPDATA_API_KEY,
        baseUrl: env.PROPDATA_BASE_URL || undefined
      });
      const payload = await adapter.market(body.location);
      const capturedAt = payload.fetchedAt;
      const locationEntry = Object.entries(payload.location)[0];
      const observation = createSourceObservation({
        provider: 'PropData',
        sourceId: `market:${locationEntry[0]}:${locationEntry[1]}`,
        sourceClass: 'propdata',
        observedAt: body.observedAt || capturedAt,
        availableAt: capturedAt,
        capturedAt,
        data: payload.data,
        geography: payload.location,
        vintage: capturedAt,
        provenance: {
          route: payload.route,
          location: payload.location,
          transport: payload.transport,
          availabilityPrecision: 'capture-time',
          note: 'For historical replay, use a previously retained PropData snapshot rather than a current API response.'
        }
      });
      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, { source: 'PropData', route: payload.route, transport: payload.transport });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message) ? 'POST_CUTOFF_SOURCE' : 'SOURCE_FETCH_FAILED';
      return fail(code, error.message, 422);
    }
  }
};
