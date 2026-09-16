import { fail, forecastEnvelope, ok, requireFields } from '../../_shared/contract.js';
import { HOUSING_MODEL, probabilityHomePricesAbove, probabilityHomePricesBelow } from '../../../src/models/housing-v0.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['event', 'features']);
      requireFields(body.event, ['id', 'threshold']);
      const direction = body.event.direction || 'above';
      const result = direction === 'below'
        ? probabilityHomePricesBelow(body.features, body.event.threshold, body.config)
        : direction === 'above'
          ? probabilityHomePricesAbove(body.features, body.event.threshold, body.config)
          : null;
      if (!result) return fail('UNSUPPORTED_EVENT', `Housing direction ${direction} is not supported`, 422);
      const capturedAt = body.capturedAt || new Date().toISOString();
      const sourceClasses = [];
      if (result.features.sourceParticipation.propdata) sourceClasses.push('PropData');
      if (result.features.sourceParticipation.fhfa) sourceClasses.push('Official housing');
      if (body.provenance?.length) sourceClasses.push('Additional declared sources');

      return ok(forecastEnvelope({
        eventId: body.event.id,
        modelId: HOUSING_MODEL.id,
        modelVersion: HOUSING_MODEL.version,
        probability: result.probability,
        capturedAt,
        featureSnapshotId: body.featureSnapshotId || null,
        provenance: body.provenance || [],
        explanation: result.explanation,
        metadata: {
          modelStatus: HOUSING_MODEL.status,
          eventType: body.event.eventType || 'housing',
          direction,
          geography: body.event.geography || null,
          distributionMean: result.mean,
          distributionSigma: result.sigma,
          sourceClasses
        }
      }));
    } catch (error) {
      return fail('INVALID_FORECAST_REQUEST', error.message, 422);
    }
  }
};
