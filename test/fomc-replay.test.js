import test from 'node:test';
import assert from 'node:assert/strict';
import { FRED_SERIES } from '../src/fred.js';
import { priorDayCutoff, replayFomcDecision, replayFomcHistory, REPLAY_RECORD_TYPE } from '../src/replay/fomc-history.js';

function monthlyIndex(start, step = 0.5, count = 24) {
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2025, 7 - i, 1)).toISOString().slice(0, 10),
    value: start - (step * i),
    realtimeStart: '2025-09-16',
    realtimeEnd: '2025-09-16'
  }));
}

class FakeFred {
  constructor() { this.calls = []; }
  async observations(seriesId, options) {
    this.calls.push({ seriesId, options });
    if (seriesId === FRED_SERIES.cpi) {
      return { provider: 'fred', seriesId, observations: monthlyIndex(323, 0.62, 24) };
    }
    if (seriesId === FRED_SERIES.coreCpi) {
      return { provider: 'fred', seriesId, observations: monthlyIndex(329, 0.68, 24) };
    }
    if (seriesId === FRED_SERIES.unemployment) {
      return {
        provider: 'fred',
        seriesId,
        observations: [
          { date: '2025-08-01', value: 4.3 },
          { date: '2025-07-01', value: 4.2 },
          { date: '2025-06-01', value: 4.2 },
          { date: '2025-05-01', value: 4.1 }
        ]
      };
    }
    throw new Error(`unexpected series ${seriesId}`);
  }
}

class FakeKalshi {
  constructor() {
    this.probabilities = new Map([
      ['M-CUTGT25', 0.04],
      ['M-CUT25', 0.70],
      ['M-HOLD', 0.22],
      ['M-HIKE25', 0.03],
      ['M-HIKEGT25', 0.01]
    ]);
  }

  async listHistoricalMarkets({ eventTicker }) {
    assert.equal(eventTicker, 'KXFEDDECISION-25SEP');
    return {
      markets: [
        { marketId: 'M-CUTGT25', yesSubTitle: 'Cut >25bps', result: 'no' },
        { marketId: 'M-CUT25', yesSubTitle: 'Cut 25bps', result: 'yes' },
        { marketId: 'M-HOLD', yesSubTitle: 'Fed maintains rate', result: 'no' },
        { marketId: 'M-HIKE25', yesSubTitle: 'Hike 25bps', result: 'no' },
        { marketId: 'M-HIKEGT25', yesSubTitle: 'Hike >25bps', result: 'no' }
      ],
      cursor: null
    };
  }

  async historicalCandlesticks(ticker, { endTs, periodInterval }) {
    assert.equal(periodInterval, 60);
    const probability = this.probabilities.get(ticker);
    return {
      ticker,
      candlesticks: [{
        endPeriodTs: endTs - 1800,
        endPeriodAt: new Date((endTs - 1800) * 1000).toISOString(),
        impliedProbability: probability,
        volume: 100,
        openInterest: 50
      }]
    };
  }
}

const SEP_2025 = Object.freeze({
  id: '2025-09-17',
  meetingDate: '2025-09-17',
  changeBps: -25,
  source: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20250917a.htm',
  kalshiEventTicker: 'KXFEDDECISION-25SEP'
});

test('prior-day replay cutoff is deterministic and conservative', () => {
  assert.equal(priorDayCutoff('2025-09-17'), '2025-09-16T23:59:59.999Z');
});

test('FOMC replay uses one historical FRED vintage and labels itself retrospective', async () => {
  const fredAdapter = new FakeFred();
  const result = await replayFomcDecision({
    fredAdapter,
    decision: SEP_2025,
    reconstructedAt: '2026-09-16T17:00:00Z'
  });

  assert.equal(result.recordType, REPLAY_RECORD_TYPE);
  assert.equal(result.forecastCutoff, '2025-09-16T23:59:59.999Z');
  assert.equal(result.realizedOutcome, 'cut_25');
  assert.equal(result.modelVersion, '0.1.0');
  assert.equal(result.featureSnapshot.vintageDate, '2025-09-16');
  assert.ok(Number.isFinite(result.featureSnapshot.features.coreInflationYoY));
  assert.ok(Number.isFinite(result.featureSnapshot.features.headlineInflationYoY));
  assert.ok(Number.isFinite(result.score.brierMultiClass));
  assert.equal(result.marketComparison, null);
  assert.match(result.disclosure, /not a forecast published live/i);

  assert.equal(fredAdapter.calls.length, 3);
  for (const call of fredAdapter.calls) {
    assert.equal(call.options.realtimeStart, '2025-09-16');
    assert.equal(call.options.realtimeEnd, '2025-09-16');
    assert.equal(call.options.observationEnd, '2025-09-16');
  }
});

test('FOMC replay compares model and complete Kalshi outcome set at the same cutoff', async () => {
  const result = await replayFomcDecision({
    fredAdapter: new FakeFred(),
    kalshiAdapter: new FakeKalshi(),
    decision: SEP_2025,
    reconstructedAt: '2026-09-16T17:00:00Z'
  });

  assert.equal(result.marketComparison.status, 'available');
  assert.equal(result.marketComparison.eventTicker, 'KXFEDDECISION-25SEP');
  assert.equal(result.marketComparison.outcomeCoverage, 5);
  assert.equal(result.marketComparison.settlementCheck.status, 'verified');
  const total = Object.values(result.marketComparison.probabilities).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.ok(Number.isFinite(result.marketComparison.score.brierMultiClass));
  assert.ok(Number.isFinite(result.marketComparison.comparison.brierImprovementVsMarket));
});

test('FOMC history keeps model replay sample size separate from Kalshi comparison sample size', async () => {
  const result = await replayFomcHistory({
    fredAdapter: new FakeFred(),
    kalshiAdapter: new FakeKalshi(),
    decisions: [SEP_2025]
  });
  assert.equal(result.sampleSize, 1);
  assert.equal(result.marketComparison.sampleSize, 1);
  assert.ok(Number.isFinite(result.marketComparison.meanMarketBrier));
  assert.ok(Number.isFinite(result.marketComparison.meanBrierImprovementVsMarket));
});
