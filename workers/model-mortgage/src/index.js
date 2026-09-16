import { fail, forecastEnvelope, ok, requireFields } from '../../_shared/contract.js';
import { MORTGAGE_MODEL, probabilityMortgageAbove, probabilityMortgageBelow } from '../../../src/models/mortgage-v0.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['event', 'features']);
      requireFields(body.event, ['id', 'threshold']);
      const direction = body.event.direction || 'above';
      const result = direction === 'below'
        ? probabilityMortgageBelow(body.features, body.event.threshold, body.config)
        : direction === 'above'
          ? probabilityMortgageAbove(body.features, body.event.threshold, body.config)
          : null;
      if (!result) return fail('UNSUPPORTED_EVENT', `Mortgage direction ${direction} is not supported`, 422);
      const capturedAt = body.capturedAt || new Date().toISOString();
      return ok(forecastEnvelope({
        eventId: body.event.id,
        modelId: MORTGAGE_MODEL.id,
        modelVersion: MORTGAGE_MODEL.version,
        probability: result.probability,
        capturedAt,
        featureSnapshotId: body.featureSnapshotId || null,
        provenance: body.provenance || [],
        explanation: result.explanation,
        metadata: {
          modelStatus: MORTGAGE_MODEL.status,
          eventType: body.event.eventType || 'mortgage',
          direction,
          distributionMean: result.mean,
          distributionSigma: result.sigma,
          unit: 'percent'
        }
      }));
    } catch (error) {
      return fail('INVALID_FORECAST_REQUEST', error.message, 422);
    }
  }
};
