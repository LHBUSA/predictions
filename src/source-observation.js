const SOURCE_CLASSES = new Set(['propdata','sports','official','venue','licensed','research','proprietary']);

function iso(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return d.toISOString();
}

export function createSourceObservation({
  provider,
  sourceId,
  sourceClass,
  observedAt,
  availableAt,
  capturedAt = new Date().toISOString(),
  value = null,
  data = null,
  units = null,
  geography = null,
  vintage = null,
  revision = null,
  provenance = {}
}) {
  if (!provider) throw new TypeError('provider is required');
  if (!sourceId) throw new TypeError('sourceId is required');
  if (!SOURCE_CLASSES.has(sourceClass)) throw new TypeError(`unsupported sourceClass ${sourceClass}`);
  const observed = iso(observedAt ?? availableAt ?? capturedAt, 'observedAt');
  const available = iso(availableAt ?? capturedAt, 'availableAt');
  const captured = iso(capturedAt, 'capturedAt');
  if (Date.parse(available) > Date.parse(captured)) throw new RangeError('availableAt cannot be after capturedAt');

  return Object.freeze({
    provider,
    sourceId,
    sourceClass,
    observedAt: observed,
    availableAt: available,
    capturedAt: captured,
    value,
    data,
    units,
    geography,
    vintage,
    revision,
    provenance: Object.freeze({ ...provenance })
  });
}

export function assertAvailableBefore(observation, cutoff) {
  const cut = iso(cutoff, 'cutoff');
  if (Date.parse(observation.availableAt) > Date.parse(cut)) {
    throw new RangeError(`source ${observation.provider}:${observation.sourceId} was not available before forecast cutoff`);
  }
  return observation;
}
