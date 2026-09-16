import { fail, ok, requireFields } from '../../_shared/contract.js';
import { FredAdapter } from '../../../src/fred.js';
import { KalshiPublicAdapter } from '../../../src/kalshi.js';
import { replayFomcDecision } from '../../../src/replay/fomc-history.js';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    if (!env.FRED_API_KEY) return fail('SOURCE_NOT_CONFIGURED', 'FRED_API_KEY is not configured', 503);

    try {
      const body = await request.json();
      requireFields(body, ['decision']);
      const family = body.family || 'fomc_decision';
      if (family !== 'fomc_decision') {
        return fail('UNSUPPORTED_REPLAY_FAMILY', `Unsupported replay family ${family}`, 422);
      }

      const fredAdapter = new FredAdapter({ apiKey: env.FRED_API_KEY });
      const kalshiAdapter = body.includeKalshiHistory === false ? null : new KalshiPublicAdapter();
      const result = await replayFomcDecision({
        fredAdapter,
        kalshiAdapter,
        decision: body.decision,
        cutoffAt: body.cutoffAt || null,
        config: body.config || {}
      });

      return ok(result, {
        recordType: result.recordType,
        replayVersion: result.replayVersion,
        marketComparisonStatus: result.marketComparison?.status ?? 'not_requested',
        warning: 'Retrospective replay is research history, not a contemporaneously published forecast.'
      });
    } catch (error) {
      return fail('REPLAY_FAILED', error.message, 422);
    }
  }
};
