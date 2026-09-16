function requireString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function observationKey(observation) {
  return `${requireString(observation.provider, 'provider')}:${requireString(observation.sourceId, 'sourceId')}:${requireString(observation.capturedAt, 'capturedAt')}`;
}

function jsonHeaders(apiKey, prefer = null) {
  const headers = {
    apikey: apiKey,
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json'
  };
  if (prefer) headers.prefer = prefer;
  return headers;
}

export class SupabasePredictionsLedger {
  constructor({ url, serviceKey, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    if (!url) throw new TypeError('Supabase url is required');
    if (!serviceKey) throw new TypeError('Supabase serviceKey is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.url = String(url).replace(/\/$/, '');
    this.serviceKey = serviceKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async write(table, row, { conflictColumn = null, merge = false, returnRepresentation = false } = {}) {
    const url = new URL(`${this.url}/rest/v1/${table}`);
    if (conflictColumn) url.searchParams.set('on_conflict', conflictColumn);
    const resolution = merge ? 'merge-duplicates' : 'ignore-duplicates';
    const returning = returnRepresentation ? 'return=representation' : 'return=minimal';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: jsonHeaders(this.serviceKey, `resolution=${resolution},${returning}`),
        body: JSON.stringify(row),
        signal: controller.signal
      });
      const text = typeof response.text === 'function' ? await response.text() : '';
      if (!response.ok) {
        let detail = text;
        try { detail = text ? JSON.parse(text) : null; } catch {}
        const message = detail?.message || detail?.details || `Supabase write failed: ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.detail = detail;
        throw error;
      }
      if (!returnRepresentation || !text) return null;
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  upsertEvent(event) {
    return this.write('pred_events', {
      event_id: requireString(event.eventId ?? event.id, 'eventId'),
      slug: event.slug ?? null,
      canonical_question: requireString(event.canonicalQuestion ?? event.question ?? event.title, 'canonicalQuestion'),
      category: requireString(event.category, 'category'),
      status: event.status || 'open',
      resolution_authority: event.resolutionAuthority ?? null,
      resolution_rule: event.resolutionRule ?? null,
      resolution_time: event.resolutionTime ?? null,
      metadata: event.metadata || {},
      updated_at: new Date().toISOString()
    }, { conflictColumn: 'event_id', merge: true });
  }

  insertSourceObservation(observation) {
    const key = observationKey(observation);
    return this.write('pred_source_observations', {
      observation_key: key,
      provider: observation.provider,
      source_id: observation.sourceId,
      source_class: observation.sourceClass,
      observed_at: observation.observedAt,
      available_at: observation.availableAt,
      captured_at: observation.capturedAt,
      value: observation.value ?? null,
      data: observation.data ?? null,
      units: observation.units ?? null,
      geography: observation.geography ?? null,
      vintage: observation.vintage === null || observation.vintage === undefined ? null : String(observation.vintage),
      revision: observation.revision === null || observation.revision === undefined ? null : String(observation.revision),
      provenance: observation.provenance || {}
    }, { conflictColumn: 'observation_key' }).then(() => key);
  }

  insertFeatureSnapshot(snapshot, { context = {}, quality = {} } = {}) {
    return this.write('pred_feature_snapshots', {
      snapshot_id: requireString(snapshot.id, 'snapshot.id'),
      event_id: requireString(snapshot.eventId, 'snapshot.eventId'),
      model_id: requireString(snapshot.modelId, 'snapshot.modelId'),
      cutoff_at: requireString(snapshot.cutoffAt, 'snapshot.cutoffAt'),
      created_at: requireString(snapshot.createdAt, 'snapshot.createdAt'),
      features: snapshot.features || {},
      source_classes: [...(snapshot.sourceClasses || [])],
      source_observation_keys: [...(snapshot.sourceObservationIds || [])],
      context,
      quality
    }, { conflictColumn: 'snapshot_id' }).then(() => snapshot.id);
  }

  insertForecast(forecast, { recordId, recordType = 'live' } = {}) {
    return this.write('pred_forecasts', {
      record_id: requireString(recordId, 'recordId'),
      event_id: requireString(forecast.eventId, 'forecast.eventId'),
      model_id: requireString(forecast.modelId, 'forecast.modelId'),
      model_version: requireString(forecast.modelVersion, 'forecast.modelVersion'),
      probability: Number(forecast.probability),
      captured_at: requireString(forecast.capturedAt, 'forecast.capturedAt'),
      feature_snapshot_id: forecast.featureSnapshotId || null,
      record_type: recordType,
      provenance: forecast.provenance || [],
      explanation: forecast.explanation || null,
      metadata: forecast.metadata || {}
    }, { conflictColumn: 'record_id' }).then(() => recordId);
  }

  insertVenueSnapshot(snapshot) {
    return this.write('pred_venue_snapshots', {
      snapshot_key: requireString(snapshot.snapshotKey, 'snapshotKey'),
      event_id: requireString(snapshot.eventId, 'eventId'),
      venue: requireString(snapshot.venue, 'venue'),
      market_id: requireString(snapshot.marketId, 'marketId'),
      captured_at: requireString(snapshot.capturedAt, 'capturedAt'),
      probability: snapshot.probability ?? null,
      bid: snapshot.bid ?? null,
      ask: snapshot.ask ?? null,
      volume: snapshot.volume ?? null,
      open_interest: snapshot.openInterest ?? null,
      liquidity: snapshot.liquidity ?? null,
      raw: snapshot.raw || {}
    }, { conflictColumn: 'snapshot_key' }).then(() => snapshot.snapshotKey);
  }

  insertResolution(resolution) {
    return this.write('pred_resolutions', {
      event_id: requireString(resolution.eventId, 'eventId'),
      resolved_at: requireString(resolution.resolvedAt, 'resolvedAt'),
      authority: requireString(resolution.authority, 'authority'),
      source_url: resolution.sourceUrl || null,
      outcome: resolution.outcome,
      correction_of: resolution.correctionOf || null,
      metadata: resolution.metadata || {}
    }, { returnRepresentation: true }).then((rows) => rows?.[0] || null);
  }

  insertScore(score) {
    return this.write('pred_scores', {
      forecast_id: requireString(score.forecastId, 'forecastId'),
      resolution_id: requireString(score.resolutionId, 'resolutionId'),
      scoring_method: requireString(score.scoringMethod, 'scoringMethod'),
      score: Number(score.score),
      benchmark_score: score.benchmarkScore ?? null,
      improvement: score.improvement ?? null,
      details: score.details || {},
      scored_at: score.scoredAt || new Date().toISOString()
    }, { returnRepresentation: true }).then((rows) => rows?.[0] || null);
  }
}

export { observationKey as sourceObservationKey };
