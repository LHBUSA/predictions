import { FOMC_OUTCOMES, scoreCategoricalForecast } from '../backtest/fomc.js';
import { classifyFedContract } from '../models/fed-decision-v0.js';
import { selectKalshiCandlestickAtOrBefore } from '../kalshi.js';

const LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

function marketOutcome(market) {
  return classifyFedContract(market?.yesSubTitle || market?.subtitle || market?.title || '');
}

function unavailable(reason, details = {}) {
  return Object.freeze({
    status: 'unavailable',
    venue: 'kalshi',
    reason,
    ...details
  });
}

function validateSettlement(marketsByOutcome, realizedOutcome) {
  const results = FOMC_OUTCOMES.map((outcome) => marketsByOutcome.get(outcome)?.result ?? null);
  if (results.some((value) => !value)) return Object.freeze({ status: 'not_checked', reason: 'settlement_result_missing' });

  const mismatches = [];
  for (const outcome of FOMC_OUTCOMES) {
    const expected = outcome === realizedOutcome ? 'yes' : 'no';
    const actual = String(marketsByOutcome.get(outcome).result).toLowerCase();
    if (actual !== expected) mismatches.push({ outcome, expected, actual });
  }

  return mismatches.length
    ? Object.freeze({ status: 'mismatch', mismatches: Object.freeze(mismatches) })
    : Object.freeze({ status: 'verified' });
}

export async function buildFomcKalshiMarketComparison({
  kalshiAdapter,
  eventTicker,
  cutoffAt,
  realizedOutcome,
  modelScore
}) {
  if (!kalshiAdapter?.listHistoricalMarkets || !kalshiAdapter?.historicalCandlesticks) {
    throw new TypeError('kalshiAdapter with historical market methods is required');
  }
  if (!eventTicker) return unavailable('event_ticker_not_mapped');
  if (!FOMC_OUTCOMES.includes(realizedOutcome)) throw new RangeError(`unsupported realized outcome ${realizedOutcome}`);

  const cutoffMs = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoffMs)) throw new TypeError('cutoffAt must be a valid timestamp');
  const cutoffSeconds = Math.floor(cutoffMs / 1000);

  const page = await kalshiAdapter.listHistoricalMarkets({ eventTicker, limit: 1000 });
  const marketsByOutcome = new Map();
  const duplicates = [];
  for (const market of page.markets ?? []) {
    const outcome = marketOutcome(market);
    if (!outcome) continue;
    if (marketsByOutcome.has(outcome)) {
      duplicates.push(outcome);
      continue;
    }
    marketsByOutcome.set(outcome, market);
  }

  const missingOutcomes = FOMC_OUTCOMES.filter((outcome) => !marketsByOutcome.has(outcome));
  if (missingOutcomes.length || duplicates.length) {
    return unavailable('incomplete_or_ambiguous_outcome_set', {
      eventTicker,
      missingOutcomes: Object.freeze(missingOutcomes),
      duplicateOutcomes: Object.freeze([...new Set(duplicates)])
    });
  }

  const settlementCheck = validateSettlement(marketsByOutcome, realizedOutcome);
  if (settlementCheck.status === 'mismatch') {
    return Object.freeze({
      status: 'resolution_mismatch',
      venue: 'kalshi',
      eventTicker,
      settlementCheck
    });
  }

  const rawProbabilities = {};
  const snapshots = {};
  for (const outcome of FOMC_OUTCOMES) {
    const market = marketsByOutcome.get(outcome);
    const history = await kalshiAdapter.historicalCandlesticks(market.marketId, {
      startTs: cutoffSeconds - LOOKBACK_SECONDS,
      endTs: cutoffSeconds,
      periodInterval: 60
    });
    const candle = selectKalshiCandlestickAtOrBefore(history.candlesticks ?? [], cutoffAt);
    if (!candle || !Number.isFinite(candle.impliedProbability)) {
      return unavailable('missing_cutoff_price', { eventTicker, outcome, marketId: market.marketId });
    }
    rawProbabilities[outcome] = candle.impliedProbability;
    snapshots[outcome] = Object.freeze({
      marketId: market.marketId,
      label: market.yesSubTitle || market.subtitle || market.title,
      probability: candle.impliedProbability,
      snapshotAt: candle.endPeriodAt,
      volume: candle.volume,
      openInterest: candle.openInterest
    });
  }

  const rawSum = Object.values(rawProbabilities).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(rawSum) || rawSum <= 0) return unavailable('invalid_probability_sum', { eventTicker, rawSum });
  const probabilities = Object.freeze(Object.fromEntries(
    FOMC_OUTCOMES.map((outcome) => [outcome, rawProbabilities[outcome] / rawSum])
  ));
  const marketScore = scoreCategoricalForecast(probabilities, realizedOutcome);

  return Object.freeze({
    status: 'available',
    venue: 'kalshi',
    eventTicker,
    cutoffAt,
    outcomeCoverage: FOMC_OUTCOMES.length,
    rawProbabilitySum: rawSum,
    rawProbabilities: Object.freeze(rawProbabilities),
    probabilities,
    snapshots: Object.freeze(snapshots),
    settlementCheck,
    score: marketScore,
    comparison: modelScore ? Object.freeze({
      brierImprovementVsMarket: marketScore.brierMultiClass - modelScore.brierMultiClass,
      logLossImprovementVsMarket: marketScore.logLoss - modelScore.logLoss,
      positiveMeansModelBetter: true
    }) : null,
    disclosure: 'Kalshi probabilities are reconstructed from archived hourly candlesticks at or before the same retrospective forecast cutoff and normalized across the complete five-outcome event.'
  });
}
