import { fail, ok, requireFields } from '../../_shared/contract.js';
import { FredAdapter, FRED_SERIES } from '../../../src/fred.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

function endOfVintageDay(date) {
  return `${date}T23:59:59.999Z`;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'POST required', 405);
    if (!env.FRED_API_KEY) return fail('SOURCE_NOT_CONFIGURED', 'FRED_API_KEY is not configured', 503);
    try {
      const body = await request.json();
      requireFields(body, ['seriesKey']);
      const seriesId = FRED_SERIES[body.seriesKey];
      if (!seriesId) return fail('UNSUPPORTED_SERIES', `Unsupported FRED series key ${body.seriesKey}`, 422);

      const adapter = new FredAdapter({ apiKey: env.FRED_API_KEY });
      const vintageDate = body.vintageDate || null;
      const payload = await adapter.observations(seriesId, {
        limit: body.limit || 12,
        sortOrder: 'desc',
        realtimeStart: vintageDate || undefined,
        realtimeEnd: vintageDate || undefined,
        units: body.units || undefined,
        outputType: 1
      });
      const row = payload.observations.find(x => x.value !== null);
      if (!row) return fail('NO_SOURCE_VALUE', `No non-null observation found for ${seriesId}`, 404);

      const availabilityDate = row.realtimeStart || payload.realtimeStart || vintageDate;
      if (!availabilityDate) return fail('UNKNOWN_AVAILABILITY', 'FRED response did not expose a real-time availability date', 422);
      const observation = createSourceObservation({
        provider: 'FRED',
        sourceId: seriesId,
        sourceClass: 'official',
        observedAt: `${row.date}T00:00:00.000Z`,
        availableAt: endOfVintageDay(availabilityDate),
        capturedAt: new Date().toISOString(),
        value: row.value,
        units: body.outputUnits || body.units || null,
        vintage: availabilityDate,
        provenance: {
          seriesKey: body.seriesKey,
          realtimeStart: row.realtimeStart,
          realtimeEnd: row.realtimeEnd,
          availabilityPrecision: 'date-conservative',
          note: 'FRED real-time dates do not encode release time; availability is conservatively treated as end-of-day.'
        }
      });
      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, { seriesKey: body.seriesKey, seriesId, vintageDate });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message) ? 'POST_CUTOFF_SOURCE' : 'SOURCE_FETCH_FAILED';
      return fail(code, error.message, 422);
    }
  }
};
