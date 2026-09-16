import { fail, ok, requireFields } from '../../_shared/contract.js';
import { FredAdapter, FRED_SERIES } from '../../../src/fred.js';
import { assertAvailableBefore, createSourceObservation } from '../../../src/source-observation.js';

function endOfVintageDay(date) {
  return `${date}T23:59:59.999Z`;
}

function compactRow(row) {
  if (!row) return null;
  return Object.freeze({
    date: row.date,
    value: row.value,
    realtimeStart: row.realtimeStart || null,
    realtimeEnd: row.realtimeEnd || null
  });
}

function availabilityFor(seriesKey, row, payload, vintageDate) {
  if (seriesKey === 'mortgage30' && row?.date) {
    return Object.freeze({
      date: row.date,
      basis: 'observation-date',
      note: 'MORTGAGE30US is a weekly Freddie Mac/FRED release; the observation date is used as the conservative availability date.'
    });
  }
  const date = row?.realtimeStart || payload?.realtimeStart || vintageDate || null;
  return Object.freeze({
    date,
    basis: 'fred-realtime-date',
    note: 'FRED real-time dates do not encode release time; availability is conservatively treated as end-of-day.'
  });
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
      const rows = payload.observations.filter((item) => item.value !== null);
      const row = rows[0] || null;
      if (!row) return fail('NO_SOURCE_VALUE', `No non-null observation found for ${seriesId}`, 404);

      const availability = availabilityFor(body.seriesKey, row, payload, vintageDate);
      if (!availability.date) return fail('UNKNOWN_AVAILABILITY', 'FRED response did not expose a usable availability date', 422);
      const capturedAt = new Date().toISOString();
      const observation = createSourceObservation({
        provider: 'FRED',
        sourceId: seriesId,
        sourceClass: 'official',
        observedAt: `${row.date}T00:00:00.000Z`,
        availableAt: endOfVintageDay(availability.date),
        capturedAt,
        value: row.value,
        data: {
          latest: compactRow(rows[0]),
          previous: compactRow(rows[1]),
          history: rows.map(compactRow)
        },
        units: body.outputUnits || body.units || null,
        vintage: availability.date,
        provenance: {
          seriesKey: body.seriesKey,
          realtimeStart: row.realtimeStart,
          realtimeEnd: row.realtimeEnd,
          availabilityPrecision: 'date-conservative',
          availabilityBasis: availability.basis,
          retainedHistoryCount: rows.length,
          note: `${availability.note} Retained history includes only values returned by the same point-in-time query.`
        }
      });
      if (body.forecastCutoff) assertAvailableBefore(observation, body.forecastCutoff);
      return ok(observation, {
        seriesKey: body.seriesKey,
        seriesId,
        vintageDate,
        historyCount: rows.length,
        previousAvailable: rows.length > 1,
        availabilityBasis: availability.basis
      });
    } catch (error) {
      const code = /forecast cutoff/.test(error.message) ? 'POST_CUTOFF_SOURCE' : 'SOURCE_FETCH_FAILED';
      return fail(code, error.message, 422);
    }
  }
};
