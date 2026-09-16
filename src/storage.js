function stableId(parts) {
  return parts.map((part) => String(part ?? '')).join(':');
}

export class InMemorySnapshotStore {
  #marketSnapshots = new Map();
  #predictionSnapshots = new Map();
  #sourceSnapshots = new Map();

  appendMarket(snapshot) {
    const key = stableId([snapshot.venue, snapshot.marketId, snapshot.observedAt]);
    if (this.#marketSnapshots.has(key)) throw new Error(`duplicate market snapshot: ${key}`);
    this.#marketSnapshots.set(key, Object.freeze({ ...snapshot }));
    return key;
  }

  appendPrediction(snapshot) {
    const key = stableId([snapshot.eventId, snapshot.modelVersion, snapshot.observedAt]);
    if (this.#predictionSnapshots.has(key)) throw new Error(`duplicate prediction snapshot: ${key}`);
    this.#predictionSnapshots.set(key, Object.freeze({ ...snapshot }));
    return key;
  }

  appendSource(snapshot) {
    const key = stableId([snapshot.provider, snapshot.seriesId ?? snapshot.sourceId, snapshot.fetchedAt ?? snapshot.observedAt]);
    if (this.#sourceSnapshots.has(key)) throw new Error(`duplicate source snapshot: ${key}`);
    this.#sourceSnapshots.set(key, Object.freeze({ ...snapshot }));
    return key;
  }

  listMarketSnapshots() { return [...this.#marketSnapshots.values()]; }
  listPredictionSnapshots() { return [...this.#predictionSnapshots.values()]; }
  listSourceSnapshots() { return [...this.#sourceSnapshots.values()]; }
}

export class JsonlSnapshotStore {
  constructor({ appendFile }) {
    if (typeof appendFile !== 'function') throw new TypeError('appendFile must be a function');
    this.appendFile = appendFile;
  }

  append(stream, snapshot) {
    return this.appendFile(`${stream}.jsonl`, `${JSON.stringify(snapshot)}\n`);
  }
}
