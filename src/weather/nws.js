// NWS API (api.weather.gov) gridpoint forecast — displayed as official-forecast EVIDENCE beside the model.
// Follows the golf-ingest NWS chain (points -> forecastGridData, identifying User-Agent, geo+json accept).
// It is not a calibrated model input in v1 (no public archive of past gridpoint forecasts to calibrate on).

export const NWS_API = 'https://api.weather.gov';

function durationHours(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(d));
  if (!m) return null;
  return Number(m[1] || 0) * 24 + Number(m[2] || 0) + Number(m[3] || 0) / 60;
}

export function parseValidTime(validTime) {
  const [start, dur] = String(validTime).split('/');
  const s = Date.parse(start);
  const h = durationHours(dur);
  if (!Number.isFinite(s) || h === null) return null;
  return { startMs: s, endMs: s + h * 3600000 };
}

const overlapH = (a, b) => Math.max(0, (Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)) / 3600000);

// Official-forecast evidence for a CLI window: max hourly PoP, overlap-weighted QPF, daytime max temperature.
export function gridWindowEvidence(body, win) {
  const p = body?.properties;
  if (!p) return null;
  const w = { startMs: Date.parse(win.start), endMs: Date.parse(win.end) };
  const pops = (p.probabilityOfPrecipitation?.values || []).map((v) => ({ iv: parseValidTime(v.validTime), value: v.value })).filter((x) => x.iv && overlapH(x.iv, w) > 0 && Number.isFinite(x.value));
  const qpf = (p.quantitativePrecipitation?.values || []).map((v) => ({ iv: parseValidTime(v.validTime), value: v.value })).filter((x) => x.iv && overlapH(x.iv, w) > 0 && Number.isFinite(x.value));
  const covered = qpf.reduce((s, x) => s + overlapH(x.iv, w), 0);
  const qpfMm = qpf.reduce((s, x) => s + x.value * (overlapH(x.iv, w) / ((x.iv.endMs - x.iv.startMs) / 3600000)), 0);
  const maxT = (p.maxTemperature?.values || []).map((v) => ({ iv: parseValidTime(v.validTime), value: v.value })).find((x) => x.iv && overlapH(x.iv, w) >= 6 && Number.isFinite(x.value));
  return Object.freeze({
    update_time: p.updateTime || null,
    pop_max_pct: pops.length ? Math.max(...pops.map((x) => x.value)) : null,
    pop_hours_covered: pops.reduce((s, x) => s + overlapH(x.iv, w), 0),
    qpf_in: covered >= 20 ? Math.round((qpfMm / 25.4) * 100) / 100 : null,
    qpf_hours_covered: covered,
    max_temp_f: maxT ? Math.round(maxT.value * 9 / 5 + 32) : null,
  });
}

export async function fetchGridpoint({ lat, lon }, { fetchImpl = globalThis.fetch, userAgent }) {
  const headers = { accept: 'application/geo+json', 'user-agent': userAgent };
  const pt = await fetchImpl(`${NWS_API}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers });
  if (!pt.ok) throw new Error(`NWS points ${pt.status}`);
  const point = (await pt.json()).properties;
  const res = await fetchImpl(point.forecastGridData, { headers });
  if (!res.ok) throw new Error(`NWS gridpoint ${res.status}`);
  return { url: point.forecastGridData, gridId: point.gridId, gridX: point.gridX, gridY: point.gridY, body: await res.json() };
}
