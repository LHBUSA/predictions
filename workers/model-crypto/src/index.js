import { fail, forecastEnvelope, ok, requireFields } from '../../_shared/contract.js';
import { CRYPTO_MODEL, probabilityCryptoAbove, probabilityCryptoBelow } from '../../../src/models/crypto-v0.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['event', 'features']);
      requireFields(body.event, ['id', 'threshold', 'horizonDays']);
      const direction = body.event.direction || 'above';
      const result = direction === 'below'
        ? probabilityCryptoBelow(body.features, body.event.threshold, body.event.horizonDays, body.config)
        : direction === 'above'
          ? probabilityCryptoAbove(body.features, body.event.threshold, body.event.horizonDays, body.config)
          : null;
      if (!result) return fail('UNSUPPORTED_EVENT', `Crypto direction ${direction} is not supported`, 422);
      const capturedAt = body.capturedAt || new Date().toISOString();
      return ok(forecastEnvelope({
        eventId: body.event.id,
        modelId: CRYPTO_MODEL.id,
        modelVersion: CRYPTO_MODEL.version,
        probability: result.probability,
        capturedAt,
        featureSnapshotId: body.featureSnapshotId || null,
        provenance: body.provenance || [],
        explanation: result.explanation,
        metadata: {
          modelStatus: CRYPTO_MODEL.status,
          eventType: body.event.eventType || 'crypto',
          asset: body.event.asset || null,
          direction,
          horizonDays: body.event.horizonDays,
          distribution: 'lognormal-diffusion-baseline'
        }
      }));
    } catch (error) {
      return fail('INVALID_FORECAST_REQUEST', error.message, 422);
    }
  }
};
