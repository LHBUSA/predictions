import { fail, ok, requireFields } from '../../_shared/contract.js';
import { PropDataHousingHistoryAdapter } from '../../../src/propdata-history.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

function adapterFor(env) {
  const url = env.PROPDATA_SUPABASE_URL;
  const serviceKey = env.PROPDATA_SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) throw new TypeError('PROPDATA_SUPABASE_URL and PROPDATA_SUPABASE_SERVICE_KEY are required');
  return new PropDataHousingHistoryAdapter({ url, serviceKey });
}

function toObservation(payload, ingestedAt = new Date().toISOString()) {
  const upstreamCapturedAt = payload.retrievedByPropDataAt || ingestedAt;
  return createSourceObservation({
    provider: payload.provider,
    sourceId: payload.sourceId,
    sourceClass: 'official',
    observedAt: payload.latest.periodEnd,
    availableAt: upstreamCapturedAt,
    capturedAt: upstreamCapturedAt,
    value: payload.latest.value,
    data: {
      ...payload,
      predictionsIngestedAt: ingestedAt
    },
    units: 'hpi_index',
    geography: payload.geography,
    vintage: `${payload.latest.year}-Q${payload.latest.quarter}`,
    provenance: {
      normalizationLayer: payload.normalizationLayer,
      dataset: payload.dataset,
      frequency: payload.frequency,
      availabilitySemantics: payload.availabilitySemantics,
      pointInTimeReplaySafeBeforeRetrievedAt: payload.pointInTimeReplaySafeBeforeRetrievedAt,
      predictionsIngestedAt: ingestedAt,
      note: 'Historical observations are useful for model research, but are not point-in-time replay-safe before PropData retrieval time unless a release vintage was independently retained. capturedAt is pinned to the upstream PropData retrieval time so repeated collectors are idempotent; ledger inserted_at records Predictions ingestion time.'
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      const adapter = adapterFor(env);

      if (body.bulk === 'states' || body.bulk === 'metros') {
        const payloads = body.bulk === 'states'
          ? await adapter.stateSnapshots({ quarters: body.quarters || 5 })
          : await adapter.metroSnapshots({
            quarters: body.quarters || 5,
            pageSize: body.pageSize || 1000,
            maxPages: body.maxPages || 6
          });
        const ingestedAt = new Date().toISOString();
        const observations = payloads.map((payload) => toObservation(payload, ingestedAt));
        return ok(observations, {
          source: 'PropData housing history',
          scope: `${body.bulk === 'states' ? 'state' : 'metro'}_hpi_bulk`,
          count: observations.length,
          idempotentByUpstreamCapture: true
        });
      }

      requireFields(body, ['geography']);
      const geography = body.geography || {};
      let payload = null;
      if (geography.state) payload = await adapter.stateHpi(geography.state, { limit: body.limit });
      else if (geography.cbsa) payload = await adapter.metroHpi(geography.cbsa, { limit: body.limit });
      else return fail('INVALID_GEOGRAPHY', 'geography must include state or cbsa', 422);
      if (!payload) return fail('SOURCE_NOT_FOUND', 'No HPI history found for requested geography', 404);
      const observation = toObservation(payload, new Date().toISOString());
      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, {
        source: 'PropData housing history',
        historicalResearchSafe: true,
        pointInTimeReplaySafeBeforeRetrievedAt: false,
        idempotentByUpstreamCapture: true
      });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message) ? 'POST_CUTOFF_SOURCE' : 'SOURCE_FETCH_FAILED';
      return fail(code, error.message, 422);
    }
  }
};

export { toObservation as housingHistoryToObservation };
