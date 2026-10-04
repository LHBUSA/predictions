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
  const iS = at('station'); const iV = at('valid'); const iT = at('tmpf'); const iP = at('p01i'); const iM = at('metar'); const i6 = at('max6_f');
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
    const row = { station: icaoOf(c[iS]), valid_at: iso(ms), available_at: iso(ms + lagMin * 60000), tmpf: Number.isFinite(tmpf) ? tmpf : null, p01i: Number.isFinite(p01i) ? p01i : null, trace, source: 'iem-asos' };
    // 6-hour max (2.1.0): from a decoded max6_f column, or parsed from the raw METAR (1snTTT) when data=metar was requested
    if (i6 >= 0) { const v = Number(c[i6]); row.max6_f = c[i6] !== '' && c[i6] !== 'M' && Number.isFinite(v) ? v : null; }
    else if (iM >= 0) row.max6_f = parseMetarSixHour(c.slice(iM).join(',')).max6_f;
    out.push(row);
  }
  return out;
}

// NWS API observations (GET https://api.weather.gov/stations/KPHL/observations?start=<window start ISO>):
//   properties.timestamp            -> valid_at (observation time)
//   properties.station / stationId  -> station (ICAO)
//   properties.temperature          -> tmpf  (wmoUnit:degC: F = C * 9/5 + 32; degF passed through)
//   properties.precipitationLastHour-> p01i  (wmoUnit:mm / 25.4; wmoUnit:m * 39.3701; null = missing)
//   properties.rawMessage           -> max6_f (6-h max group 1snTTT, tenths degC -> degF; null if absent)
// The API publishes no trace flag; a 0 value is treated as 0 (no measurable rain), same as trace for the contract.
// fetchedAt (optional): when the caller first saw the payload; available_at is never earlier than valid + lag and,
// if firstSeen is supplied per call, never earlier than that.
// metarOnly (default true): api.weather.gov interleaves 5-minute ASOS readings (whole degC, no precipitationLastHour key,
// no rawMessage) with METARs. The models were calibrated on METARs (routine + special) only, so 5-minute rows are dropped.
export function parseNwsObservations(body, { lagMin = OBS_PUBLICATION_LAG_MIN, firstSeenAt = null, metarOnly = true } = {}) {
  const feats = Array.isArray(body?.features) ? body.features : Array.isArray(body?.['@graph']) ? body['@graph'].map((p) => ({ properties: p })) : [];
  const seen = firstSeenAt ? Date.parse(firstSeenAt) : null;
  const out = [];
  for (const f of feats) {
    const p = f.properties || {};
    const ms = Date.parse(p.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (metarOnly && !String(p.rawMessage || '').trim() && !Object.prototype.hasOwnProperty.call(p, 'precipitationLastHour')) continue;
    const station = icaoOf(p.stationId || String(p.station || '').split('/').pop());
    const t = p.temperature; let tmpf = null;
    if (t && Number.isFinite(t.value)) tmpf = /degF/i.test(t.unitCode || '') ? t.value : round2(t.value * 9 / 5 + 32);
    const q = p.precipitationLastHour; let p01i = null;
    if (q && Number.isFinite(q.value)) p01i = /:m$/i.test(q.unitCode || '') ? round2(q.value * 39.3701) : /in/i.test(q.unitCode || '') ? round2(q.value) : round2(q.value / 25.4);
    const avail = Math.max(ms + lagMin * 60000, Number.isFinite(seen) ? seen : -Infinity);
    // max6_f: METAR remarks 1snTTT parsed from properties.rawMessage (null when the report carries no 6-h group)
    out.push({ station, valid_at: iso(ms), available_at: iso(avail), tmpf, p01i, trace: false, max6_f: parseMetarSixHour(p.rawMessage).max6_f, source: 'nws-api' });
  }
  return out.sort((a, b) => Date.parse(a.valid_at) - Date.parse(b.valid_at));
}

// METAR remarks 6-hour extremes: 1snTTT = max, 2snTTT = min over the preceding 6 h (tenths degC, sn 1 = negative),
// reported in the synoptic-hour routine report (~00/06/12/18Z). Returns degF (2 decimals) or null.
export function parseMetarSixHour(metar) {
  const s = String(metar || '');
  const rmk = s.indexOf(' RMK ');
  const out = { max6_f: null, min6_f: null };
  if (rmk < 0) return out;
  for (const tok of s.slice(rmk + 5).trim().split(/\s+/)) {
    const m = /^([12])([01])(\d{3})$/.exec(tok);
    if (!m) continue;
    const c = (m[2] === '1' ? -1 : 1) * Number(m[3]) / 10;
    const f = Math.round((c * 9 / 5 + 32) * 100) / 100;
    if (m[1] === '1' && out.max6_f === null) out.max6_f = f;
    if (m[1] === '2' && out.min6_f === null) out.min6_f = f;
  }
  return out;
}

// ---- maxtemp-intraday 2.2.0 candidate fields (additive; v2.0/v2.1 rows and outputs are unchanged) ----
// METAR present-weather group (WMO 4678 / FMH-1 ch. 12) and sky condition. Parsed from the METAR body only (before RMK).
// Returns { wxcodes: string[] (e.g. ['-RA','BR']), sky: [{ cover: 'CLR'|'SKC'|'FEW'|'SCT'|'BKN'|'OVC'|'VV', base_ft: number|null }] }.
// A METAR with no sky group returns sky: null (unknown), never an invented clear sky.
const WX_TOKEN = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*$/;
const WX_PHEN = /(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS|TS)/;
export function parseMetarWeather(metar) {
  const s = String(metar || '');
  if (!s.trim()) return { wxcodes: null, sky: null };
  const rmk = s.indexOf(' RMK');
  const body = (rmk >= 0 ? s.slice(0, rmk) : s).trim().split(/\s+/);
  const wxcodes = []; let sky = null;
  for (const tok of body.slice(2)) { // skip station id + DDHHMMZ
    const k = /^(CLR|SKC)$/.exec(tok);
    if (k) { (sky ||= []).push({ cover: k[1], base_ft: null }); continue; }
    const c = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?$/.exec(tok);
    if (c) { (sky ||= []).push({ cover: c[1], base_ft: c[2] === '///' ? null : Number(c[2]) * 100 }); continue; }
    if (tok.length >= 2 && WX_TOKEN.test(tok) && WX_PHEN.test(tok) && !/^(A|Q)\d{4}$/.test(tok)) wxcodes.push(tok);
  }
  return { wxcodes, sky };
}

// IEM asos.py decoded columns -> the same shape: wxcodes "-RA BR" (M = none reported), skycN/skylN (M = absent layer).
export function iemWeatherFields(wxcodes, skyc = [], skyl = []) {
  const w = String(wxcodes ?? '').trim();
  const codes = w === '' || w === 'M' ? [] : w.split(/\s+/);
  const sky = [];
  for (let i = 0; i < skyc.length; i += 1) {
    const c = String(skyc[i] ?? '').trim();
    if (!c || c === 'M') continue;
    const b = Number(skyl[i]);
    sky.push({ cover: c, base_ft: skyl[i] !== 'M' && skyl[i] !== '' && Number.isFinite(b) ? b : null });
  }
  return { wxcodes: codes, sky: sky.length ? sky : null };
}

// api.weather.gov observations with the 2.2.0 fields added (present weather + sky from properties.rawMessage).
// Same rows as parseNwsObservations (which is left unchanged), plus wxcodes / sky.
export function parseNwsObservationsV22(body, opts = {}) {
  const rows = parseNwsObservations(body, opts);
  const feats = Array.isArray(body?.features) ? body.features : Array.isArray(body?.['@graph']) ? body['@graph'].map((p) => ({ properties: p })) : [];
  const raw = new Map();
  for (const f of feats) { const p = f.properties || {}; const ms = Date.parse(p.timestamp); if (Number.isFinite(ms) && String(p.rawMessage || '').trim()) raw.set(iso(ms), p.rawMessage); }
  return rows.map((r) => ({ ...r, ...parseMetarWeather(raw.get(r.valid_at)) }));
}
