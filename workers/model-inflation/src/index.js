import { fail, forecastEnvelope, ok, requireFields } from '../../_shared/contract.js';
import { INFLATION_MODEL, probabilityAboveInflationThreshold } from '../../../src/models/inflation-v0.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['event', 'features']);
      requireFields(body.event, ['id', 'threshold']);
      const capturedAt = body.capturedAt || new Date().toISOString();
      const result = probabilityAboveInflationThreshold(body.features, body.event.threshold, body.config);
      return ok(forecastEnvelope({
        eventId: body.event.id,
        modelId: INFLATION_MODEL.id,
        modelVersion: INFLATION_MODEL.version,
        probability: result.probability,
        capturedAt,
        featureSnapshotId: body.featureSnapshotId || null,
        provenance: body.provenance || [],
        explanation: result.explanation,
        metadata: { modelStatus: INFLATION_MODEL.status, eventType: body.event.eventType || 'cpi_release' }
      }));
    } catch (error) {
      return fail('INVALID_FORECAST_REQUEST', error.message, 422);
    }
  }
};
