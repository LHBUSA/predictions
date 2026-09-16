import { fail, ok, requireFields } from '../../_shared/contract.js';
import { PropDataAdapter } from '../../../src/propdata.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    if (!env.PROPDATA_API_KEY) return fail('SOURCE_NOT_CONFIGURED', 'PROPDATA_API_KEY is not configured', 503);
    try {
      const body = await request.json();
      const mode = body.mode || 'market';
      const adapter = new PropDataAdapter({
        serviceBinding: env.PROPDATA || null,
        apiKey: env.PROPDATA_API_KEY,
        baseUrl: env.PROPDATA_BASE_URL || undefined
      });

      let payload;
      if (mode === 'market') {
        requireFields(body, ['location']);
        payload = await adapter.market(body.location);
      } else if (mode === 'state_intel') {
        const state = body.state || body.location?.state;
        requireFields({ state }, ['state']);
        payload = await adapter.stateIntel(state);
      } else {
        return fail('UNSUPPORTED_MODE', 'mode must be market or state_intel', 422);
      }

      const capturedAt = payload.fetchedAt;
      const observation = createSourceObservation({
        provider: 'PropData',
        sourceId: payload.sourceId,
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
          mode,
          availabilityPrecision: 'capture-time',
          note: 'For historical replay, use a previously retained PropData snapshot rather than a current API response.'
        }
      });
      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, { source: 'PropData', route: payload.route, transport: payload.transport, mode });
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
