// HOT LANE (owner 2026-10-04, "Predictions is a live intelligence product"): runs on the existing one-minute wake-up.
// observe continuously -> store only NEW official observations (immutable source facts) -> recompute only when inputs
// change. Never touches the frozen pre-window forecasts, never writes identical rows, never reads market data for a model.
// Budget: hard cap HOT_LANE_MAX_SUBREQUESTS per tick (the one-minute invocation is shared with the BTC shadow).
import { CLI_STATIONS } from '../../../src/weather/stations.js';

export const HOT_LANE_MAX_SUBREQUESTS = 300;
export const OBS_PROVIDER = 'NWS api.weather.gov (ASOS/METAR)';
const UA = 'PropBetEdgePredictions/1.0 (+https://predictions.propbetedge.ai; data@propbetedge.ai)';
const STATION_SLOTS = 5; // each station polled once per 5 minutes (spread across the minute slots)

// METAR facts with full precision: T group = tenths °C; 1sTTT/2sTTT = 6-hour max/min (tenths °C); P = hourly precip
// (hundredths in), 6RRRR = 3/6-hour precip, 7RRRR = 24-hour precip. Trace (0000 in the 6/7 groups) = 0.00.
const tenths = (sign, v) => (sign === '1' ? -1 : 1) * Number(v) / 10;
export function parseMetar(raw) {
  const r = String(raw || '');
  const rmk = r.split(' RMK ')[1] || '';
  const g = (re) => { const m = re.exec(rmk); return m || null; };
  const t = g(/(?:^|\s)T([01])(\d{3})([01])(\d{3})(?:\s|$)/);
  const mx = g(/(?:^|\s)1([01])(\d{3})(?:\s|$)/);
  const mn = g(/(?:^|\s)2([01])(\d{3})(?:\s|$)/);
  const p1 = g(/(?:^|\s)P(\d{4})(?:\s|$)/);
  const p6 = g(/(?:^|\s)6(\d{4})(?:\s|$)/);
  const p24 = g(/(?:^|\s)7(\d{4})(?:\s|$)/);
  return {
    temp_c: t ? tenths(t[1], t[2]) : null, dewpoint_c: t ? tenths(t[3], t[4]) : null,
    max6_c: mx ? tenths(mx[1], mx[2]) : null, min6_c: mn ? tenths(mn[1], mn[2]) : null,
    precip_hour_in: p1 ? Number(p1[1]) / 100 : null, precip_6h_in: p6 ? Number(p6[1]) / 100 : null, precip_24h_in: p24 ? Number(p24[1]) / 100 : null,
  };
}
export const cToF = (c) => (c === null || c === undefined ? null : +(c * 9 / 5 + 32).toFixed(1));

// One api.weather.gov observation feature -> one immutable source-observation row. available_at = when PBE first saw it
// (point-in-time truth for any forecast that uses it), never the observation's valid time.
export function observationRow(feature, { icao, cli, seenAt, url }) {
  const p = feature.properties || {};
  const m = parseMetar(p.rawMessage);
  const tempC = m.temp_c ?? (p.temperature?.value ?? null);
  const precision = m.temp_c !== null ? 0.1 : (p.temperature?.value !== null && p.temperature?.value !== undefined ? 1 : null);
  const ts = new Date(p.timestamp).toISOString();
  return {
    observation_key: `${OBS_PROVIDER}:asos:${icao}:${ts}`,
    provider: OBS_PROVIDER, source_id: `asos:${icao}:${ts}`, source_class: 'official',
    observed_at: ts, available_at: seenAt, captured_at: seenAt,
    value: tempC === null ? null : cToF(tempC), units: '°F',
    data: { temp_c: tempC, temp_c_precision: precision, temp_f: cToF(tempC), max6_f: cToF(m.max6_c), min6_f: cToF(m.min6_c), dewpoint_c: m.dewpoint_c,
      precip_hour_in: m.precip_hour_in, precip_6h_in: m.precip_6h_in, precip_24h_in: m.precip_24h_in, raw_message: p.rawMessage || null, metar: Boolean(p.rawMessage), qc: p.temperature?.qualityControl ?? null },
    geography: { icao, cli }, provenance: { url, role: 'intraday observation at the exact resolution station' },
  };
}

