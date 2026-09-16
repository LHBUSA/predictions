import { fail } from '../../_shared/contract.js';

export default {
  async fetch(request) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    return fail(
      'MODEL_NOT_READY',
      'Company prediction models are not yet calibrated for production or research forecasting.',
      503,
      {
        modelFamily: 'companies',
        availableSourceContext: [
          'PropTechUSA Business Intelligence identity/classification',
          'SEC/EDGAR discovery context'
        ],
        requiredBeforeForecasting: [
          'event-specific company contract taxonomy',
          'point-in-time filing and earnings observations',
          'financial estimate/revision features where licensed and available',
          'historical outcomes and calibration set'
        ],
        policy: 'identity metadata alone must never produce a probability'
      }
    );
  }
};
