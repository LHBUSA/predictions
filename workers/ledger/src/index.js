import { fail, ok } from '../../_shared/contract.js';
import { SupabasePredictionsLedger } from '../../../src/supabase-ledger.js';

function ledgerFor(env) {
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY;
  if (!url) throw new TypeError('SUPABASE_URL is required');
  if (!serviceKey) throw new TypeError('SUPABASE_SERVICE_KEY or SUPABASE_KEY is required');
  return new SupabasePredictionsLedger({ url, serviceKey });
}

function route(path) {
  return String(path || '').replace(/\/+$/, '') || '/';
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    try {
      const path = route(new URL(request.url).pathname);
      const body = await request.json();
      const ledger = ledgerFor(env);

      if (path === '/event') {
        await ledger.upsertEvent(body);
        return ok({ eventId: body.eventId || body.id }, { persisted: true, kind: 'event' });
      }
      if (path === '/source') {
        const key = await ledger.insertSourceObservation(body);
        return ok({ observationKey: key }, { persisted: true, appendOnly: true, kind: 'source_observation' });
      }
      if (path === '/sources') {
        const observations = Array.isArray(body) ? body : body.observations;
        const keys = await ledger.insertSourceObservations(observations);
        return ok({ observationKeys: keys, count: keys.length }, { persisted: true, appendOnly: true, kind: 'source_observation_batch' });
      }
      if (path === '/feature') {
        const id = await ledger.insertFeatureSnapshot(body.snapshot || body, {
          context: body.context || {},
          quality: body.quality || {}
        });
        return ok({ snapshotId: id }, { persisted: true, appendOnly: true, kind: 'feature_snapshot' });
      }
      if (path === '/forecast') {
        const recordId = await ledger.insertForecast(body.forecast || body, {
          recordId: body.recordId || body.forecast?.recordId,
          recordType: body.recordType || 'live'
        });
        return ok({ recordId }, { persisted: true, appendOnly: true, kind: 'forecast' });
      }
      if (path === '/venue') {
        const key = await ledger.insertVenueSnapshot(body);
        return ok({ snapshotKey: key }, { persisted: true, appendOnly: true, kind: 'venue_snapshot' });
      }
      if (path === '/resolution') {
        const row = await ledger.insertResolution(body);
        return ok(row, { persisted: true, appendOnly: true, kind: 'resolution' });
      }
      if (path === '/score') {
        const row = await ledger.insertScore(body);
        return ok(row, { persisted: true, appendOnly: true, kind: 'score' });
      }
      return fail('NOT_FOUND', 'POST /event, /source, /sources, /feature, /forecast, /venue, /resolution, or /score', 404);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 422;
      return fail('LEDGER_WRITE_FAILED', error.message, status, error.detail || null);
    }
  }
};
