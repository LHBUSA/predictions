import { fail, forecastEnvelope, ok, requireFields } from '../../_shared/contract.js';
import { EMPLOYMENT_MODEL, probabilityPayrollsAbove, probabilityUnemploymentAbove } from '../../../src/models/employment-v0.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['event', 'features']);
      requireFields(body.event, ['id', 'threshold']);
      const capturedAt = body.capturedAt || new Date().toISOString();
      const kind = body.event.metric || body.event.eventType || 'unemployment';
      const result = kind === 'payrolls' || kind === 'payroll_change'
        ? probabilityPayrollsAbove(body.features, body.event.threshold, body.config)
        : probabilityUnemploymentAbove(body.features, body.event.threshold, body.config);

      return ok(forecastEnvelope({
        eventId: body.event.id,
        modelId: EMPLOYMENT_MODEL.id,
        modelVersion: EMPLOYMENT_MODEL.version,
        probability: result.probability,
        capturedAt,
        featureSnapshotId: body.featureSnapshotId || null,
        provenance: body.provenance || [],
        explanation: result.explanation,
        metadata: { modelStatus: EMPLOYMENT_MODEL.status, metric: kind }
      }));
    } catch (error) {
      return fail('INVALID_FORECAST_REQUEST', error.message, 422);
    }
  }
};
