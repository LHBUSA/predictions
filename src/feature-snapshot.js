import { assertAvailableBefore } from './source-observation.js';

function iso(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return d.toISOString();
}

export function createFeatureSnapshot({ id, eventId, modelId, cutoffAt, createdAt = new Date().toISOString(), features, observations = [] }) {
  if (!id) throw new TypeError('id is required');
  if (!eventId) throw new TypeError('eventId is required');
  if (!modelId) throw new TypeError('modelId is required');
  if (!features || typeof features !== 'object' || Array.isArray(features)) throw new TypeError('features must be an object');
  const cutoff = iso(cutoffAt, 'cutoffAt');
  const created = iso(createdAt, 'createdAt');
  const checked = observations.map(observation => assertAvailableBefore(observation, cutoff));
  const sourceClasses = [...new Set(checked.map(x => x.sourceClass))];
  return Object.freeze({
    id,
    eventId,
    modelId,
    cutoffAt: cutoff,
    createdAt: created,
    features: Object.freeze({ ...features }),
    sourceObservationIds: Object.freeze(checked.map(x => `${x.provider}:${x.sourceId}:${x.capturedAt}`)),
    sourceClasses: Object.freeze(sourceClasses),
    observations: Object.freeze([...checked])
  });
}
