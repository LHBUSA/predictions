import { fail, ok, requireFields } from '../../_shared/contract.js';
import { PropDataHousingHistoryAdapter } from '../../../src/propdata-history.js';
import { createSourceObservation } from '../../../src/source-observation.js';

function adapterFor(env) {
  const url = env.PROPDATA_SUPABASE_URL;
  const serviceKey = env.PROPDATA_SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new TypeError('PROPDATA_SUPABASE_URL and PROPDATA_SUPABASE_SERVICE_KEY are required');
  return new PropDataHousingHistoryAdapter({ url, serviceKey });
}

function toObservation(payload, capturedAt) {
  const availableAt = payload.retrievedByPropDataAt || capturedAt;
  return createSourceObservation({
    provider: payload.provider,
    sourceId: payload.sourceId,
    sourceClass: 'official',
    observedAt: payload.latest.periodEnd,
    availableAt,
    capturedAt,
    value: payload.latest.value,
    data: payload,
    units: 'hpi_index',
    geography: payload.geography,
    vintage: `${payload.latest.year}-Q${payload.latest.quarter}`,
    provenance: {
      normalizationLayer: payload.normalizationLayer,
      dataset: payload.dataset,
      frequency: payload.frequency,
      availabilitySemantics: payload.availabilitySemantics,
      pointInTimeReplaySafeBeforeRetrievedAt: payload.pointInTimeReplaySafeBeforeRetrievedAt,
      note: 'Historical observations are useful for model research, but are not point-in-time replay-safe before PropData retrieval time unless a release vintage was independently retained.'
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['geography']);
      const adapter = adapterFor(env);
      const geography = body.geography || {};
      let payload = null;
      if (geography.state) payload = await adapter.stateHpi(geography.state, { limit: body.limit });
      else if (geography.cbsa) payload = await adapter.metroHpi(geography.cbsa, { limit: body.limit });
      else return fail('INVALID_GEOGRAPHY', 'geography must include state or cbsa', 422);
      if (!payload) return fail('SOURCE_NOT_FOUND', 'No HPI history found for requested geography', 404);
      const capturedAt = new Date().toISOString();
      return ok(toObservation(payload, capturedAt), {
        source: 'PropData housing history',
        historicalResearchSafe: true,
        pointInTimeReplaySafeBeforeRetrievedAt: false
      });
    } catch (error) {
      return fail('SOURCE_FETCH_FAILED', error.message, 422);
    }
  }
};

export { toObservation as housingHistoryToObservation };
