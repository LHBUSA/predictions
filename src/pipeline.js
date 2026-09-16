export async function captureMarketCycle({ marketAdapter, sourceAdapters = [], store, status = 'open', limit = 100 }) {
  if (!marketAdapter?.listMarkets) throw new TypeError('marketAdapter.listMarkets is required');
  if (!store?.appendMarket) throw new TypeError('store.appendMarket is required');

  const page = await marketAdapter.listMarkets({ status, limit });
  for (const market of page.markets) store.appendMarket(market);

  const sources = [];
  for (const source of sourceAdapters) {
    const snapshot = await source.capture();
    sources.push(snapshot);
    if (store.appendSource) store.appendSource(snapshot);
  }

  return Object.freeze({
    capturedAt: new Date().toISOString(),
    marketCount: page.markets.length,
    sourceCount: sources.length,
    nextCursor: page.cursor,
    markets: page.markets,
    sources
  });
}

export function createFredSeriesSource({ fred, seriesId, options }) {
  return Object.freeze({
    provider: 'fred',
    seriesId,
    capture: () => fred.observations(seriesId, options)
  });
}
