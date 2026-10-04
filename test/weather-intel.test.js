// Live Weather Intelligence (Phases C/D/E): observed weather parsed from stored METARs, atmosphere follows the
// OBSERVATION not the forecast, stale -> no animation, timeline shows only legitimate (predictive-state) revisions,
// market disagreement surfaced without ever adjusting the forecast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePresentWeather, weatherText, atmosphere, legitimateRevisions, weatherIntel, NOT_YET_MODELED } from '../workers/pbe-predictions/src/weather-intel.js';
import { liveWeatherBlock, atmosphereLayer } from '../workers/pbe-predictions/src/weather-blocks.js';

const PHL = 'KPHL 041754Z 06008KT 3SM -RA BR BKN009 OVC015 17/15 A3018 RMK AO2 SLP220 P0001 60004 T01670150 10172 20161 58003 $';

test('present weather + sky from real METARs', () => {
  assert.equal(weatherText(parsePresentWeather(PHL)), 'Light rain');
  assert.equal(weatherText(parsePresentWeather('KDEN 041753Z 21009KT 10SM FEW120 SCT200 18/M03 A3001 RMK AO2')), 'Partly cloudy');
  assert.equal(weatherText(parsePresentWeather('KMSP 041753Z 33012KT 1SM +SN BKN008 OVC015 M02/M04 A2990')), 'Heavy snow');
  assert.equal(weatherText(parsePresentWeather('KATL 041753Z 24010KT 5SM TSRA BKN030CB 24/21 A2995')), 'Thunderstorm');
  assert.equal(weatherText(parsePresentWeather('KSFO 041756Z 00000KT 1/4SM FG VV002 13/13 A3005')), 'Fog');
  assert.equal(weatherText(parsePresentWeather('KPHX 041751Z 25006KT 10SM CLR 33/04 A2989')), 'Clear');
});

test('atmosphere follows the observation; stale removes animation', () => {
  const at = (raw, fr = 'CURRENT', h = 13) => atmosphere(parsePresentWeather(raw), { freshness: fr, localHour: h });
  assert.equal(at(PHL), 'rain');
  assert.equal(at('KMSP 041753Z 1SM +SN OVC015'), 'snow');
  assert.equal(at('KATL 041753Z TSRA BKN030CB'), 'storm');
  assert.equal(at('KSFO 041756Z 1/4SM FG VV002'), 'fog');
  assert.equal(at('KDEN 041753Z 10SM OVC100'), 'cloudy');
  assert.equal(at('KPHX 041751Z 10SM CLR'), 'clear-day');
  assert.equal(at('KPHX 041751Z 10SM CLR', 'CURRENT', 22), 'clear-night');
  assert.equal(at(PHL, 'STALE'), 'stale', 'a stale observation never animates');
  assert.equal(atmosphere(null, { freshness: 'CURRENT', localHour: 12 }), 'none');
  assert.match(atmosphereLayer('rain'), /wx-atmo wx-rain/);
  assert.match(atmosphereLayer('<x>'), /wx-none/);
});

const featById = new Map();
const row = (id, t, p, feats, model = 'pbe-weather-precip-intraday', branch = 'measured_bound') => { featById.set(`fs-${id}`, { features: feats }); return { forecast_id: id, captured_at: t, probability: p, model_id: model, model_version: model.includes('precip') ? '2.0.0' : '2.1.0', model_state: 'RESEARCH', feature_snapshot_id: `fs-${id}`, provenance: [], explanation: { branch, input_hash: `h-${id}` } }; };

