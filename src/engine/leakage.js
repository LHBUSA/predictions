// THE MARKET MUST NOT LEAK INTO THE MODEL.
// Feature vectors may only be built from allowlisted domain sources, and may never carry a market-derived
// key at any depth. Mirrors the database CHECK pred_features_market_free (sql/002). Kalshi price, order
// book, volume, open interest, price direction and price history are comparison data only.

export const MARKET_KEY_PATTERN = /(kalshi|market|venue|yes_bid|yes_ask|no_bid|no_ask|last_price|order_?book|open_interest|liquidity|implied_prob|settlement|traded|volume)/i;

// Source classes a PBE feature may come from. 'venue' (prediction-market pricing) is deliberately absent.
export const MODEL_SOURCE_CLASSES = Object.freeze(['official', 'research', 'propdata', 'sports', 'proprietary', 'licensed']);

export class MarketLeakageError extends Error {
  constructor(path) {
    super(`market-derived field "${path}" cannot enter a PBE feature vector`);
    this.name = 'MarketLeakageError';
    this.path = path;
  }
}

export function findMarketKeys(value, path = '$') {
  const hits = [];
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findMarketKeys(v, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}.${k}`;
      if (MARKET_KEY_PATTERN.test(k)) hits.push(p);
      hits.push(...findMarketKeys(v, p));
    }
  }
  return hits;
}

export function assertMarketFree(features) {
  const hits = findMarketKeys(features);
  if (hits.length) throw new MarketLeakageError(hits[0]);
  return features;
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
    features[name] = value;
    sources.push({ feature: name, sourceClass: source.sourceClass, provider: source.provider, sourceId: source.sourceId, observationKey: source.observationKey ?? null });
  }
  assertMarketFree(features);
  return Object.freeze({ features: Object.freeze(features), featureSources: Object.freeze(sources) });
}
