import { FRED_SERIES } from '../fred.js';
import { buildEmploymentReplayFeatures } from '../features/employment-replay-features.js';
import { EMPLOYMENT_MODEL, probabilityPayrollsAbove } from '../models/employment-v0.js';
import { brierScore, logLoss } from '../scoring.js';
import { selectKalshiCandlestickAtOrBefore } from '../kalshi.js';
import { priorDayCutoff } from './cutoff.js';

export const PAYROLL_REPLAY_RECORD_TYPE = 'retrospective_replay';
export const PAYROLL_REPLAY_VERSION = '0.1.0';
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

function iso(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return d.toISOString();
}

async function vintageSeries(fredAdapter, seriesId, vintageDate, limit) {
  return fredAdapter.observations(seriesId, {
    limit,
    sortOrder: 'desc',
    observationEnd: vintageDate,
    realtimeStart: vintageDate,
    realtimeEnd: vintageDate,
    outputType: 1
  });
}

export async function reconstructEmploymentFeatures({ fredAdapter, cutoffAt }) {
  if (!fredAdapter?.observations) throw new TypeError('fredAdapter with observations() is required');
  const cutoff = iso(cutoffAt, 'cutoffAt');
  const vintageDate = cutoff.slice(0, 10);

  const [unemployment, payrolls, initialClaims, continuingClaims] = await Promise.all([
    vintageSeries(fredAdapter, FRED_SERIES.unemployment, vintageDate, 12),
    vintageSeries(fredAdapter, FRED_SERIES.payrolls, vintageDate, 12),
    vintageSeries(fredAdapter, FRED_SERIES.initialClaims, vintageDate, 16),
    vintageSeries(fredAdapter, FRED_SERIES.continuingClaims, vintageDate, 16)
  ]);

  const snapshot = buildEmploymentReplayFeatures({
    unemployment,
    payrolls,
    initialClaims,
    continuingClaims,
    capturedAt: cutoff
  });

  return Object.freeze({
    ...snapshot,
    cutoffAt: cutoff,
    vintageDate,
    recordType: PAYROLL_REPLAY_RECORD_TYPE
  });
}

export function parsePayrollAboveThresholdK(market) {
  const text = [market?.yesSubTitle, market?.subtitle, market?.title]
    .filter(Boolean)
    .join(' | ');
  const match = /above\s+(-?[\d,]+)(?![\d.])/i.exec(text);
  if (!match) return null;
  const raw = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(raw) ? raw / 1_000 : null;
}

function scoreBinary(probability, outcome) {
  return Object.freeze({
    brier: brierScore(probability, outcome),
    logLoss: logLoss(probability, outcome)
  });
}

function mean(rows, selector) {
  return rows.length ? rows.reduce((sum, row) => sum + selector(row), 0) / rows.length : null;
}