test('timeline: redundant rain rows written before Phase A collapse; temp rows each count; causes from stored inputs', () => {
  const rain = { measurable_precip_observed: true, measurable_precip_first_report_only: false, trace_precip_observed: false, remaining_pop_kind: 'nbm', climatology_rate_1991_2020: 0.33 };
  const rows = [row('a', '2026-10-04T18:18:33Z', 0.99, { ...rain, obs_count: 24, hours_into_window_lst: 13.3 }), row('b', '2026-10-04T18:33:33Z', 0.99, { ...rain, obs_count: 25, hours_into_window_lst: 13.55 }), row('c', '2026-10-04T18:48:33Z', 0.99, { ...rain, obs_count: 25, hours_into_window_lst: 13.8 })];
  assert.equal(legitimateRevisions(rows, featById).length, 1, 'three identical predictive states -> one revision');
  const t = [row('t1', '2026-10-04T18:18:33Z', 0.25, { obs_max_so_far_f: 64, current_temp_f: 62.1, guidance_max_temp_f: 67 }, 'pbe-weather-maxtemp-intraday', null), row('t2', '2026-10-04T18:33:33Z', 0.22, { obs_max_so_far_f: 64, current_temp_f: 61.5, guidance_max_temp_f: 67 }, 'pbe-weather-maxtemp-intraday', null)];
  const rev = legitimateRevisions(t, featById);
  assert.equal(rev.length, 2);
  assert.deepEqual(rev[1].cause, ['Current temperature 62.1°F → 61.5°F']);
});

test('weather intel: separate truths, explicit market disagreement, no edge language, deterministic why', () => {
  const contract = { contract_id: 'C', station_id: 'CLIPHL' };
  const outcome = { live: { station: { icao: 'KPHL', cli: 'CLIPHL', name: 'PHILADELPHIA INTL' }, window: { state: 'WINDOW_OPEN', start: '2026-10-04T05:00:00Z', end: '2026-10-05T05:00:00Z' }, observations: { latest: { temp_f: 62.6, t: '2026-10-04T18:15:00Z' }, max_so_far: { temp_f: 64.4 }, freshness: { label: 'CURRENT' } } } };
  const pre = { forecast_id: 'p', contract_id: 'C', model_id: 'pbe-weather-maxtemp', model_version: '1.1.0', probability: 0.05, captured_at: '2026-10-03T23:00:09Z' };
  const fs = [pre, { ...row('t1', '2026-10-04T18:18:33Z', 0.25, { obs_max_so_far_f: 64, current_temp_f: 62.1, guidance_max_temp_f: 67, hours_remaining: 10.7 }, 'pbe-weather-maxtemp-intraday', null), contract_id: 'C' }];
  const obsRows = [{ observed_at: '2026-10-04T17:54:00Z', available_at: '2026-10-04T18:18:33Z', data: { metar: true, temp_f: 62.1, raw_message: PHL } }];
  const w = weatherIntel({ outcome, contract, forecasts: fs, featById, obsRows, market: { mid_pct: 95, observed_at: '2026-10-04T18:45:00Z', path: [{ t: '2026-10-04T18:00:00Z', mid: 96 }] }, now: '2026-10-04T18:50:00Z' });
  assert.equal(w.observed.text, 'Light rain');
  assert.equal(w.atmosphere, 'rain');
  assert.deepEqual([w.pbe.pct, w.prewindow.pct, w.market.pct, w.gap], [25, 5, 95, -70]);
  assert.deepEqual(w.disagreement.not_yet_modeled, NOT_YET_MODELED['pbe-weather-maxtemp-intraday']);
  const html = liveWeatherBlock({ label: '64° to 65°', intel: w });
  assert.match(html, /MARKET DISAGREEMENT/);
  assert.match(html, /PBE RESEARCH 25%/);
  assert.match(html, /PRE-WINDOW PBE · 5%/);
  assert.doesNotMatch(html.replace('is not an edge', ''), /\bedge\b/i, 'never calls the gap an edge');
  assert.equal(w.chart.pbe[0].pre, true);
  // a forecast of rain does not make the atmosphere rain: only the observation does
  const clearObs = [{ ...obsRows[0], data: { ...obsRows[0].data, raw_message: 'KPHL 041754Z 10SM CLR 20/10 A3010' } }];
  assert.equal(weatherIntel({ outcome, contract, forecasts: fs, featById, obsRows: clearObs, market: null, now: '2026-10-04T18:50:00Z' }).atmosphere, 'clear-day');
});
