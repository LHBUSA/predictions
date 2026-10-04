// LIVE WEATHER INTELLIGENCE (Phases C/D/E, owner 2026-10-04). Everything here is derived from STORED facts:
// exact-station METARs (present weather + sky cover parsed from the stored raw report), the stored intraday forecast
// rows and their evidence, and stored market observations. Prediction and observed weather stay separate truths:
// the atmosphere follows the OBSERVATION, never the PBE probability. Nothing here is a model input.
import { predictiveState } from './intraday-live.js';
import { CLI_STATIONS } from '../../../src/weather/stations.js';

// --- METAR present weather + sky (WMO/FAA METAR conventions) --------------------------------------------------------
const WX_RE = /^(-|\+|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)$/;
const SKY_RE = /^(FEW|SCT|BKN|OVC|VV)(\d{3})|^(CLR|SKC)$/;
export function parsePresentWeather(raw) {
  const body = String(raw || '').split(' RMK ')[0].split(/\s+/).slice(2); // drop station + time
  const wx = []; const sky = [];
  for (const t of body) {
    const w = WX_RE.exec(t); if (w && t.length >= 2 && !/^\d/.test(t)) wx.push({ token: t, intensity: w[1] || '', descriptor: w[2] || '', phenomena: w[3] });
    const s = SKY_RE.exec(t); if (s) sky.push(s[1] || s[3]);
  }
  return { wx, sky };
}
const PH = { RA: 'rain', DZ: 'drizzle', SN: 'snow', SG: 'snow grains', PL: 'ice pellets', GR: 'hail', GS: 'small hail', BR: 'mist', FG: 'fog', HZ: 'haze', FU: 'smoke', UP: 'precipitation' };
export function weatherText({ wx, sky }) {
  if (wx.length) {
    const w = wx.find((x) => !/^(BR|HZ|FU)$/.test(x.phenomena)) || wx[0];
    if (w.descriptor === 'TS') return 'Thunderstorm';
    const base = PH[w.phenomena.slice(0, 2)] || w.phenomena.toLowerCase();
    const word = w.intensity === '-' ? `Light ${base}` : w.intensity === '+' ? `Heavy ${base}` : base[0].toUpperCase() + base.slice(1);
    return w.descriptor === 'SH' ? `${word} showers` : w.descriptor === 'FZ' ? `Freezing ${base}` : word;
  }
  const top = sky.includes('OVC') || sky.includes('VV') ? 'OVC' : sky.includes('BKN') ? 'BKN' : sky.includes('SCT') ? 'SCT' : sky.includes('FEW') ? 'FEW' : sky.length ? 'CLR' : null;
  return { OVC: 'Overcast', BKN: 'Mostly cloudy', SCT: 'Partly cloudy', FEW: 'Mostly clear', CLR: 'Clear' }[top] || null;
}
// Atmosphere class from the OBSERVATION: rain | snow | storm | fog | cloudy | clear-day | clear-night | stale | none
export function atmosphere(parsed, { freshness, localHour }) {
  if (!parsed) return 'none';
  if (freshness === 'STALE') return 'stale';
  const { wx, sky } = parsed;
  const ph = wx.map((w) => w.phenomena).join('');
  if (wx.some((w) => w.descriptor === 'TS')) return 'storm';
  if (/SN|SG|PL|IC/.test(ph)) return 'snow';
  if (/RA|DZ|UP|GR|GS/.test(ph)) return 'rain';
  if (/FG|BR|HZ|FU/.test(ph)) return 'fog';
  if (sky.includes('OVC') || sky.includes('BKN') || sky.includes('VV')) return 'cloudy';
  return localHour >= 7 && localHour < 18 ? 'clear-day' : 'clear-night';
}

// What each live model does NOT yet see (from the research evidence; shown beside any market disagreement).
export const NOT_YET_MODELED = Object.freeze({
  'pbe-weather-maxtemp-intraday': ['current present-weather or cloud state (rain, overcast)', 'the hourly guidance temperature path for the rest of the day (it uses the day high only)', 'sub-two-hour calibration of the time of day'],
  'pbe-weather-precip-intraday': ['radar or satellite', 'guidance finer than 6-hour precipitation periods'],
});

const INTRA = /-intraday$/;
const featureLabel = { obs_max_so_far_f: 'Observed high so far', current_temp_f: 'Current temperature', guidance_max_temp_f: 'Guidance high for the day', hours_remaining: 'Hours left', measurable_precip_observed: 'Measurable rain reported', remaining_pop: 'Chance of rain in the remaining hours', obs_count: 'Reports used' };
const fmtF = (k, v) => (v === null || v === undefined ? '—' : /_f$/.test(k) ? `${Number(v).toFixed(1).replace(/\.0$/, '')}°F` : k === 'remaining_pop' ? `${Math.round(v * 100)}%` : typeof v === 'boolean' ? (v ? 'yes' : 'no') : k === 'hours_remaining' ? `${Number(v).toFixed(1)} h` : String(v));

