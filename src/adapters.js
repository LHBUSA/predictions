export class MarketAdapter {
  constructor(name) {
    if (!name) throw new TypeError('market adapter requires a name');
    this.name = name;
  }

  async discoverActiveMarkets() {
    throw new Error('discoverActiveMarkets() not implemented');
  }

  async fetchMarketSnapshot() {
    throw new Error('fetchMarketSnapshot() not implemented');
  }

  async fetchResolution() {
    throw new Error('fetchResolution() not implemented');
  }
}

export class DataAdapter {
  constructor(name) {
    if (!name) throw new TypeError('data adapter requires a name');
    this.name = name;
  }

  async fetchFeatures() {
    throw new Error('fetchFeatures() not implemented');
  }
}

export function createProvenanceRecord(input) {
  const required = ['sourceId', 'sourceName', 'retrievedAt'];
  for (const field of required) {
    if (!input?.[field]) throw new TypeError(`provenance record missing ${field}`);
  }

  return Object.freeze({
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    sourceUrl: input.sourceUrl ?? null,
    retrievedAt: input.retrievedAt,
    observedAt: input.observedAt ?? null,
    field: input.field ?? null,
    valueHash: input.valueHash ?? null,
    license: input.license ?? null,
    metadata: Object.freeze({ ...(input.metadata ?? {}) })
  });
}
