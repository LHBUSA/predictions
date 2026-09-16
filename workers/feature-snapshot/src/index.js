import { fail, ok, requireFields } from '../../_shared/contract.js';
import { createFeatureSnapshot } from '../../../src/feature-snapshot.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['id', 'eventId', 'modelId', 'cutoffAt', 'features']);
      const snapshot = createFeatureSnapshot({
        id: body.id,
        eventId: body.eventId,
        modelId: body.modelId,
        cutoffAt: body.cutoffAt,
        createdAt: body.createdAt || new Date().toISOString(),
        features: body.features,
        observations: body.observations || []
      });
      return ok(snapshot, {
        immutable: true,
        pointInTimeValidated: true,
        sourceClasses: snapshot.sourceClasses
      });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message) ? 'POST_CUTOFF_SOURCE' : 'INVALID_FEATURE_SNAPSHOT';
      return fail(code, error.message, 422);
    }
  }
};
