import { fail, ok, requireFields } from '../../_shared/contract.js';
import { FredAdapter } from '../../../src/fred.js';
import { KalshiPublicAdapter } from '../../../src/kalshi.js';
import { replayFomcDecision } from '../../../src/replay/fomc-history.js';
import { replayCpiRelease } from '../../../src/replay/cpi-history.js';
import { replayPayrollRelease } from '../../../src/replay/payroll-history.js';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    if (!env.FRED_API_KEY) return fail('SOURCE_NOT_CONFIGURED', 'FRED_API_KEY is not configured', 503);

    try {
      const body = await request.json();
      const family = body.family || 'fomc_decision';
      const fredAdapter = new FredAdapter({ apiKey: env.FRED_API_KEY });
      const kalshiAdapter = body.includeKalshiHistory === false ? null : new KalshiPublicAdapter();

      let result;
      if (family === 'fomc_decision') {
        requireFields(body, ['decision']);
        result = await replayFomcDecision({
          fredAdapter,
          kalshiAdapter,
          decision: body.decision,
          cutoffAt: body.cutoffAt || null,
          config: body.config || {}
        });
      } else if (family === 'cpi_yoy_thresholds') {
        requireFields(body, ['release']);
        result = await replayCpiRelease({
          fredAdapter,
          kalshiAdapter,
          release: body.release,
          cutoffAt: body.cutoffAt || null,
          config: body.config || {}
        });
      } else if (family === 'payroll_thresholds') {
        requireFields(body, ['release']);
        result = await replayPayrollRelease({
          fredAdapter,
          kalshiAdapter,
          release: body.release,
          cutoffAt: body.cutoffAt || null,
          config: body.config || {}
        });
      } else {
        return fail('UNSUPPORTED_REPLAY_FAMILY', `Unsupported replay family ${family}`, 422);
      }

      return ok(result, {
        family,
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
