import test from 'node:test';
import assert from 'node:assert/strict';
import { FRED_SERIES } from '../src/fred.js';
import { parseCpiAboveThreshold, replayCpiHistory, replayCpiRelease } from '../src/replay/cpi-history.js';

function monthRows(endYear, endMonth, count, startValue, monthlyStep) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(endYear, endMonth - 1 - i, 1));
    rows.push({
      date: d.toISOString().slice(0, 10),
      value: startValue - (monthlyStep * i),
      realtimeStart: '2026-01-12',
      realtimeEnd: '2026-01-12'
    });
  }
  return rows;
}

class FakeFred {
  constructor() { this.calls = []; }
  async observations(seriesId, options) {
    this.calls.push({ seriesId, options });
    if (seriesId === FRED_SERIES.cpiNsa) {
      return { provider: 'fred', seriesId, observations: monthRows(2025, 11, 20, 325, 0.62) };
    }
    if (seriesId === FRED_SERIES.coreCpiNsa) {
      return { provider: 'fred', seriesId, observations: monthRows(2025, 11, 20, 332, 0.70) };
    }
    if (seriesId === FRED_SERIES.cpi) {
      return { provider: 'fred', seriesId, observations: monthRows(2025, 11, 20, 326, 0.55) };
    }
    if (seriesId === FRED_SERIES.coreCpi) {
      return { provider: 'fred', seriesId, observations: monthRows(2025, 11, 20, 333, 0.61) };
    }
    throw new Error(`unexpected series ${seriesId}`);
  }
}

class FakeKalshi {
  constructor() {
    this.prices = new Map([
      ['CPI-25', 0.83],
      ['CPI-27', 0.55],
      ['CPI-29', 0.21]
    ]);
  }

  async listHistoricalMarkets({ eventTicker }) {
    assert.equal(eventTicker, 'KXCPIYOY-25DEC');
    return {
      markets: [
        { marketId: 'CPI-25', yesSubTitle: 'Above 2.5%', result: 'yes' },
        { marketId: 'CPI-27', yesSubTitle: 'Above 2.7%', result: 'no' },
        { marketId: 'CPI-29', yesSubTitle: 'Above 2.9%', result: 'no' }
      ],
      cursor: null
    };
  }

  async historicalCandlesticks(ticker, { endTs, periodInterval }) {
    assert.equal(periodInterval, 60);
    return {
      ticker,
      candlesticks: [{
        endPeriodTs: endTs - 900,
        endPeriodAt: new Date((endTs - 900) * 1000).toISOString(),
        impliedProbability: this.prices.get(ticker),
        volume: 100,
        openInterest: 50
      }]
    };
  }
}

const DEC_2025 = Object.freeze({
  id: '2025-12',
  referenceMonth: '2025-12',
  releaseDate: '2026-01-13',
  headlineYoY: 2.7,
  source: 'https://www.bls.gov/news.release/archives/cpi_01132026.htm',
  kalshiEventTicker: 'KXCPIYOY-25DEC'
});

test('parses CPI headline threshold contracts from venue labels', () => {
  assert.equal(parseCpiAboveThreshold({ yesSubTitle: 'Above 3.4%' }), 3.4);
  assert.equal(parseCpiAboveThreshold({ title: 'Inflation in July 2026' }), null);
});

test('CPI replay reconstructs only point-in-time inputs and scores every historical threshold independently', async () => {
  const fredAdapter = new FakeFred();
  const result = await replayCpiRelease({
    fredAdapter,
    kalshiAdapter: new FakeKalshi(),
    release: DEC_2025,
    reconstructedAt: '2026-09-16T18:00:00Z'
  });

  assert.equal(result.recordType, 'retrospective_replay');
  assert.equal(result.forecastCutoff, '2026-01-12T23:59:59.999Z');
  assert.equal(result.featureSnapshot.vintageDate, '2026-01-12');
  assert.equal(result.featureSnapshot.approximations.length, 2);
  assert.equal(result.marketComparison.status, 'available');
  assert.equal(result.marketComparison.contractCount, 3);

  const byThreshold = new Map(result.marketComparison.contracts.map((row) => [row.threshold, row]));
  assert.equal(byThreshold.get(2.5).outcome, 1);
  assert.equal(byThreshold.get(2.7).outcome, 0);
  assert.equal(byThreshold.get(2.9).outcome, 0);
  for (const row of result.marketComparison.contracts) {
    assert.ok(row.modelProbability >= 0 && row.modelProbability <= 1);
    assert.ok(row.marketProbability >= 0 && row.marketProbability <= 1);
    assert.ok(Number.isFinite(row.modelScore.brier));
    assert.ok(Number.isFinite(row.marketScore.brier));
  }

  assert.equal(fredAdapter.calls.length, 4);
  for (const call of fredAdapter.calls) {
    assert.equal(call.options.realtimeStart, '2026-01-12');
    assert.equal(call.options.realtimeEnd, '2026-01-12');
    assert.equal(call.options.observationEnd, '2026-01-12');
  }
});

test('CPI history reports release sample separately from the number of scored threshold contracts', async () => {
  const result = await replayCpiHistory({
    fredAdapter: new FakeFred(),
    kalshiAdapter: new FakeKalshi(),
    releases: [DEC_2025]
  });

  assert.equal(result.releaseSampleSize, 1);
  assert.equal(result.comparableReleaseSampleSize, 1);
  assert.equal(result.comparableContractSampleSize, 3);
  assert.ok(Number.isFinite(result.meanModelBrier));
  assert.ok(Number.isFinite(result.meanMarketBrier));
  assert.ok(Number.isFinite(result.meanBrierImprovementVsMarket));
});

test('CPI replay fails the venue comparison closed if an official outcome disagrees with settlement', async () => {
  const badKalshi = new FakeKalshi();
  badKalshi.listHistoricalMarkets = async () => ({
    markets: [
      { marketId: 'CPI-25', yesSubTitle: 'Above 2.5%', result: 'no' },
      { marketId: 'CPI-27', yesSubTitle: 'Above 2.7%', result: 'no' },
      { marketId: 'CPI-29', yesSubTitle: 'Above 2.9%', result: 'no' }
    ]
  });
  const result = await replayCpiRelease({
    fredAdapter: new FakeFred(),
    kalshiAdapter: badKalshi,
    release: DEC_2025
  });
  assert.equal(result.marketComparison.status, 'resolution_mismatch');
  assert.equal(result.marketComparison.marketId, 'CPI-25');
});
