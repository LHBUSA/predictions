import { fail, ok, requireFields } from '../../_shared/contract.js';
import { createHousingFeatureSnapshot } from '../../../src/features/housing.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['id', 'eventId', 'cutoffAt', 'observations']);
      if (!Array.isArray(body.observations)) throw new TypeError('observations must be an array');

      const result = createHousingFeatureSnapshot({
        id: body.id,
        eventId: body.eventId,
        cutoffAt: body.cutoffAt,
        createdAt: body.createdAt,
        observations: body.observations
      });

      return ok(result.snapshot, {
        context: result.context,
        quality: result.quality,
        featureFamily: 'housing'
      });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message)
        ? 'POST_CUTOFF_SOURCE'
        : 'INVALID_FEATURE_REQUEST';
      return fail(code, error.message, 422);
    }
  }
};
