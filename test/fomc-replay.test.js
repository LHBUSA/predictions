import test from 'node:test';
import assert from 'node:assert/strict';
import { FRED_SERIES } from '../src/fred.js';
import { priorDayCutoff, replayFomcDecision, REPLAY_RECORD_TYPE } from '../src/replay/fomc-history.js';

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

test('prior-day replay cutoff is deterministic and conservative', () => {
  assert.equal(priorDayCutoff('2025-09-17'), '2025-09-16T23:59:59.999Z');
});

test('FOMC replay uses one historical FRED vintage and labels itself retrospective', async () => {
  const fredAdapter = new FakeFred();
  const result = await replayFomcDecision({
    fredAdapter,
    decision: {
      id: '2025-09-17',
      meetingDate: '2025-09-17',
      changeBps: -25,
      source: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20250917a.htm'
    },
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
  assert.match(result.disclosure, /not a forecast published live/i);

  assert.equal(fredAdapter.calls.length, 3);
  for (const call of fredAdapter.calls) {
    assert.equal(call.options.realtimeStart, '2025-09-16');
    assert.equal(call.options.realtimeEnd, '2025-09-16');
    assert.equal(call.options.observationEnd, '2025-09-16');
  }
});
