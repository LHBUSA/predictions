import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KalshiPublicAdapter,
  normalizeKalshiMarket,
  normalizeKalshiCandlestick,
  selectKalshiCandlestickAtOrBefore
} from '../src/kalshi.js';
import { FredAdapter } from '../src/fred.js';
import { InMemorySnapshotStore } from '../src/storage.js';
import { captureMarketCycle } from '../src/pipeline.js';

test('normalizes Kalshi dollar prices into market probability', () => {
  const market = normalizeKalshiMarket({
    ticker: 'TEST-1', event_ticker: 'TEST', title: 'Test event', status: 'open',
    yes_bid_dollars: '0.42', yes_ask_dollars: '0.46', last_price_dollars: '0.45'
  }, '2026-09-16T10:00:00Z');
  assert.equal(market.impliedProbability, 0.44);
  assert.equal(market.marketId, 'TEST-1');
});

test('Kalshi adapter uses public markets endpoint and normalizes response', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ markets: [{ ticker: 'A', event_ticker: 'E', yes_bid_dollars: '0.50', yes_ask_dollars: '0.54' }], cursor: 'next' })
  });
  const adapter = new KalshiPublicAdapter({ fetchImpl });
  const page = await adapter.listMarkets({ status: 'open', limit: 1 });
  assert.equal(page.markets[0].impliedProbability, 0.52);
  assert.equal(page.cursor, 'next');
});

test('Kalshi historical adapter retains settlement metadata and series filter', async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        markets: [{
          ticker: 'KXTEST-25SEP',
          event_ticker: 'KXTEST-25SEP',
          title: 'Test settled market',
          status: 'settled',
          result: 'yes',
          settlement_value_dollars: '1.0000',
          settlement_ts: '2025-09-17T18:05:00Z',
          strike_type: 'greater',
          floor_strike: 3,
          yes_bid_dollars: '1.0000',
          yes_ask_dollars: '1.0000'
        }],
        cursor: ''
      })
    };
  };
  const adapter = new KalshiPublicAdapter({ fetchImpl, baseUrl: 'https://example.test/trade-api/v2' });
  const page = await adapter.listHistoricalMarkets({ seriesTicker: 'KXTEST', limit: 1000 });
  assert.match(seenUrl, /\/historical\/markets\?/);
  assert.match(seenUrl, /series_ticker=KXTEST/);
  assert.equal(page.markets[0].result, 'yes');
  assert.equal(page.markets[0].settlementValue, 1);
  assert.equal(page.markets[0].floorStrike, 3);
});

test('Kalshi historical candlesticks select the last market probability available before cutoff', async () => {
  const raw = [
    { end_period_ts: 100, yes_bid: { close: '0.40' }, yes_ask: { close: '0.44' }, price: { close: '0.42' }, volume: '10.00', open_interest: '8.00' },
    { end_period_ts: 200, yes_bid: { close: '0.56' }, yes_ask: { close: '0.60' }, price: { close: '0.58' }, volume: '12.00', open_interest: '9.00' },
    { end_period_ts: 300, yes_bid: { close: '0.70' }, yes_ask: { close: '0.74' }, price: { close: '0.72' }, volume: '14.00', open_interest: '10.00' }
  ];
  const normalized = raw.map(normalizeKalshiCandlestick);
  const cutoff = new Date(250 * 1000).toISOString();
  const selected = selectKalshiCandlestickAtOrBefore(normalized, cutoff);
  assert.equal(selected.endPeriodTs, 200);
  assert.equal(selected.impliedProbability, 0.58);
});

test('FRED adapter converts missing values to null', async () => {
  const fred = new FredAdapter({
    apiKey: 'test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '2.9' }, { date: '2026-09-01', value: '.' }] }) })
  });
  const result = await fred.observations('CPIAUCSL');
  assert.deepEqual(result.observations.map((x) => x.value), [2.9, null]);
});

test('capture cycle persists market and source snapshots append-only', async () => {
  const marketAdapter = { listMarkets: async () => ({ markets: [{ venue: 'kalshi', marketId: 'M1', observedAt: 't1' }], cursor: null }) };
  const source = { capture: async () => ({ provider: 'fred', seriesId: 'UNRATE', fetchedAt: 't1', observations: [] }) };
  const store = new InMemorySnapshotStore();
  const result = await captureMarketCycle({ marketAdapter, sourceAdapters: [source], store });
  assert.equal(result.marketCount, 1);
  assert.equal(store.listMarketSnapshots().length, 1);
  assert.equal(store.listSourceSnapshots().length, 1);
});
