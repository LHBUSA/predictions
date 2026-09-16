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

function parseNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    subtitle: market.subtitle ?? null,
    marketType: market.market_type ?? 'binary',
    status: market.status ?? null,
    yesBid,
    yesAsk,
    lastPrice,
    impliedProbability,
    volume: parseNumber(market.volume_fp),
    volume24h: parseNumber(market.volume_24h_fp),
    openInterest: parseNumber(market.open_interest_fp),
    liquidityDollars: parseNumber(market.liquidity_dollars),
    result: market.result ?? null,
    settlementValue: parseProbability(market.settlement_value_dollars),
    settlementTs: market.settlement_ts ?? null,
    expirationValue: market.expiration_value ?? null,
    occurrenceDatetime: market.occurrence_datetime ?? null,
    strikeType: market.strike_type ?? null,
    floorStrike: market.floor_strike ?? null,
    capStrike: market.cap_strike ?? null,
    functionalStrike: market.functional_strike ?? null,
    rulesPrimary: market.rules_primary ?? null,
    rulesSecondary: market.rules_secondary ?? null,
    openTime: market.open_time ?? null,
    closeTime: market.close_time ?? null,
    expectedExpirationTime: market.expected_expiration_time ?? null,
    observedAt,
    rawUpdatedAt: market.updated_time ?? null,
    isProvisional: Boolean(market.is_provisional)
  });
}

export function normalizeKalshiCandlestick(candle) {
  const endPeriodTs = Number(candle?.end_period_ts);
  if (!Number.isFinite(endPeriodTs)) throw new TypeError('Kalshi candlestick end_period_ts is required');
  const yesBidClose = parseProbability(candle?.yes_bid?.close);
  const yesAskClose = parseProbability(candle?.yes_ask?.close);
  const priceClose = parseProbability(candle?.price?.close);
  const impliedProbability = midpoint(yesBidClose, yesAskClose, priceClose);

  return Object.freeze({
    endPeriodTs,
    endPeriodAt: new Date(endPeriodTs * 1000).toISOString(),
    yesBidClose,
    yesAskClose,
    priceClose,
    impliedProbability,
    volume: parseNumber(candle?.volume),
    openInterest: parseNumber(candle?.open_interest)
  });
}

export function selectKalshiCandlestickAtOrBefore(candles, cutoffAt) {
  if (!Array.isArray(candles)) throw new TypeError('candles must be an array');
  const cutoffMs = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoffMs)) throw new TypeError('cutoffAt must be a valid timestamp');
  const cutoffSeconds = Math.floor(cutoffMs / 1000);

  const eligible = candles
    .filter((row) => Number(row?.endPeriodTs) <= cutoffSeconds)
    .sort((a, b) => Number(b.endPeriodTs) - Number(a.endPeriodTs));
  return eligible[0] ?? null;
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

  async listHistoricalMarkets({ limit = 100, cursor, tickers, eventTicker, seriesTicker, mveFilter = 'exclude' } = {}) {
    const filters = [tickers, eventTicker, seriesTicker].filter(Boolean);
    if (filters.length > 1) throw new TypeError('historical market filters tickers, eventTicker, and seriesTicker are mutually exclusive');
    const url = new URL(`${this.baseUrl}/historical/markets`);
    if (limit) url.searchParams.set('limit', String(Math.min(1000, Number(limit))));
    if (cursor) url.searchParams.set('cursor', cursor);
    if (tickers) url.searchParams.set('tickers', Array.isArray(tickers) ? tickers.join(',') : String(tickers));
    if (eventTicker) url.searchParams.set('event_ticker', eventTicker);
    if (seriesTicker) url.searchParams.set('series_ticker', seriesTicker);
    if (mveFilter) url.searchParams.set('mve_filter', mveFilter);

    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Kalshi historical markets request failed: ${response.status}`);
    const payload = await response.json();
    return {
      markets: (payload.markets ?? []).map((market) => normalizeKalshiMarket(market)),
      cursor: payload.cursor || null
    };
  }

  async historicalCandlesticks(ticker, { startTs, endTs, periodInterval = 60 } = {}) {
    if (!ticker) throw new TypeError('ticker is required');
    const start = Number(startTs);
    const end = Number(endTs);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new TypeError('startTs and endTs must be Unix timestamps');
    if (![1, 60, 1440].includes(Number(periodInterval))) throw new RangeError('periodInterval must be 1, 60, or 1440');
    const url = new URL(`${this.baseUrl}/historical/markets/${encodeURIComponent(ticker)}/candlesticks`);
    url.searchParams.set('start_ts', String(Math.floor(start)));
    url.searchParams.set('end_ts', String(Math.floor(end)));
    url.searchParams.set('period_interval', String(Number(periodInterval)));

    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Kalshi historical candlesticks request failed: ${response.status}`);
    const payload = await response.json();
    return Object.freeze({
      ticker: payload.ticker ?? ticker,
      candlesticks: Object.freeze((payload.candlesticks ?? []).map(normalizeKalshiCandlestick))
    });
  }
}