// Active weather windows: NORMALIZED weather contracts whose climate-day window has started and not yet ended
// (+2 h grace so the final observations of the day are captured).
export async function activeWeatherStations(store, now) {
  const rows = await store.select('pred_contracts', { select: 'contract_id,event_id,station_id,event_type,observation_start,observation_end', normalization_status: 'eq.NORMALIZED', event_type: 'in.(MAX_TEMP_BUCKET,PRECIP_ANY)', observation_start: `lte.${now}`, observation_end: `gte.${new Date(Date.parse(now) - 2 * 3600000).toISOString()}` });
  const byStation = new Map();
  for (const c of rows) {
    const st = CLI_STATIONS[c.station_id]; if (!st) continue;
    const cur = byStation.get(st.icao) || { icao: st.icao, cli: st.cli, start: c.observation_start, end: c.observation_end, contracts: [] };
    if (c.observation_start < cur.start) cur.start = c.observation_start;
    if (c.observation_end > cur.end) cur.end = c.observation_end;
    cur.contracts.push(c);
    byStation.set(st.icao, cur);
  }
  return [...byStation.values()];
}

const slotOf = (icao) => [...icao].reduce((a, ch) => a + ch.charCodeAt(0), 0) % STATION_SLOTS;

export async function runHotLane(env, { store, now = new Date().toISOString(), fetchImpl = globalThis.fetch, onNewObservations = null, force = false } = {}) {
  const budget = { used: 0, max: HOT_LANE_MAX_SUBREQUESTS };
  const spend = (n = 1) => { if (budget.used + n > budget.max) throw new Error('hot lane subrequest budget exhausted'); budget.used += n; };
  const out = { now, stations_active: 0, stations_polled: 0, new_observations: 0, by_station: {}, errors: [] };
  spend(); const stations = await activeWeatherStations(store, now);
  out.stations_active = stations.length;
  const minute = new Date(now).getUTCMinutes();
  for (const st of stations) {
    if (!force && slotOf(st.icao) !== minute % STATION_SLOTS) continue;
    try {
      const url = `https://api.weather.gov/stations/${st.icao}/observations?start=${encodeURIComponent(st.start)}&limit=500`;
      spend(); const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/geo+json' } });
      if (!res.ok) throw new Error(`nws ${res.status}`);
      const body = await res.json();
      const rows = (body.features || []).filter((f) => f.properties?.timestamp && Date.parse(f.properties.timestamp) >= Date.parse(st.start) && Date.parse(f.properties.timestamp) <= Date.parse(st.end))
        .map((f) => observationRow(f, { icao: st.icao, cli: st.cli, seenAt: now, url }));
      out.stations_polled += 1;
      if (!rows.length) { out.by_station[st.icao] = 0; continue; }
      spend(); const have = new Set((await store.select('pred_source_observations', { select: 'observation_key', source_id: `like.asos:${st.icao}:*`, observed_at: `gte.${st.start}` })).map((r) => r.observation_key));
      const fresh = rows.filter((r) => !have.has(r.observation_key));
      out.by_station[st.icao] = fresh.length;
      if (!fresh.length) continue; // nothing new: write nothing
      spend(Math.ceil(fresh.length / 500)); await store.insertObservations(fresh);
      out.new_observations += fresh.length;
      if (onNewObservations) await onNewObservations(st, fresh, { spend, now });
    } catch (e) { out.errors.push({ station: st.icao, error: e.message }); if (/budget exhausted/.test(e.message)) break; }
  }
  out.subrequests = budget.used;
  return out;
}
