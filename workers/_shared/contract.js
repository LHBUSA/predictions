export function ok(data, meta = {}) {
  return Response.json({ ok: true, data, meta });
}

export function fail(code, message, status = 400, details = null) {
  return Response.json({ ok: false, error: { code, message, details } }, { status });
}

export function requireFields(input, fields) {
  for (const field of fields) {
    if (input?.[field] === undefined || input?.[field] === null || input?.[field] === '') {
      throw new TypeError(`missing ${field}`);
    }
  }
}

export function forecastEnvelope({ eventId, modelId, modelVersion, probability, capturedAt, featureSnapshotId = null, provenance = [], explanation = null, metadata = {} }) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new RangeError('probability must be between 0 and 1');
  return Object.freeze({ eventId, modelId, modelVersion, probability, capturedAt, featureSnapshotId, provenance, explanation, metadata });
}
