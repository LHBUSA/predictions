import { FRED_SERIES } from '../fred.js';
import { buildFedFeatureSnapshot } from '../features/fed-features.js';
import { FED_DECISION_MODEL, fedDecisionProbabilities } from '../models/fed-decision-v0.js';
import { classifyRateChangeBps, scoreCategoricalForecast } from '../backtest/fomc.js';
import { buildFomcKalshiMarketComparison } from './kalshi-fomc.js';
import { priorDayCutoff } from './cutoff.js';

export { priorDayCutoff } from './cutoff.js';
export const REPLAY_RECORD_TYPE = 'retrospective_replay';
export const FOMC_REPLAY_VERSION = '0.2.0';

function iso(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return d.toISOString();
}

async function vintageSeries(fredAdapter, seriesId, vintageDate, limit = 24) {
  return fredAdapter.observations(seriesId, {
    limit,
    sortOrder: 'desc',
    observationEnd: vintageDate,
    realtimeStart: vintageDate,
    realtimeEnd: vintageDate,
    outputType: 1
  });
}

export async function reconstructFedFeatures({ fredAdapter, cutoffAt }) {
  if (!fredAdapter?.observations) throw new TypeError('fredAdapter with observations() is required');
  const cutoff = iso(cutoffAt, 'cutoffAt');
  const vintageDate = cutoff.slice(0, 10);

  const [headlineInflation, coreInflation, unemployment] = await Promise.all([
    vintageSeries(fredAdapter, FRED_SERIES.cpi, vintageDate, 24),
    vintageSeries(fredAdapter, FRED_SERIES.coreCpi, vintageDate, 24),
    vintageSeries(fredAdapter, FRED_SERIES.unemployment, vintageDate, 12)
  ]);

  const snapshot = buildFedFeatureSnapshot({
    headlineInflation,
    coreInflation,
    unemployment,
    capturedAt: cutoff
  });

  return Object.freeze({
    ...snapshot,
    cutoffAt: cutoff,
    vintageDate,
    recordType: REPLAY_RECORD_TYPE
  });
}

async function optionalKalshiComparison({ kalshiAdapter, decision, forecastCutoff, realizedOutcome, modelScore }) {
  if (!kalshiAdapter) return null;
  try {
    return await buildFomcKalshiMarketComparison({
      kalshiAdapter,
      eventTicker: decision.kalshiEventTicker ?? null,
      cutoffAt: forecastCutoff,
      realizedOutcome,
      modelScore
    });
  } catch (error) {
    return Object.freeze({
      status: 'unavailable',
      venue: 'kalshi',
      eventTicker: decision.kalshiEventTicker ?? null,
      reason: 'venue_history_fetch_failed',
      error: error.message
    });
  }
}

export async function replayFomcDecision({
  fredAdapter,
  kalshiAdapter = null,
  decision,
  cutoffAt = null,
  config = {},
  reconstructedAt = new Date().toISOString()
}) {
  if (!decision?.id) throw new TypeError('decision.id is required');
  if (!decision?.meetingDate) throw new TypeError('decision.meetingDate is required');
  if (!Number.isFinite(Number(decision.changeBps))) throw new TypeError('decision.changeBps must be finite');

  const forecastCutoff = cutoffAt ? iso(cutoffAt, 'cutoffAt') : priorDayCutoff(decision.meetingDate);
  const featureSnapshot = await reconstructFedFeatures({ fredAdapter, cutoffAt: forecastCutoff });
  const model = fedDecisionProbabilities(featureSnapshot.features, config);
  const realizedOutcome = classifyRateChangeBps(decision.changeBps);
  const score = scoreCategoricalForecast(model.probabilities, realizedOutcome);
  const marketComparison = await optionalKalshiComparison({
    kalshiAdapter,
    decision,
    forecastCutoff,
    realizedOutcome,
    modelScore: score
  });

  return Object.freeze({
    id: `replay:fomc:${decision.id}:${FED_DECISION_MODEL.version}:${forecastCutoff}`,
    recordType: REPLAY_RECORD_TYPE,
    replayVersion: FOMC_REPLAY_VERSION,
    eventFamily: 'fomc_decision',
    eventId: `fomc:${decision.id}`,
    meetingDate: decision.meetingDate,
    forecastCutoff,
    reconstructedAt: iso(reconstructedAt, 'reconstructedAt'),
    modelId: FED_DECISION_MODEL.id,
    modelVersion: FED_DECISION_MODEL.version,
    modelStatus: FED_DECISION_MODEL.status,
    featureSnapshot,
    probabilities: model.probabilities,
    policyPressure: model.pressure,
    realizedOutcome,
    changeBps: Number(decision.changeBps),
    resolutionSource: decision.source ?? null,
    score,
    marketComparison,
    disclosure: 'Retrospective simulation using point-in-time source vintages. This was not a forecast published live at the historical cutoff.'
  });
}

export async function replayFomcHistory({ fredAdapter, kalshiAdapter = null, decisions, config = {} }) {
  if (!Array.isArray(decisions)) throw new TypeError('decisions must be an array');
  const results = [];
  for (const decision of decisions) {
    results.push(await replayFomcDecision({ fredAdapter, kalshiAdapter, decision, config }));
  }

  const meanBrier = results.length
    ? results.reduce((sum, row) => sum + row.score.brierMultiClass, 0) / results.length
    : null;
  const meanLogLoss = results.length
    ? results.reduce((sum, row) => sum + row.score.logLoss, 0) / results.length
    : null;

  const comparable = results.filter((row) => row.marketComparison?.status === 'available');
  const meanMarketBrier = comparable.length
    ? comparable.reduce((sum, row) => sum + row.marketComparison.score.brierMultiClass, 0) / comparable.length
    : null;
  const meanMarketLogLoss = comparable.length
    ? comparable.reduce((sum, row) => sum + row.marketComparison.score.logLoss, 0) / comparable.length
    : null;
  const meanBrierImprovementVsMarket = comparable.length
    ? comparable.reduce((sum, row) => sum + row.marketComparison.comparison.brierImprovementVsMarket, 0) / comparable.length
    : null;
  const meanLogLossImprovementVsMarket = comparable.length
    ? comparable.reduce((sum, row) => sum + row.marketComparison.comparison.logLossImprovementVsMarket, 0) / comparable.length
    : null;

  return Object.freeze({
    recordType: REPLAY_RECORD_TYPE,
    replayVersion: FOMC_REPLAY_VERSION,
    modelId: FED_DECISION_MODEL.id,
    modelVersion: FED_DECISION_MODEL.version,
    sampleSize: results.length,
    meanBrier,
    meanLogLoss,
    marketComparison: Object.freeze({
      venue: 'kalshi',
      sampleSize: comparable.length,
      meanMarketBrier,
      meanMarketLogLoss,
      meanBrierImprovementVsMarket,
      meanLogLossImprovementVsMarket,
      positiveImprovementMeansModelBetter: true
    }),
    results: Object.freeze(results)
  });
}