async function comparePayrollsToKalshi({ kalshiAdapter, release, cutoffAt, featureSnapshot, config = {} }) {
  if (!kalshiAdapter) return Object.freeze({ status: 'not_requested', venue: 'kalshi' });
  if (!release.kalshiEventTicker) return Object.freeze({ status: 'unavailable', venue: 'kalshi', reason: 'event_ticker_not_mapped' });

  const page = await kalshiAdapter.listHistoricalMarkets({ eventTicker: release.kalshiEventTicker, limit: 1000 });
  const markets = page.markets ?? [];
  if (!markets.length) {
    return Object.freeze({ status: 'unavailable', venue: 'kalshi', eventTicker: release.kalshiEventTicker, reason: 'no_historical_markets' });
  }

  const classified = markets.map((market) => ({ market, thresholdK: parsePayrollAboveThresholdK(market) }));
  const unclassified = classified.filter((row) => !Number.isFinite(row.thresholdK));
  if (unclassified.length) {
    return Object.freeze({
      status: 'unavailable',
      venue: 'kalshi',
      eventTicker: release.kalshiEventTicker,
      reason: 'incomplete_threshold_classification',
      unclassifiedMarkets: Object.freeze(unclassified.map((row) => Object.freeze({
        marketId: row.market.marketId,
        label: row.market.yesSubTitle || row.market.subtitle || row.market.title
      })))
    });
  }

  const thresholds = classified.map((row) => row.thresholdK);
  const duplicates = thresholds.filter((value, index) => thresholds.indexOf(value) !== index);
  if (duplicates.length) {
    return Object.freeze({
      status: 'unavailable',
      venue: 'kalshi',
      eventTicker: release.kalshiEventTicker,
      reason: 'duplicate_thresholds',
      duplicateThresholdsK: Object.freeze([...new Set(duplicates)])
    });
  }

  const cutoffSeconds = Math.floor(Date.parse(cutoffAt) / 1000);
  const rows = [];
  for (const { market, thresholdK } of classified.sort((a, b) => a.thresholdK - b.thresholdK)) {
    const outcome = Number(release.payrollChangeK) > thresholdK ? 1 : 0;
    const expectedSettlement = outcome ? 'yes' : 'no';
    const settlement = market.result ? String(market.result).toLowerCase() : null;
    if (settlement && settlement !== expectedSettlement) {
      return Object.freeze({
        status: 'resolution_mismatch',
        venue: 'kalshi',
        eventTicker: release.kalshiEventTicker,
        marketId: market.marketId,
        thresholdK,
        officialPayrollChangeK: Number(release.payrollChangeK),
        expectedSettlement,
        venueSettlement: settlement
      });
    }

    const history = await kalshiAdapter.historicalCandlesticks(market.marketId, {
      startTs: cutoffSeconds - LOOKBACK_SECONDS,
      endTs: cutoffSeconds,
      periodInterval: 60
    });
    const candle = selectKalshiCandlestickAtOrBefore(history.candlesticks ?? [], cutoffAt);
    if (!candle || !Number.isFinite(candle.impliedProbability)) {
      return Object.freeze({
        status: 'unavailable',
        venue: 'kalshi',
        eventTicker: release.kalshiEventTicker,
        reason: 'missing_cutoff_price',
        marketId: market.marketId,
        thresholdK
      });
    }

    const model = probabilityPayrollsAbove(featureSnapshot.features, thresholdK, config);
    const modelScore = scoreBinary(model.probability, outcome);
    const marketScore = scoreBinary(candle.impliedProbability, outcome);
    rows.push(Object.freeze({
      marketId: market.marketId,
      label: market.yesSubTitle || market.subtitle || market.title,
      thresholdK,
      outcome,
      officialPayrollChangeK: Number(release.payrollChangeK),
      modelProbability: model.probability,
      marketProbability: candle.impliedProbability,
      marketSnapshotAt: candle.endPeriodAt,
      settlement: settlement ?? expectedSettlement,
      modelScore,
      marketScore,
      comparison: Object.freeze({
        brierImprovementVsMarket: marketScore.brier - modelScore.brier,
        logLossImprovementVsMarket: marketScore.logLoss - modelScore.logLoss,
        positiveMeansModelBetter: true
      }),
      explanation: model.explanation
    }));
  }

  return Object.freeze({
    status: 'available',
    venue: 'kalshi',
    eventTicker: release.kalshiEventTicker,
    contractCount: rows.length,
    meanModelBrier: mean(rows, (row) => row.modelScore.brier),
    meanMarketBrier: mean(rows, (row) => row.marketScore.brier),
    meanModelLogLoss: mean(rows, (row) => row.modelScore.logLoss),
    meanMarketLogLoss: mean(rows, (row) => row.marketScore.logLoss),
    meanBrierImprovementVsMarket: mean(rows, (row) => row.comparison.brierImprovementVsMarket),
    meanLogLossImprovementVsMarket: mean(rows, (row) => row.comparison.logLossImprovementVsMarket),
    positiveImprovementMeansModelBetter: true,
    contracts: Object.freeze(rows),
    disclosure: 'Each payroll threshold contract is scored independently at the same retrospective cutoff. Probabilities are not normalized across the threshold ladder.'
  });
}

