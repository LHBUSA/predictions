import { fail, forecastEnvelope, ok, requireFields } from '../../_shared/contract.js';
import { GDP_MODEL, probabilityGdpAbove } from '../../../src/models/gdp-v0.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['event', 'features']);
      requireFields(body.event, ['id', 'threshold']);
      const direction = body.event.direction || 'above';
      if (direction !== 'above') return fail('UNSUPPORTED_EVENT', `GDP direction ${direction} is not supported by v0.1`, 422);
      const capturedAt = body.capturedAt || new Date().toISOString();
      const result = probabilityGdpAbove(body.features, body.event.threshold, body.config);
      return ok(forecastEnvelope({
        eventId: body.event.id,
        modelId: GDP_MODEL.id,
        modelVersion: GDP_MODEL.version,
        probability: result.probability,
        capturedAt,
        featureSnapshotId: body.featureSnapshotId || null,
        provenance: body.provenance || [],
        explanation: result.explanation,
        metadata: {
          modelStatus: GDP_MODEL.status,
          eventType: body.event.eventType || 'gdp',
          distributionMean: result.mean,
          distributionSigma: result.sigma,
          unit: 'annualized-percent'
        }
      }));
    } catch (error) {
      return fail('INVALID_FORECAST_REQUEST', error.message, 422);
    }
  }
};
