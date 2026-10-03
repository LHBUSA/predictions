// THE MARKET MUST NOT LEAK INTO THE MODEL (owner 2026-10-03, expanded for Polymarket / multi-venue).
// PBE models are independent of BOTH venues (Kalshi, Polymarket): prediction-market prices are benchmark /
// context only. Feature vectors may only be built from allowlisted domain sources and may never carry a
// venue-derived key at any depth: price, bid, ask, midpoint, spread, order book / depth, last trade, volume,
// liquidity, open interest, venue consensus, token / condition ids, CLOB / Gamma payloads.
// Reference: propbetedge-workers workers/propsports-markets/src/leakage-guard.js. The database CHECK
// pred_features_market_free (sql/004) is GENERATED from MARKET_KEY_PATTERN (scripts/db/gen-market-free-sql.mjs;
// test/leakage-db-parity.test.js fails on drift): changing the pattern = regenerate + a new migration. This
// module runs before any value reaches a model function; the CHECK backstops every stored feature vector.
//
// Names that are legitimate domain features and must stay allowed (pinned by test/leakage-guard.test.js):
// nbm_max_temp_spread_f (NBM ensemble spread, degF), cmt6m_minus_target_mid (Fed target-range midpoint).
// Hence 'spread' and 'mid' are matched only in their venue forms, never as bare substrings.
export const MARKET_KEY_PATTERN = new RegExp([
  'kalshi', 'polymarket', 'prediction_?market', 'market', 'venue', 'consensus', 'clob', 'gamma',
  'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'best_?bid', 'best_?ask',
  '(?:^|_)bids?(?:_|$)', '(?:^|_)asks?(?:_|$)', 'bid_?ask',
  'mid_?point', 'mid_?price', 'mid_?prob', 'mid_bp', 'mid_cents', '^mid(?:_|$)',
  '^spread(?:_|$)', 'spread_(?:bp|bps|cents|dollars|pts|prob)', '(?:price|book|yes|no|quote)_spread',
  'order_?book', 'book_hash', '(?:book|order|market)_depth', '^depth(?:_|$)',
  'last_?trade', 'last_?price', 'outcome_?prices?', 'open_interest', 'liquidity', 'implied_prob',
  'settlement', 'resolution_value', 'traded', 'volume',
  'outcome_?token', 'token_?ids?', 'condition_?id',
].join('|'), 'i');

// Where a feature's value came from. Any of these in a source's provider / sourceId / observationKey means
// the value was read from a prediction-market venue or the markets service, and is refused.
export const VENUE_SOURCE_PATTERN = /(kalshi|polymarket|clob\.|gamma-api|prediction[- ]market|propsports-markets|market_intel_|market_venue_|pred_venue_|\/admin\/kalshi)/i;

// Tables whose rows are venue data. A model input query may never read them.
export const MARKET_TABLE_PATTERN = /^(market_|algo_market_|pred_venue_|kalshi|polymarket)/i;

// Fields that carry a venue PRICE / size on a contract row. A contract handed to a model is terms only
// (strike, window, station, rules); its price lives in the venue snapshot and is attached after forecasting.
export const CONTRACT_PRICE_PATTERN = /(bid|ask|_price|price_|^price$|mid_?point|^mid$|^spread$|_dollars$|_fp$|volume|open_interest|liquidity|order_?book|last_trade|implied_prob|probability|token_id|condition_id|polymarket|clob)/i;

// Source classes a PBE feature may come from. 'venue' (prediction-market pricing) is deliberately absent.
export const MODEL_SOURCE_CLASSES = Object.freeze(['official', 'research', 'propdata', 'sports', 'proprietary', 'licensed']);

export class MarketLeakageError extends Error {
  constructor(path) {
    super(`market-derived field "${path}" cannot enter a PBE feature vector`);
    this.name = 'MarketLeakageError';
    this.path = path;
  }
}

function findKeys(value, pattern, path) {
  const hits = [];
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findKeys(v, pattern, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}.${k}`;
      if (pattern.test(k)) hits.push(p);
      hits.push(...findKeys(v, pattern, p));
    }
  }
  return hits;
}

export function findMarketKeys(value, path = '$') {
  return findKeys(value, MARKET_KEY_PATTERN, path);
}

export function assertMarketFree(features) {
  const hits = findMarketKeys(features);
  if (hits.length) throw new MarketLeakageError(hits[0]);
  return features;
}

// The exact argument object handed to a model function (predictPrecip, bucketProbability, predictFed,
// simulateExtremes). Same denylist as a feature vector; returns its input unchanged.
export const assertModelInput = assertMarketFree;

// A normalized contract handed to a forecast engine: terms only, no venue price / size at any depth.
export function assertContractTermsOnly(contract) {
  const hits = findKeys(contract, CONTRACT_PRICE_PATTERN, '$contract');
  if (hits.length) throw new MarketLeakageError(hits[0]);
  return contract;
}

export function assertModelSource(source, name = 'source') {
  for (const field of ['provider', 'sourceId', 'observationKey']) {
    const v = source?.[field];
    if (v != null && VENUE_SOURCE_PATTERN.test(String(v))) throw new MarketLeakageError(`${name} (${field} ${v})`);
  }
  return source;
}

// A PostgREST path ('table?select=...') a model input reads from.
export function assertModelSourceTable(path) {
  const table = String(path).split('?')[0];
  if (MARKET_TABLE_PATTERN.test(table)) throw new MarketLeakageError(`table ${table}`);
  return table;
}

// Every feature is declared with the source observation it came from; venue-class sources are refused.
export function buildFeatureVector(entries) {
  const features = {};
  const sources = [];
  for (const { name, value, source } of entries) {
    if (!source?.sourceClass || !MODEL_SOURCE_CLASSES.includes(source.sourceClass)) {
      throw new MarketLeakageError(`${name} (source class ${source?.sourceClass ?? 'missing'})`);
    }
    if (MARKET_KEY_PATTERN.test(name)) throw new MarketLeakageError(name);
    assertModelSource(source, name);
    features[name] = value;
    sources.push({ feature: name, sourceClass: source.sourceClass, provider: source.provider, sourceId: source.sourceId, observationKey: source.observationKey ?? null });
  }
  assertMarketFree(features);
  return Object.freeze({ features: Object.freeze(features), featureSources: Object.freeze(sources) });
}
