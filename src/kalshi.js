const DEFAULT_BASE_URL = 'https://external-api.kalshi.com/trade-api/v2';

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
}

function parseProbability(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return n;
}

function midpoint(bid, ask, fallback) {
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid ?? ask ?? fallback ?? null;
}

export function normalizeKalshiMarket(market, observedAt = new Date().toISOString()) {
  if (!market?.ticker) throw new TypeError('Kalshi market ticker is required');

  const yesBid = parseProbability(market.yes_bid_dollars);
  const yesAsk = parseProbability(market.yes_ask_dollars);
  const lastPrice = parseProbability(market.last_price_dollars);
  const impliedProbability = midpoint(yesBid, yesAsk, lastPrice);

  return Object.freeze({
    venue: 'kalshi',
    marketId: market.ticker,
    eventId: market.event_ticker ?? market.ticker,
    title: market.title ?? market.subtitle ?? market.ticker,
    marketType: market.market_type ?? 'binary',
    status: market.status ?? null,
    yesBid,
    yesAsk,
    lastPrice,
    impliedProbability,
    volume: Number(market.volume_fp ?? 0),
    volume24h: Number(market.volume_24h_fp ?? 0),
    openInterest: Number(market.open_interest_fp ?? 0),
    liquidityDollars: Number(market.liquidity_dollars ?? 0),
    rulesPrimary: market.rules_primary ?? null,
    rulesSecondary: market.rules_secondary ?? null,
    openTime: market.open_time ?? null,
    closeTime: market.close_time ?? null,
    expectedExpirationTime: market.expected_expiration_time ?? null,
    observedAt,
    rawUpdatedAt: market.updated_time ?? null
  });
}

export class KalshiPublicAdapter {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL } = {}) {
    assertFetch(fetchImpl);
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async listMarkets({ status = 'open', limit = 100, cursor, seriesTicker } = {}) {
    const url = new URL(`${this.baseUrl}/markets`);
    if (status) url.searchParams.set('status', status);
    if (limit) url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    if (seriesTicker) url.searchParams.set('series_ticker', seriesTicker);

    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Kalshi markets request failed: ${response.status}`);
    const payload = await response.json();

    return {
      markets: (payload.markets ?? []).map((market) => normalizeKalshiMarket(market)),
      cursor: payload.cursor || null
    };
  }
}
