// Pure parsers: ASOS/METAR observation payloads -> intraday obs rows
//   { station, valid_at, available_at, tmpf, p01i, trace, source }
// valid_at = observation (valid) time; available_at = valid_at + OBS_PUBLICATION_LAG_MIN unless the caller supplies
// a later first-seen time. No network access here.
import { OBS_PUBLICATION_LAG_MIN } from './features.js';

const icaoOf = (id) => { const s = String(id || '').trim().toUpperCase(); return /^[A-Z0-9]{3}$/.test(s) ? `K${s}` : s; };
const iso = (ms) => new Date(ms).toISOString();
const round2 = (x) => Math.round(x * 100) / 100;

// IEM ASOS archive CSV (cgi-bin/request/asos.py, format=onlycomma, tz=Etc/UTC, missing=M, trace=T):
//   station,valid,tmpf,p01i  ->  'PHL,2025-07-01 13:54,88.00,0.00'
export function parseIemAsosCsv(text, { lagMin = OBS_PUBLICATION_LAG_MIN } = {}) {
  const lines = String(text).split(/\r?\n/);
  const head = (lines.shift() || '').split(',').map((s) => s.trim());
  const at = (n) => head.indexOf(n);
  const iS = at('station'); const iV = at('valid'); const iT = at('tmpf'); const iP = at('p01i');
  if (iS < 0 || iV < 0) throw new Error('IEM ASOS CSV: missing station/valid columns');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const c = line.split(',');
    const ms = Date.parse(`${c[iV].trim().replace(' ', 'T')}:00Z`);
    if (!Number.isFinite(ms)) continue;
    const t = iT >= 0 ? c[iT] : 'M'; const p = iP >= 0 ? c[iP] : 'M';
    const tmpf = t === 'M' || t === '' ? null : Number(t);
    const trace = p === 'T';
    const p01i = trace ? 0 : p === 'M' || p === '' ? null : Number(p);
    out.push({ station: icaoOf(c[iS]), valid_at: iso(ms), available_at: iso(ms + lagMin * 60000), tmpf: Number.isFinite(tmpf) ? tmpf : null, p01i: Number.isFinite(p01i) ? p01i : null, trace, source: 'iem-asos' });
  }
  return out;
}

// NWS API observations (GET https://api.weather.gov/stations/KPHL/observations?start=<window start ISO>):
//   properties.timestamp            -> valid_at (observation time)
//   properties.station / stationId  -> station (ICAO)
//   properties.temperature          -> tmpf  (wmoUnit:degC: F = C * 9/5 + 32; degF passed through)
//   properties.precipitationLastHour-> p01i  (wmoUnit:mm / 25.4; wmoUnit:m * 39.3701; null = missing)
// The API publishes no trace flag; a 0 value is treated as 0 (no measurable rain), same as trace for the contract.
// fetchedAt (optional): when the caller first saw the payload; available_at is never earlier than valid + lag and,
// if firstSeen is supplied per call, never earlier than that.
export function parseNwsObservations(body, { lagMin = OBS_PUBLICATION_LAG_MIN, firstSeenAt = null } = {}) {
  const feats = Array.isArray(body?.features) ? body.features : Array.isArray(body?.['@graph']) ? body['@graph'].map((p) => ({ properties: p })) : [];
  const seen = firstSeenAt ? Date.parse(firstSeenAt) : null;
  const out = [];
  for (const f of feats) {
    const p = f.properties || {};
    const ms = Date.parse(p.timestamp);
    if (!Number.isFinite(ms)) continue;
    const station = icaoOf(p.stationId || String(p.station || '').split('/').pop());
    const t = p.temperature; let tmpf = null;
    if (t && Number.isFinite(t.value)) tmpf = /degF/i.test(t.unitCode || '') ? t.value : round2(t.value * 9 / 5 + 32);
    const q = p.precipitationLastHour; let p01i = null;
    if (q && Number.isFinite(q.value)) p01i = /:m$/i.test(q.unitCode || '') ? round2(q.value * 39.3701) : /in/i.test(q.unitCode || '') ? round2(q.value) : round2(q.value / 25.4);
    const avail = Math.max(ms + lagMin * 60000, Number.isFinite(seen) ? seen : -Infinity);
    out.push({ station, valid_at: iso(ms), available_at: iso(avail), tmpf, p01i, trace: false, source: 'nws-api' });
  }
  return out.sort((a, b) => Date.parse(a.valid_at) - Date.parse(b.valid_at));
}
