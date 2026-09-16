import { fail, ok, requireFields } from '../../_shared/contract.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['provider', 'sourceId', 'sourceClass']);
      const observation = createSourceObservation({
        provider: body.provider,
        sourceId: body.sourceId,
        sourceClass: body.sourceClass,
        observedAt: body.observedAt,
        availableAt: body.availableAt,
        capturedAt: body.capturedAt || new Date().toISOString(),
        value: body.value ?? null,
        data: body.data ?? null,
        units: body.units ?? null,
        geography: body.geography ?? null,
        vintage: body.vintage ?? null,
        revision: body.revision ?? null,
        provenance: body.provenance || {}
      });
      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, {
        pointInTimeSafeForCutoff: Boolean(body.forecastCutoff),
        retentionPolicy: 'append-only'
      });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message) ? 'POST_CUTOFF_SOURCE' : 'INVALID_SOURCE_OBSERVATION';
      return fail(code, error.message, 422);
    }
  }
};
