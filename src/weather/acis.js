// NOAA Regional Climate Centers ACIS (data.rcc-acis.org) — official daily station records (GHCN-D ids).
// Pure parsing/climatology + a small fetch helper. ACIS flags: 'M' missing, 'T' trace, a trailing 'A'
// marks a multi-day accumulation (not a single-day value -> treated as missing), 'S' subsequent/accumulating.

export const ACIS_URL = 'https://data.rcc-acis.org/StnData';

export function parseAcisValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s === 'M' || s === 'S' || /A$/.test(s)) return Object.freeze({ kind: 'missing', value: null });
  if (s === 'T') return Object.freeze({ kind: 'trace', value: 0 });
  const n = Number(s);
  return Number.isFinite(n) ? Object.freeze({ kind: 'value', value: n }) : Object.freeze({ kind: 'missing', value: null });
}

const indexCache = new WeakMap();
function indexOf(data) {
  let idx = indexCache.get(data);
  if (!idx) {
    idx = new Map(data.map((row) => [row[0], row]));
    indexCache.set(data, idx);
  }
  return idx;
}

function shift(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function sameMonthDay(year, monthDay) {
  if (monthDay === '02-29' && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) return `${year}-02-28`;
  return `${year}-${monthDay}`;
}

// Fraction of valid days with measurable precipitation (> 0.00 in; trace = dry) within +/- halfWindowDays of
// the target month-day, over [startYear, endYear]. data rows: [date, pcpn, maxt, ...].
export function climatologyRate(data, date, { startYear = 1991, endYear = 2020, halfWindowDays = 10, column = 1 } = {}) {
  const idx = indexOf(data);
  const md = date.slice(5);
  let n = 0;
  let wet = 0;
  for (let y = startYear; y <= endYear; y += 1) {
    const center = sameMonthDay(y, md);
    for (let k = -halfWindowDays; k <= halfWindowDays; k += 1) {
      const row = idx.get(shift(center, k));
      if (!row) continue;
      const v = parseAcisValue(row[column]);
      if (v.kind === 'missing') continue;
      n += 1;
      if (v.kind === 'value' && v.value > 0) wet += 1;
    }
  }
  return Object.freeze({ rate: n >= 200 ? wet / n : null, n, wet, startYear, endYear, halfWindowDays });
}

// Mean and spread of the daily maximum around the target month-day (context evidence only).
export function climatologyMaxTemp(data, date, { startYear = 1991, endYear = 2020, halfWindowDays = 7, column = 2 } = {}) {
  const idx = indexOf(data);
  const md = date.slice(5);
  const vals = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const center = sameMonthDay(y, md);
    for (let k = -halfWindowDays; k <= halfWindowDays; k += 1) {
      const row = idx.get(shift(center, k));
      const v = row ? parseAcisValue(row[column]) : null;
      if (v?.kind === 'value') vals.push(v.value);
    }
  }
  if (vals.length < 200) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1));
  return Object.freeze({ mean, sd, n: vals.length, startYear, endYear, halfWindowDays });
}

export async function fetchAcisDaily({ sid, sdate, edate, elems = ['pcpn', 'maxt', 'mint'] }, { fetchImpl = globalThis.fetch, userAgent } = {}) {
  const res = await fetchImpl(ACIS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(userAgent ? { 'user-agent': userAgent } : {}) },
    body: JSON.stringify({ sid, sdate, edate, elems: elems.map((name) => ({ name })), meta: ['name', 'sids', 'll'] }),
  });
  if (!res.ok) throw new Error(`ACIS StnData ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`ACIS StnData: ${body.error}`);
  return body;
}
