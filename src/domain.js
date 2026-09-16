export const EVENT_CATEGORIES = Object.freeze([
  'macro',
  'housing',
  'weather',
  'companies',
  'crypto',
  'culture',
  'geopolitics',
  'other'
]);

export function assertProbability(value, field = 'probability') {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${field} must be a finite number between 0 and 1`);
  }
}

export function createCanonicalEvent(input) {
  const required = ['id', 'title', 'category', 'resolutionRule', 'resolutionSource'];
  for (const field of required) {
    if (!input?.[field]) throw new TypeError(`canonical event missing ${field}`);
  }
  if (!EVENT_CATEGORIES.includes(input.category)) {
    throw new RangeError(`unsupported event category: ${input.category}`);
  }

  return Object.freeze({
    id: input.id,
    title: input.title,
    category: input.category,
    description: input.description ?? null,
    opensAt: input.opensAt ?? null,
    closesAt: input.closesAt ?? null,
    resolvesAt: input.resolvesAt ?? null,
    resolutionRule: input.resolutionRule,
    resolutionSource: input.resolutionSource,
    venueContracts: Object.freeze([...(input.venueContracts ?? [])]),
    metadata: Object.freeze({ ...(input.metadata ?? {}) })
  });
}

export function createPredictionSnapshot(input) {
  const required = ['id', 'eventId', 'modelId', 'modelVersion', 'capturedAt', 'modelProbability'];
  for (const field of required) {
    if (input?.[field] === undefined || input?.[field] === null || input?.[field] === '') {
      throw new TypeError(`prediction snapshot missing ${field}`);
    }
  }

  assertProbability(input.modelProbability, 'modelProbability');
  if (input.marketProbability !== null && input.marketProbability !== undefined) {
    assertProbability(input.marketProbability, 'marketProbability');
  }

  return Object.freeze({
    id: input.id,
    eventId: input.eventId,
    modelId: input.modelId,
    modelVersion: input.modelVersion,
    capturedAt: input.capturedAt,
    modelProbability: input.modelProbability,
    marketProbability: input.marketProbability ?? null,
    confidence: input.confidence ?? null,
    featureSnapshotId: input.featureSnapshotId ?? null,
    explanation: input.explanation ?? null,
    provenance: Object.freeze([...(input.provenance ?? [])]),
    metadata: Object.freeze({ ...(input.metadata ?? {}) })
  });
}

export function probabilityGap(snapshot) {
  if (snapshot.marketProbability === null || snapshot.marketProbability === undefined) return null;
  return snapshot.modelProbability - snapshot.marketProbability;
}
