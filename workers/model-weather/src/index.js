import { fail, forecastEnvelope, ok, requireFields } from '../../_shared/contract.js';
import { WEATHER_MODEL, probabilityWeatherAbove, probabilityWeatherBelow } from '../../../src/models/weather-v0.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['event', 'features']);
      requireFields(body.event, ['id', 'threshold', 'metric']);
      if (body.event.metric !== 'temperature') {
        return fail('UNSUPPORTED_EVENT', `Weather metric ${body.event.metric} requires its own specialist model`, 422);
      }
      const direction = body.event.direction || 'above';
      const result = direction === 'below'
        ? probabilityWeatherBelow(body.features, body.event.threshold)
        : direction === 'above'
          ? probabilityWeatherAbove(body.features, body.event.threshold)
          : null;
      if (!result) return fail('UNSUPPORTED_EVENT', `Weather direction ${direction} is not supported`, 422);
      const capturedAt = body.capturedAt || new Date().toISOString();
      return ok(forecastEnvelope({
        eventId: body.event.id,
        modelId: WEATHER_MODEL.id,
        modelVersion: WEATHER_MODEL.version,
        probability: result.probability,
        capturedAt,
        featureSnapshotId: body.featureSnapshotId || null,
        provenance: body.provenance || [],
        explanation: result.explanation,
        metadata: {
          modelStatus: WEATHER_MODEL.status,
          eventType: body.event.eventType || 'weather',
          metric: body.event.metric,
          direction,
          units: body.event.units || null,
          geography: body.event.geography || null,
          distributionMean: result.mean,
          distributionSigma: result.sigma
        }
      }));
    } catch (error) {
      return fail('INVALID_FORECAST_REQUEST', error.message, 422);
    }
  }
};
