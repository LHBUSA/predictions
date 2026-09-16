import { fail, ok, requireFields } from '../../_shared/contract.js';
import { ZillowZoriAdapter } from '../../../src/zillow-zori.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

function revisionFor(payload) {
  return [
    payload.period,
    payload.value,
    payload.priorMonth ?? 'na',
    payload.yearAgo ?? 'na'
  ].join('|');
}

function toObservation(payload) {
  return createSourceObservation({
    provider: payload.provider,
    sourceId: payload.sourceId,
    sourceClass: 'research',
    observedAt: payload.periodEnd,
    availableAt: payload.fetchedAt,
    capturedAt: payload.fetchedAt,
    value: payload.value,
    data: payload,
    units: 'usd_monthly_rent_index',
    geography: payload.geography,
    vintage: payload.period,
    revision: revisionFor(payload),
    provenance: {
      sourceUrl: payload.sourceUrl,
      dataset: payload.dataset,
      frequency: payload.frequency,
      availabilityPrecision: 'capture-time',
      revisionIdentity: 'period|value|priorMonth|yearAgo',
      note: 'Zillow Research does not provide a release timestamp in the CSV. Predictions treats the data as available only from its actual first successful capture forward; deterministic revision identity prevents repeated unchanged captures from creating duplicate ledger rows.'
    }
  });
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      const adapter = new ZillowZoriAdapter();

      if (body.bulk === 'states' || body.bulk === 'metros') {
        const payloads = body.bulk === 'states'
          ? await adapter.states(Array.isArray(body.states) ? body.states : undefined)
          : await adapter.metros();
        const observations = payloads.map(toObservation);
        return ok(observations, {
          source: 'Zillow Research ZORI',
          scope: `${body.bulk === 'states' ? 'state' : 'metro'}_bulk`,
          count: observations.length,
          deterministicRevisionIdentity: true
        });
      }

      requireFields(body, ['geography']);
      const geography = body.geography || {};
      let payload = null;
      if (geography.state) payload = await adapter.state(geography.state);
      else if (geography.metro || geography.regionId) payload = await adapter.metro(geography.metro, geography.regionId || null);
      else return fail('INVALID_GEOGRAPHY', 'ZORI v1 supports state or metro geography', 422);
      if (!payload) return fail('SOURCE_NOT_FOUND', 'No Zillow ZORI row matched requested geography', 404);
      const observation = toObservation(payload);
      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, {
        source: 'Zillow Research ZORI',
        scope: payload.scope,
        vintage: payload.period,
        pointInTimeFromCaptureForward: true,
        deterministicRevisionIdentity: true
      });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message)
        ? 'POST_CUTOFF_SOURCE'
        : /required|unsupported|supports/.test(error.message)
          ? 'INVALID_SOURCE_REQUEST'
          : 'SOURCE_FETCH_FAILED';
      return fail(code, error.message, 422);
    }
  }
};

export { toObservation as zoriToObservation, revisionFor as zoriRevisionFor };
