import { fail, ok, requireFields } from '../../_shared/contract.js';
import { CensusBpsAdapter } from '../../../src/census-bps.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

function toObservation(payload) {
  return createSourceObservation({
    provider: payload.provider,
    sourceId: payload.sourceId,
    sourceClass: 'official',
    observedAt: payload.periodEnd,
    availableAt: payload.fetchedAt,
    capturedAt: payload.fetchedAt,
    value: payload.value,
    data: payload,
    units: 'authorized_housing_units',
    geography: payload.geography,
    vintage: payload.period,
    provenance: {
      sourceUrl: payload.sourceUrl,
      dataset: payload.dataset,
      metric: payload.metric,
      frequency: payload.frequency,
      availabilitySemantics: payload.availabilitySemantics,
      availabilityPrecision: 'capture-time',
      note: 'The worker probes for the newest Census BPS month that is actually published. Predictions does not backdate the current API response to the historical release date; point-in-time safety begins at this capture.'
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    if (!env.CENSUS_API_KEY) return fail('SOURCE_NOT_CONFIGURED', 'CENSUS_API_KEY is not configured', 503);
    try {
      const body = await request.json();
      requireFields(body, ['geography']);
      const geography = body.geography || {};
      const adapter = new CensusBpsAdapter({ apiKey: env.CENSUS_API_KEY });
      const payload = await adapter.latest(geography, { maxProbeMonths: body.maxProbeMonths || 5 });
      if (!payload) return fail('SOURCE_NOT_FOUND', 'No published Census BPS month found for requested geography', 404);
      const observation = toObservation(payload);
      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, {
        source: 'U.S. Census Bureau Building Permits Survey',
        vintage: payload.period,
        pointInTimeFromCaptureForward: true,
        yoyAvailable: payload.yoyPct !== null
      });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message)
        ? 'POST_CUTOFF_SOURCE'
        : /required|must|supported/.test(error.message)
          ? 'INVALID_SOURCE_REQUEST'
          : 'SOURCE_FETCH_FAILED';
      return fail(code, error.message, 422);
    }
  }
};

export { toObservation as permitsToObservation };