export async function replayPayrollRelease({
  fredAdapter,
  kalshiAdapter = null,
  release,
  cutoffAt = null,
  config = {},
  reconstructedAt = new Date().toISOString()
}) {
  if (!release?.id) throw new TypeError('release.id is required');
  if (!release?.releaseDate) throw new TypeError('release.releaseDate is required');
  if (!Number.isFinite(Number(release.payrollChangeK))) throw new TypeError('release.payrollChangeK must be finite');

  const forecastCutoff = cutoffAt ? iso(cutoffAt, 'cutoffAt') : priorDayCutoff(release.releaseDate);
  const featureSnapshot = await reconstructEmploymentFeatures({ fredAdapter, cutoffAt: forecastCutoff });

  let marketComparison;
  try {
    marketComparison = await comparePayrollsToKalshi({
      kalshiAdapter,
      release,
      cutoffAt: forecastCutoff,
      featureSnapshot,
      config
    });
  } catch (error) {
    marketComparison = Object.freeze({
      status: 'unavailable',
      venue: 'kalshi',
      eventTicker: release.kalshiEventTicker ?? null,
      reason: 'venue_history_fetch_failed',
      error: error.message
    });
  }

  return Object.freeze({
    id: `replay:payrolls:${release.id}:${EMPLOYMENT_MODEL.version}:${forecastCutoff}`,
    recordType: PAYROLL_REPLAY_RECORD_TYPE,
    replayVersion: PAYROLL_REPLAY_VERSION,
    eventFamily: 'payroll_thresholds',
    eventId: `payrolls:${release.id}`,
    referenceMonth: release.referenceMonth ?? release.id,
    releaseDate: release.releaseDate,
    forecastCutoff,
    reconstructedAt: iso(reconstructedAt, 'reconstructedAt'),
    modelId: EMPLOYMENT_MODEL.id,
    modelVersion: EMPLOYMENT_MODEL.version,
    modelStatus: EMPLOYMENT_MODEL.status,
    featureSnapshot,
    officialPayrollChangeK: Number(release.payrollChangeK),
    officialUnemploymentRate: Number.isFinite(Number(release.unemploymentRate)) ? Number(release.unemploymentRate) : null,
    resolutionSource: release.source ?? null,
    marketComparison,
    disclosure: 'Retrospective payroll-threshold simulation using point-in-time source vintages. This was not a forecast published live at the historical cutoff.'
  });
}

export async function replayPayrollHistory({ fredAdapter, kalshiAdapter = null, releases, config = {} }) {
  if (!Array.isArray(releases)) throw new TypeError('releases must be an array');
  const results = [];
  for (const release of releases) {
    results.push(await replayPayrollRelease({ fredAdapter, kalshiAdapter, release, config }));
  }
  const comparable = results.filter((row) => row.marketComparison?.status === 'available');
  const contracts = comparable.flatMap((row) => row.marketComparison.contracts);

  return Object.freeze({
    recordType: PAYROLL_REPLAY_RECORD_TYPE,
    replayVersion: PAYROLL_REPLAY_VERSION,
    modelId: EMPLOYMENT_MODEL.id,
    modelVersion: EMPLOYMENT_MODEL.version,
    releaseSampleSize: results.length,
    comparableReleaseSampleSize: comparable.length,
    comparableContractSampleSize: contracts.length,
    meanModelBrier: mean(contracts, (row) => row.modelScore.brier),
    meanMarketBrier: mean(contracts, (row) => row.marketScore.brier),
    meanModelLogLoss: mean(contracts, (row) => row.modelScore.logLoss),
    meanMarketLogLoss: mean(contracts, (row) => row.marketScore.logLoss),
    meanBrierImprovementVsMarket: mean(contracts, (row) => row.comparison.brierImprovementVsMarket),
    meanLogLossImprovementVsMarket: mean(contracts, (row) => row.comparison.logLossImprovementVsMarket),
    positiveImprovementMeansModelBetter: true,
    results: Object.freeze(results)
  });
}