// Legitimate revisions of one contract's live (intraday) path: consecutive rows whose PREDICTIVE state is identical
// are collapsed (Phase A: redundant rows written before the fix simply do not appear). Temperature rows were always
// written only on input change, so each is a revision.
export function legitimateRevisions(rows, featById) {
  const out = []; let prevKey = null; let prevFeat = null;
  for (const f of rows) {
    const feats = featById.get(f.feature_snapshot_id)?.features || {};
    const ps = predictiveState(f.model_id, feats, f.provenance, f.explanation?.branch);
    const key = ps ? JSON.stringify(ps) : (f.explanation?.input_hash || f.forecast_id);
    if (key === prevKey) continue;
    const cause = [];
    if (prevFeat) for (const k of ['obs_max_so_far_f', 'current_temp_f', 'guidance_max_temp_f', 'measurable_precip_observed']) if (k in feats && JSON.stringify(feats[k]) !== JSON.stringify(prevFeat[k])) cause.push(`${featureLabel[k]} ${fmtF(k, prevFeat[k])} → ${fmtF(k, feats[k])}`);
    if (prevFeat && !cause.length) cause.push(ps && ps.lst_hour_bucket !== null ? 'Hourly model step (local standard hour)' : 'New report at the station');
    out.push({ forecast_id: f.forecast_id, t: f.captured_at, pct: Math.round(Number(f.probability) * 100), model: `${f.model_id}@${f.model_version}`, state: f.model_state, cause: prevFeat ? cause : ['First live intraday forecast'], features: feats });
    prevKey = key; prevFeat = feats;
  }
  return out;
}

// Assemble the live weather intelligence for one outcome.
export function weatherIntel({ outcome, contract, forecasts, featById, obsRows, market, now }) {
  const L = outcome.live;
  if (!L?.station || !L.window || L.window.state === 'PRE_WINDOW') return null;
  const metars = (obsRows || []).filter((r) => r.data?.metar && r.observed_at >= L.window.start && Date.parse(r.available_at) <= Date.parse(now)).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const lastMetar = metars.at(-1) || null;
  const parsed = lastMetar ? parsePresentWeather(lastMetar.data.raw_message) : null;
  const lst = Number(CLI_STATIONS[contract.station_id]?.lstOffsetHours ?? -5);
  const localHour = (new Date(now).getUTCHours() + 24 + lst) % 24;
  const fresh = L.observations?.freshness?.label || null;
  const intra = (forecasts || []).filter((f) => f.contract_id === contract.contract_id && INTRA.test(f.model_id)).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  const pre = (forecasts || []).filter((f) => f.contract_id === contract.contract_id && !INTRA.test(f.model_id)).sort((a, b) => a.captured_at.localeCompare(b.captured_at)).at(-1) || null;
  const revisions = legitimateRevisions(intra, featById);
  const cur = revisions.at(-1) || null; const prev = revisions.at(-2) || null;
  const why = cur ? ['obs_max_so_far_f', 'current_temp_f', 'guidance_max_temp_f', 'hours_remaining', 'measurable_precip_observed', 'remaining_pop'].filter((k) => k in cur.features).map((k) => ({ label: featureLabel[k], value: fmtF(k, cur.features[k]), prev: prev && k in prev.features ? fmtF(k, prev.features[k]) : null })) : [];
  const gap = cur && market?.mid_pct !== null && market?.mid_pct !== undefined ? cur.pct - market.mid_pct : null;
  const family = cur?.model.split('@')[0] || null;
  return {
    station: L.station, observed: { temp_f: L.observations?.latest?.temp_f ?? null, text: parsed ? weatherText(parsed) : null, high_f: L.observations?.max_so_far?.temp_f ?? null, at: lastMetar?.observed_at ?? L.observations?.latest?.t ?? null, freshness: fresh, raw: lastMetar?.data?.raw_message ?? null },
    atmosphere: atmosphere(parsed, { freshness: fresh, localHour }),
    guidance: cur && 'guidance_max_temp_f' in cur.features ? { high_f: cur.features.guidance_max_temp_f } : null,
    pbe: cur ? { pct: cur.pct, model: cur.model, state: cur.state, at: cur.t } : null,
    previous: prev ? { pct: prev.pct, at: prev.t } : null,
    prewindow: pre ? { pct: Math.round(Number(pre.probability) * 100), model: `${pre.model_id}@${pre.model_version}`, at: pre.captured_at } : null,
    market: market?.mid_pct !== null && market?.mid_pct !== undefined ? { venue: 'Kalshi', pct: market.mid_pct, at: market.observed_at } : null,
    gap, disagreement: gap !== null && Math.abs(gap) >= 20 ? { gap, not_yet_modeled: NOT_YET_MODELED[family] || [] } : null,
    why, revisions: revisions.map(({ features, ...r }) => r),
    // today's window only (public 24 h policy): PBE path, Kalshi stored observations, station temperatures
    chart: { from: L.window.start, to: now,
      pbe: [...(pre ? [{ t: L.window.start, v: Math.round(Number(pre.probability) * 100), pre: true }] : []), ...revisions.map((r) => ({ t: r.t, v: r.pct }))],
      market: (market?.path || []).filter((m) => m.t >= L.window.start && m.mid !== null && m.mid !== undefined).map((m) => ({ t: m.t, v: m.mid })),
      temps: metars.map((m) => ({ t: m.observed_at, v: m.data.temp_f })) },
  };
}
