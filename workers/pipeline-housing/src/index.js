import { fail, ok, requireFields } from '../../_shared/contract.js';

async function callBinding(binding, path, body, label) {
  if (!binding || typeof binding.fetch !== 'function') throw new TypeError(`${label} service binding is required`);
  const response = await binding.fetch(`https://internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error?.message || payload?.error || `${label} failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function featureSnapshotId(eventId, cutoffAt) {
  return `housing:${eventId}:${cutoffAt}`;
}

function forecastRecordId(eventId, modelVersion, capturedAt) {
  return `pbe:${eventId}:${modelVersion}:${capturedAt}`;
}

function sourceRequest(body, extra = {}) {
  return {
    ...extra,
    ...(body.cutoffAt ? { forecastCutoff: body.cutoffAt } : {})
  };
}

function optionalBinding(binding, label, body, path = '/') {
  return binding
    ? callBinding(binding, path, body, label).catch((error) => ({ optionalError: error.message }))
    : Promise.resolve({ optionalError: `${label} binding not configured` });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const body = await request.json();
      requireFields(body, ['event', 'location']);
      requireFields(body.event, ['id', 'question', 'threshold']);

      const event = {
        ...body.event,
        category: body.event.category || 'housing',
        status: body.event.status || 'open'
      };
      const state = String(body.location?.state || body.event?.geography?.state || '').trim().toUpperCase();
      if (!state || !/^[A-Z]{2}$/.test(state)) throw new TypeError('location.state or event.geography.state must be a 2-letter code');

      await callBinding(env.LEDGER, '/event', {
        eventId: event.id,
        slug: event.slug || null,
        canonicalQuestion: event.question,
        category: event.category,
        status: event.status,
        resolutionAuthority: event.resolutionAuthority || null,
        resolutionRule: event.resolutionRule || null,
        resolutionTime: event.resolutionTime || null,
        metadata: { geography: event.geography || body.location, pipeline: 'housing' }
      }, 'LEDGER');

      const marketPromise = callBinding(env.SOURCE_PROPDATA, '/', sourceRequest(body, {
        mode: 'market',
        location: body.location
      }), 'SOURCE_PROPDATA market');
      const statePromise = callBinding(env.SOURCE_PROPDATA, '/', sourceRequest(body, {
        mode: 'state_intel',
        state
      }), 'SOURCE_PROPDATA state_intel');
      const censusPromise = optionalBinding(env.SOURCE_CENSUS, 'SOURCE_CENSUS', sourceRequest(body, {
        geography: body.location.zip ? { zip: body.location.zip } : { state }
      }));
      const hpiPromise = optionalBinding(env.SOURCE_HOUSING_HISTORY, 'SOURCE_HOUSING_HISTORY', sourceRequest(body, {
        geography: { state },
        limit: 8
      }));
      const mortgagePromise = optionalBinding(env.SOURCE_MACRO, 'SOURCE_MACRO mortgage30', sourceRequest(body, {
        seriesKey: 'mortgage30',
        limit: 2,
        outputUnits: 'percent'
      }));
      const zoriPromise = optionalBinding(env.SOURCE_ZORI, 'SOURCE_ZORI', sourceRequest(body, {
        geography: body.location.metro
          ? { metro: body.location.metro, regionId: body.location.zillowRegionId || null }
          : { state }
      }));
      const permitsPromise = optionalBinding(env.SOURCE_PERMITS, 'SOURCE_PERMITS', sourceRequest(body, {
        geography: body.location.cbsa ? { cbsa: body.location.cbsa } : { state },
        maxProbeMonths: 5
      }));

      const [marketResult, stateResult, censusResult, hpiResult, mortgageResult, zoriResult, permitsResult] = await Promise.all([
        marketPromise,
        statePromise,
        censusPromise,
        hpiPromise,
        mortgagePromise,
        zoriPromise,
        permitsPromise
      ]);

      const observations = [marketResult.data, stateResult.data];
      const warnings = [];
      const optionalResults = [
        ['Census context', censusResult],
        ['Retained HPI', hpiResult],
        ['Official mortgage history', mortgageResult],
        ['Zillow ZORI', zoriResult],
        ['Census BPS permits', permitsResult]
      ];
      for (const [label, result] of optionalResults) {
        if (result?.data) observations.push(result.data);
        else if (result?.optionalError) warnings.push(`${label} unavailable: ${result.optionalError}`);
      }

      await Promise.all(observations.map((observation) => callBinding(env.LEDGER, '/source', observation, 'LEDGER source')));

      const cutoffAt = body.cutoffAt || new Date().toISOString();
      const snapshotId = featureSnapshotId(event.id, cutoffAt);
      const featureResult = await callBinding(env.FEATURE_HOUSING, '/', {
        id: snapshotId,
        eventId: event.id,
        cutoffAt,
        observations
      }, 'FEATURE_HOUSING');

      await callBinding(env.LEDGER, '/feature', {
        snapshot: featureResult.data,
        context: featureResult.meta?.context || {},
        quality: featureResult.meta?.quality || {}
      }, 'LEDGER feature');

      const provenance = observations.map((observation) => ({
        provider: observation.provider,
        sourceId: observation.sourceId,
        sourceClass: observation.sourceClass,
        capturedAt: observation.capturedAt,
        vintage: observation.vintage || null
      }));

      const modelResult = await callBinding(env.MODEL_HOUSING, '/', {
        event: {
          id: event.id,
          threshold: event.threshold,
          direction: event.direction || 'above',
          eventType: event.eventType || 'housing',
          geography: event.geography || body.location
        },
        features: featureResult.data.features,
        featureSnapshotId: featureResult.data.id,
        provenance
      }, 'MODEL_HOUSING');

      const forecast = modelResult.data;
      const recordType = body.recordType || 'research';
      const recordId = body.recordId || forecastRecordId(event.id, forecast.modelVersion, forecast.capturedAt);
      await callBinding(env.LEDGER, '/forecast', {
        forecast,
        recordId,
        recordType
      }, 'LEDGER forecast');

      return ok({
        eventId: event.id,
        recordId,
        recordType,
        cutoffAt,
        forecast,
        featureSnapshot: featureResult.data,
        sourceObservations: observations.map((observation) => ({
          provider: observation.provider,
          sourceId: observation.sourceId,
          sourceClass: observation.sourceClass,
          capturedAt: observation.capturedAt,
          vintage: observation.vintage || null
        })),
        warnings
      }, {
        pipeline: 'housing',
        persisted: true,
        retainedHpiUsed: Boolean(hpiResult?.data),
        retainedMortgageUsed: Boolean(mortgageResult?.data),
        retainedZoriUsed: Boolean(zoriResult?.data),
        retainedPermitsUsed: Boolean(permitsResult?.data),
        modelStatus: forecast.metadata?.modelStatus || 'research'
      });
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 422;
      return fail('HOUSING_PIPELINE_FAILED', error.message, status, error.payload || null);
    }
  }
};
