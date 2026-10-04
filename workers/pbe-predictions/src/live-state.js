// LIVE STATE of an event record (freshness pass, owner 2026-10-04): window state per contract, the exact resolution
// station's observations inside the window (stored immutable source facts, written by the hot lane), and explicit
// freshness. A value that is not current never masquerades as current: the pre-window PBE forecast is labelled FROZEN
// once its window opens.
import { CLI_STATIONS } from '../../../src/weather/stations.js';

// Source-specific freshness thresholds (seconds): CURRENT / DELAYED / beyond = STALE.
export const FRESHNESS = Object.freeze({
  observation: { current: 75 * 60, delayed: 3 * 3600 },   // hourly METAR cadence (+ specials)
  market: { current: 20 * 60, delayed: 2 * 3600 },        // Kalshi read each engine cycle (change-only rows)
  intraday_pbe: { current: 90 * 60, delayed: 3 * 3600 },  // recomputed on every new observation
});
export function freshnessOf(kind, at, now) {
  if (!at) return null;
  const age = Math.max(0, Math.round((Date.parse(now) - Date.parse(at)) / 1000));
  const t = FRESHNESS[kind];
  return { age_s: age, label: age <= t.current ? 'CURRENT' : age <= t.delayed ? 'DELAYED' : 'STALE' };
}

export function windowState(c, now) {
  if (!c?.observation_start) return null;
  const t = Date.parse(now);
  const s = Date.parse(c.observation_start); const e = Date.parse(c.observation_end);
  return { state: t < s ? 'PRE_WINDOW' : t < e ? 'WINDOW_OPEN' : 'WINDOW_CLOSED', start: c.observation_start, end: c.observation_end };
}

// Summary of stored exact-station observations inside [start, end]: latest reading, observed high so far (tenths-°C
// METAR temps + 6-hour max groups whose whole period lies inside the window), preliminary precip (routine METAR P groups).
export function stationSummary(rows, { start, end, now }) {
  const inWin = rows.filter((r) => r.observed_at >= start && r.observed_at <= end && Date.parse(r.available_at) <= Date.parse(now)).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  if (!inWin.length) return null;
  const latest = inWin.at(-1);
  let max = null;
  for (const r of inWin) {
    const d = r.data || {};
    const cands = [];
    if (d.temp_f !== null && d.temp_f !== undefined) cands.push({ f: d.temp_f, t: r.observed_at, basis: d.temp_c_precision === 0.1 ? 'METAR tenths' : '5-min whole °C' });
    if (d.max6_f !== null && d.max6_f !== undefined && Date.parse(r.observed_at) - 6 * 3600000 >= Date.parse(start)) cands.push({ f: d.max6_f, t: r.observed_at, basis: '6-hour maximum group' });
    for (const c of cands) if (!max || c.f > max.f) max = c;
  }
  const routine = inWin.filter((r) => r.data?.metar && /\b\d{4}5[0-9]Z\b/.test(r.data.raw_message || '') && r.data.precip_hour_in !== null && r.data.precip_hour_in !== undefined);
  const precip = routine.length ? +routine.reduce((a, r) => a + r.data.precip_hour_in, 0).toFixed(2) : null;
  return {
    n: inWin.length, latest: { t: latest.observed_at, temp_f: latest.data?.temp_f ?? null, basis: latest.data?.temp_c_precision === 0.1 ? 'METAR tenths' : '5-min whole °C', seen_at: latest.available_at },
    max_so_far: max ? { temp_f: max.f, t: max.t, basis: max.basis } : null,
    precip_so_far_in: precip, precip_measurable: precip !== null && precip >= 0.01,
    freshness: freshnessOf('observation', latest.observed_at, now),
  };
}

// Load stored observations for the stations of these contracts (one request; OR over station prefixes).
export async function loadStationObservations(store, contracts) {
  const icaos = [...new Set(contracts.map((c) => CLI_STATIONS[c.station_id]?.icao).filter(Boolean))];
  const starts = contracts.map((c) => c.observation_start).filter(Boolean).sort();
  if (!icaos.length || !starts.length) return new Map();
  const rows = await store.select('pred_source_observations', { select: 'source_id,observed_at,available_at,data', or: `(${icaos.map((i) => `source_id.like.asos:${i}:*`).join(',')})`, observed_at: `gte.${starts[0]}` }, { order: 'observed_at.asc' }).catch(() => []);
  const out = new Map();
  for (const r of rows) { const icao = r.source_id.split(':')[1]; if (!out.has(icao)) out.set(icao, []); out.get(icao).push(r); }
  return out;
}

export function liveForOutcome(c, call, obsByIcao, now) {
  const w = windowState(c, now);
  const st = CLI_STATIONS[c.station_id] || null;
  const obs = st && w && w.state !== 'PRE_WINDOW' ? stationSummary(obsByIcao.get(st.icao) || [], { start: c.observation_start, end: c.observation_end, now }) : null;
  const frozen = call && w && w.state !== 'PRE_WINDOW' && Date.parse(call.published_at) < Date.parse(c.observation_start)
    ? { frozen_at: call.published_at, reason: 'PRE_WINDOW_MODEL_STOPS_AT_WINDOW_OPEN' } : null;
  return { window: w, station: st ? { icao: st.icao, cli: st.cli, name: st.name } : null, observations: obs, pbe_frozen: frozen };
}
