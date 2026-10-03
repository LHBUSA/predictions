// NWS GFS MOS (MAV) station guidance. Archive + live via the Iowa Environmental Mesonet MOS service.
// P06 = probability of >= 0.01 in during the 6 h ending at the projection time (ftime); N/X = night min /
// day max. Pure parsing and window selection; fetch helpers at the bottom.

export const MOS_MODEL = 'GFS';
export const MOS_AVAILABLE_LAG_H = 5; // conservative: a run is treated as known only 5 h after its cycle time
export const IEM_MOS_JSON = 'https://mesonet.agron.iastate.edu/api/1/mos.json';

const toIso = (s) => {
  const t = String(s || '').trim();
  if (!t) return null;
  const iso = /Z$|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

export function normalizeMosRow(r) {
  return Object.freeze({ runtime: toIso(r.runtime_utc || r.runtime), ftime: toIso(r.ftime_utc || r.ftime), n_x: num(r.n_x), p06: num(r.p06), p12: num(r.p12), q06: num(r.q06), tmp: num(r.tmp), dpt: num(r.dpt) });
}

export function parseMosCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  const at = (name) => head.indexOf(name);
  const cols = { runtime: at('runtime'), ftime: at('ftime'), n_x: at('n_x'), p06: at('p06'), p12: at('p12'), q06: at('q06'), tmp: at('tmp'), dpt: at('dpt') };
  return lines.map((line) => {
    const c = line.split(',');
    return normalizeMosRow(Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, i >= 0 ? c[i] : null])));
  }).filter((r) => r.runtime && r.ftime);
}

export function runAvailableAt(runtime) {
  return new Date(Date.parse(runtime) + MOS_AVAILABLE_LAG_H * 3600000).toISOString();
}

// Latest run (sorted ISO list) that was published by the cutoff. Binary search; parsed times are cached
// per list so research loops over thousands of cases stay linear.
const parsedRuns = new WeakMap();
export function latestRunAtOrBefore(sortedRuntimes, cutoffIso) {
  let ms = parsedRuns.get(sortedRuntimes);
  if (!ms) { ms = sortedRuntimes.map((r) => Date.parse(r) + MOS_AVAILABLE_LAG_H * 3600000); parsedRuns.set(sortedRuntimes, ms); }
  const cutoff = Date.parse(cutoffIso);
  let lo = 0;
  let hi = ms.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms[mid] <= cutoff) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 ? sortedRuntimes[best] : null;
}

// The four 6-h PoP periods that cover the CLI window (each overlapping it by >= 3 h). Null unless all four exist.
export function windowPrecipFeatures(rows, win) {
  const ws = Date.parse(win.start);
  const we = Date.parse(win.end);
  const periods = [];
  for (const r of rows) {
    if (r.p06 === null) continue;
    const pe = Date.parse(r.ftime);
    const ps = pe - 6 * 3600000;
    const overlap = (Math.min(pe, we) - Math.max(ps, ws)) / 3600000;
    if (overlap >= 3) periods.push({ start: new Date(ps).toISOString(), end: r.ftime, pop: r.p06 / 100, qpf_category: r.q06, overlap_h: overlap });
  }
  periods.sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
  if (periods.length !== 4) return null;
  const pops = periods.map((p) => p.pop);
  return Object.freeze({
    pop_union: 1 - pops.reduce((acc, p) => acc * (1 - p), 1),
    pop_max: Math.max(...pops),
    pop_mean: pops.reduce((a, b) => a + b, 0) / pops.length,
    alignment_offset_h: (Date.parse(periods[0].start) - ws) / 3600000,
    periods: Object.freeze(periods.map((p) => Object.freeze(p))),
  });
}

// Day-max guidance for a CLI date: the X value valid at 00Z the following day (daytime 7 a.m.-7 p.m. LST max).
export function maxTempGuidance(rows, date) {
  const target = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString();
  const row = rows.find((r) => r.ftime === target && r.n_x !== null);
  return row ? row.n_x : null;
}

export async function fetchMosRun({ icao, runtime = null }, { fetchImpl = globalThis.fetch, userAgent } = {}) {
  const url = new URL(IEM_MOS_JSON);
  url.searchParams.set('station', icao);
  url.searchParams.set('model', MOS_MODEL);
  if (runtime) url.searchParams.set('runtime', runtime.replace(/:00\.000Z$/, 'Z'));
  const res = await fetchImpl(url, { headers: { accept: 'application/json', ...(userAgent ? { 'user-agent': userAgent } : {}) } });
  if (!res.ok) throw new Error(`IEM MOS ${icao} ${res.status}`);
  const body = await res.json();
  const rows = (body.data || []).map(normalizeMosRow).filter((r) => r.runtime && r.ftime);
  return Object.freeze({ icao, url: url.toString(), runtime: rows[0]?.runtime ?? null, rows: Object.freeze(rows) });
}
