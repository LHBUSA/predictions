import test from 'node:test';
import assert from 'node:assert/strict';
import { KalshiPublicAdapter, normalizeKalshiMarket } from '../src/kalshi.js';
import { FredAdapter } from '../src/fred.js';
import { InMemorySnapshotStore } from '../src/storage.js';
import { captureMarketCycle, createFredSeriesSource } from '../src/pipeline.js';

test('normalizes Kalshi dollar prices into market probability', () => {
  const market = normalizeKalshiMarket({
    ticker: 'TEST-1', event_ticker: 'TEST', title: 'Test event', status: 'open',
    yes_bid_dollars: '0.42', yes_ask_dollars: '0.46', last_price_dollars: '0.45'
  }, '2026-09-16T10:00:00Z');
  assert.equal(market.impliedProbability, 0.44);
  assert.equal(market.marketId, 'TEST-1');
});

test('Kalshi adapter uses public markets endpoint and normalizes response', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => ({ markets: [{ ticker: 'A', event_ticker: 'E', yes_bid_dollars: '0.50', yes_ask_dollars: '0.54' }], cursor: 'next' })
  });
  const adapter = new KalshiPublicAdapter({ fetchImpl });
  const page = await adapter.listMarkets({ status: 'open', limit: 1 });
  assert.equal(page.markets[0].impliedProbability, 0.52);
  assert.equal(page.cursor, 'next');
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
