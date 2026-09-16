import test from 'node:test';
import assert from 'node:assert/strict';
import { FRED_SERIES } from '../src/fred.js';
import {
  parsePayrollAboveThresholdK,
  replayPayrollHistory,
  replayPayrollRelease
} from '../src/replay/payroll-history.js';

function monthlyRows(endYear, endMonth, values) {
  return values.map((value, index) => {
    const d = new Date(Date.UTC(endYear, endMonth - 1 - index, 1));
    return { date: d.toISOString().slice(0, 10), value };
  });
}

class FakeFred {
  constructor() { this.calls = []; }
  async observations(seriesId, options) {
    this.calls.push({ seriesId, options });
    if (seriesId === FRED_SERIES.unemployment) {
      return {
        provider: 'fred', seriesId,
        observations: monthlyRows(2026, 4, [4.3, 4.2, 4.1, 4.1, 4.0])
      };
    }
    if (seriesId === FRED_SERIES.payrolls) {
      return {
        provider: 'fred', seriesId,
        observations: monthlyRows(2026, 4, [159600, 159450, 159320, 159210, 159080])
      };
    }
    if (seriesId === FRED_SERIES.initialClaims) {
      return {
        provider: 'fred', seriesId,
        observations: [
          { date: '2026-05-30', value: 218000 },
          { date: '2026-05-23', value: 221000 }
        ]
      };
    }
    if (seriesId === FRED_SERIES.continuingClaims) {
      return {
        provider: 'fred', seriesId,
        observations: [
          { date: '2026-05-23', value: 1860000 },
          { date: '2026-05-16', value: 1845000 }
        ]
      };
    }
    throw new Error(`unexpected series ${seriesId}`);
  }
}

class FakeKalshi {
  constructor() {
    this.prices = new Map([
      ['PAY-100', 0.84],
      ['PAY-150', 0.58],
      ['PAY-175', 0.34]
    ]);
  }

  async listHistoricalMarkets({ eventTicker }) {
    assert.equal(eventTicker, 'KXPAYROLLS-26MAY');
    return {
      markets: [
        { marketId: 'PAY-100', yesSubTitle: 'Above 100,000', result: 'yes' },
        { marketId: 'PAY-150', yesSubTitle: 'Above 150,000', result: 'yes' },
        { marketId: 'PAY-175', yesSubTitle: 'Above 175,000', result: 'no' }
      ]
    };
  }

  async historicalCandlesticks(ticker, { endTs, periodInterval }) {
    assert.equal(periodInterval, 60);
    return {
      ticker,
      candlesticks: [{
        endPeriodTs: endTs - 1200,
        endPeriodAt: new Date((endTs - 1200) * 1000).toISOString(),
        impliedProbability: this.prices.get(ticker),
        volume: 100,
        openInterest: 50
      }]
    };
  }
}

const MAY_2026 = Object.freeze({
  id: '2026-05',
  referenceMonth: '2026-05',
  releaseDate: '2026-06-05',
  payrollChangeK: 172,
  unemploymentRate: 4.3,
  source: 'https://www.bls.gov/news.release/archives/empsit_06052026.htm',
  kalshiEventTicker: 'KXPAYROLLS-26MAY'
});

test('parses payroll threshold labels into thousands of jobs', () => {
  assert.equal(parsePayrollAboveThresholdK({ yesSubTitle: 'Above 100,000' }), 100);
  assert.equal(parsePayrollAboveThresholdK({ yesSubTitle: 'Above -25,000' }), -25);
  assert.equal(parsePayrollAboveThresholdK({ title: 'Jobs numbers in May 2026?' }), null);
});

test('payroll replay converts level and claims source units before scoring the threshold ladder', async () => {
  const fredAdapter = new FakeFred();
  const result = await replayPayrollRelease({
    fredAdapter,
    kalshiAdapter: new FakeKalshi(),
    release: MAY_2026,
    reconstructedAt: '2026-09-16T18:30:00Z'
  });

  assert.equal(result.recordType, 'retrospective_replay');
  assert.equal(result.forecastCutoff, '2026-06-04T23:59:59.999Z');
  assert.equal(result.featureSnapshot.vintageDate, '2026-06-04');
  assert.equal(result.featureSnapshot.features.payrollChangeK, 150);
  assert.equal(result.featureSnapshot.features.priorPayrollChangeK, 130);
  assert.equal(result.featureSnapshot.features.initialClaimsK, 218);
  assert.equal(result.featureSnapshot.features.continuingClaimsM, 1.86);
  assert.equal(result.marketComparison.status, 'available');
  assert.equal(result.marketComparison.contractCount, 3);

  const byThreshold = new Map(result.marketComparison.contracts.map((row) => [row.thresholdK, row]));
  assert.equal(byThreshold.get(100).outcome, 1);
  assert.equal(byThreshold.get(150).outcome, 1);
  assert.equal(byThreshold.get(175).outcome, 0);
  for (const row of result.marketComparison.contracts) {
    assert.ok(row.modelProbability >= 0 && row.modelProbability <= 1);
    assert.ok(Number.isFinite(row.modelScore.brier));
    assert.ok(Number.isFinite(row.marketScore.brier));
  }

  assert.equal(fredAdapter.calls.length, 4);
  for (const call of fredAdapter.calls) {
    assert.equal(call.options.realtimeStart, '2026-06-04');
    assert.equal(call.options.realtimeEnd, '2026-06-04');
    assert.equal(call.options.observationEnd, '2026-06-04');
  }
});

test('payroll history separates release count from scored venue contract count', async () => {
  const result = await replayPayrollHistory({
    fredAdapter: new FakeFred(),
    kalshiAdapter: new FakeKalshi(),
    releases: [MAY_2026]
  });
  assert.equal(result.releaseSampleSize, 1);
  assert.equal(result.comparableReleaseSampleSize, 1);
  assert.equal(result.comparableContractSampleSize, 3);
  assert.ok(Number.isFinite(result.meanModelBrier));
  assert.ok(Number.isFinite(result.meanMarketBrier));
});

test('payroll venue comparison fails closed on official-settlement mismatch', async () => {
  const badKalshi = new FakeKalshi();
  badKalshi.listHistoricalMarkets = async () => ({
    markets: [
      { marketId: 'PAY-100', yesSubTitle: 'Above 100,000', result: 'no' },
      { marketId: 'PAY-150', yesSubTitle: 'Above 150,000', result: 'yes' },
      { marketId: 'PAY-175', yesSubTitle: 'Above 175,000', result: 'no' }
    ]
  });
  const result = await replayPayrollRelease({
    fredAdapter: new FakeFred(),
    kalshiAdapter: badKalshi,
    release: MAY_2026
  });
  assert.equal(result.marketComparison.status, 'resolution_mismatch');
  assert.equal(result.marketComparison.marketId, 'PAY-100');
});
