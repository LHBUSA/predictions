// Weather specialist engine. Given a NORMALIZED contract and domain-source captures (never market data),
// produce the PBE probability, the feature vector, human-readable evidence and a data-quality grade.
import precipArtifact from './artifacts/precip-v1.json' with { type: 'json' };
import tempArtifact from './artifacts/temp-v1.json' with { type: 'json' };
import climatology from './artifacts/climatology-v1.json' with { type: 'json' };
import { cliStation } from './stations.js';
import { windowPrecipFeatures, maxTempGuidance, runAvailableAt } from './mos.js';
import { gridWindowEvidence } from './nws.js';
import { predictPrecip } from './precip-model.js';
import { residualTable, bucketProbability } from './temp-model.js';
import { buildFeatureVector } from '../engine/leakage.js';

export const WEATHER_MODELS = Object.freeze({
  PRECIP_ANY: Object.freeze({ id: precipArtifact.model_id, version: precipArtifact.version, state: 'RESEARCH' }),
  MAX_TEMP_BUCKET: Object.freeze({ id: tempArtifact.model_id, version: tempArtifact.version, state: 'RESEARCH' }),
});
export const QUALITY_RULES_VERSION = 'wx-quality/1';

const pct = (p) => (p === null || p === undefined ? null : Math.round(p * 100));
export const publishable = (p) => Math.round(p * 100) / 100; // whole-percent precision; no fake decimals

export function climatologyFor(cli, date) {
  const s = climatology.stations[cli];
  if (!s) return null;
  const row = s.by_month_day[date.slice(5)];
  if (!row) return null;
  const [p30, p20, p10, tMean, tSd] = row;
  return { precip_rate_1991_2020: p30, precip_rate_2006_2025: p20, precip_rate_2016_2025: p10, maxt_mean_1991_2020: tMean, maxt_sd_1991_2020: tSd, ghcn: s.ghcn };
}

function comparableRate(cli, popUnion) {
  const bins = precipArtifact.comparable_conditions?.by_station?.[cli];
  if (!bins) return null;
  const b = bins[Math.min(9, Math.floor(popUnion * 10))];
  return b && b.n ? { rate: b.observed_rate, n: b.n, bin: b.pop_union_bin } : null;
}

// Data-quality grade (wx-quality/1): HIGH = complete current guidance, short lead, station skill proven on holdout;
// MEDIUM = complete guidance with older run or weaker station skill; LOW otherwise.
export function gradeQuality({ complete, runAgeH, runLeadH, stationSkill, stationN }) {
  if (!complete) return 'LOW';
  if (runAgeH <= 12 && runLeadH <= 54 && stationSkill !== null && stationSkill >= 0.15 && stationN >= 300) return 'HIGH';
  if (runAgeH <= 24 && (stationSkill === null || stationSkill >= 0.05)) return 'MEDIUM';
  return 'LOW';
}

function precipStationSkill(cli) {
  const s = precipArtifact.holdout.by_station?.[cli];
  if (!s) return { skill: null, n: 0 };
  return { skill: 1 - s.p_model.brier / s.p_clim.brier, n: s.n };
}

// sources: { mos: {runtime, url, observationKey, rows}, grid: {url, observationKey, body}|null }
export function forecastWeather(contract, sources, { now }) {
  const model = WEATHER_MODELS[contract.event_type];
  if (!model) return { status: 'UNSUPPORTED_EVENT_TYPE' };
  if (Date.parse(now) >= Date.parse(contract.observation_start)) return { status: 'WINDOW_STARTED' }; // v1 forecasts pre-window only
  const st = cliStation(contract.station_id);
  if (!st || st.cli !== contract.station_id) return { status: 'STATION_MISMATCH' };
  const date = contract.detail.climate_date;
  const win = { start: contract.observation_start, end: contract.observation_end };
  const mos = sources.mos;
  if (!mos || mos.icao !== st.icao) return { status: 'STATION_MISMATCH' }; // guidance must be for the contract's exact station
  if (!mos.runtime || Date.parse(runAvailableAt(mos.runtime)) > Date.parse(now)) return { status: 'NO_PUBLISHED_GUIDANCE' };
  const runLeadH = (Date.parse(win.start) - Date.parse(mos.runtime)) / 3600000;
  const runAgeH = (Date.parse(now) - Date.parse(mos.runtime)) / 3600000;
  const clim = climatologyFor(contract.station_id, date);
  const grid = sources.grid?.body ? gridWindowEvidence(sources.grid.body, win) : null;
  const src = {
    mos: { sourceClass: 'official', provider: 'NWS GFS MOS (MAV) via IEM', sourceId: `mos:GFS:${st.icao}:${mos.runtime}`, observationKey: mos.observationKey },
    clim: { sourceClass: 'official', provider: 'NOAA RCC-ACIS', sourceId: `acis:${st.ghcn}:climatology-v1`, observationKey: null },
  };
  const provenance = [
    { source: 'NWS GFS MOS (MAV) station guidance', provider: 'NOAA/NWS via Iowa Environmental Mesonet archive', station: st.icao, run: mos.runtime, available_at: runAvailableAt(mos.runtime), url: mos.url, role: 'model input' },
    { source: 'Station climatology 1991-2020', provider: 'NOAA Regional Climate Centers ACIS', station: st.ghcn, url: 'https://data.rcc-acis.org/StnData', artifact: 'climatology-v1', role: 'model input' },
    ...(grid ? [{ source: 'NWS gridpoint forecast', provider: 'NOAA/NWS api.weather.gov', url: sources.grid.url, updated_at: grid.update_time, role: 'evidence (not a model input in v1)' }] : []),
    { source: 'Contract resolution', provider: contract.resolution_authority, dataset: contract.resolution_dataset, verification: contract.verification_dataset, role: 'resolution' },
  ];

  if (contract.event_type === 'PRECIP_ANY') {
    const f = windowPrecipFeatures(mos.rows, win);
    if (!f || clim?.precip_rate_1991_2020 == null) return { status: 'INCOMPLETE_GUIDANCE' };
    const { features, featureSources } = buildFeatureVector([
      { name: 'mos_pop_union', value: +f.pop_union.toFixed(4), source: src.mos },
      { name: 'mos_pop_max', value: f.pop_max, source: src.mos },
      { name: 'mos_pop_periods', value: f.periods.map((p) => ({ end: p.end, pop: p.pop })), source: src.mos },
      { name: 'mos_window_alignment_offset_h', value: f.alignment_offset_h, source: src.mos },
      { name: 'climatology_rate_1991_2020', value: clim.precip_rate_1991_2020, source: src.clim },
      { name: 'run_lead_hours', value: +runLeadH.toFixed(2), source: src.mos },
    ]);
    const pred = predictPrecip(precipArtifact, { pop_union: f.pop_union, pop_max: f.pop_max, clim: clim.precip_rate_1991_2020, runLeadH });
    const analog = comparableRate(contract.station_id, f.pop_union);
    const { skill, n } = precipStationSkill(contract.station_id);
    const confidence = gradeQuality({ complete: true, runAgeH, runLeadH, stationSkill: skill, stationN: n });
    const evidence = [
      { label: 'Historical seasonal rate (1991-2020, ±10 days)', value: pct(clim.precip_rate_1991_2020), unit: '%', detail: `last 20 yr ${pct(clim.precip_rate_2006_2025)}%, last 10 yr ${pct(clim.precip_rate_2016_2025)}%` },
      { label: 'NWS guidance: chance of rain in the climate day', value: pct(f.pop_union), unit: '%', detail: `GFS MOS ${mos.runtime.slice(0, 13)}Z run; 6-h chances ${f.periods.map((p) => Math.round(p.pop * 100)).join(' / ')}%` },
      ...(grid?.pop_max_pct != null ? [{ label: 'Official NWS forecast: highest hourly chance in window', value: grid.pop_max_pct, unit: '%', detail: grid.qpf_in != null ? `forecast amount ${grid.qpf_in.toFixed(2)} in; issued ${grid.update_time}` : `issued ${grid.update_time}` }] : []),
      ...(analog ? [{ label: 'Comparable-condition rate', value: pct(analog.rate), unit: '%', detail: `${analog.n} past days at this station with similar NWS guidance (${analog.bin})${analog.n < 30 ? ' — small sample' : ''}` }] : []),
    ];
    return {
      status: 'OK', model, features, featureSources, probability: publishable(pred.probability), rawProbability: pred.probability,
      confidence, evidence, provenance, explanation: { contributions: pred.contributions, artifact_version: precipArtifact.version, quality_rules: QUALITY_RULES_VERSION, run_age_h: +runAgeH.toFixed(1) },
      dataCutoffAt: runAvailableAt(mos.runtime), inputs: { mos_runtime: mos.runtime, grid_update: grid?.update_time ?? null },
    };
  }

  // MAX_TEMP_BUCKET
  const g = maxTempGuidance(mos.rows, date);
  if (g === null) return { status: 'INCOMPLETE_GUIDANCE' };
  const table = residualTable(tempArtifact, contract.station_id, runLeadH);
  const { features, featureSources } = buildFeatureVector([
    { name: 'mos_max_temp_guidance_f', value: g, source: src.mos },
    { name: 'run_lead_hours', value: +runLeadH.toFixed(2), source: src.mos },
    { name: 'guidance_error_table', value: `${contract.station_id}:${table.bucket}:${table.source}:n=${table.n}`, source: { ...src.mos, provider: 'PBE calibration temp-v1 (GFS MOS vs CLI, 2023-01..2025-06)', sourceClass: 'research' } },
  ]);
  const p = bucketProbability(tempArtifact, table, g, { comparator: contract.comparator, low: contract.threshold_low === null ? null : Number(contract.threshold_low), high: contract.threshold_high === null ? null : Number(contract.threshold_high) });
  const confidence = table.source === 'station' && table.n >= 300 && runAgeH <= 12 && runLeadH <= 30 ? 'HIGH' : runAgeH <= 24 ? 'MEDIUM' : 'LOW';
  const evidence = [
    ...(clim?.maxt_mean_1991_2020 != null ? [{ label: 'Normal high for the date (1991-2020)', value: Math.round(clim.maxt_mean_1991_2020), unit: '°F', detail: `typical spread ±${clim.maxt_sd_1991_2020.toFixed(1)}°F` }] : []),
    { label: 'NWS guidance high', value: g, unit: '°F', detail: `GFS MOS ${mos.runtime.slice(0, 13)}Z run` },
    { label: 'Station guidance error (past)', value: Math.round(table.sd * 10) / 10, unit: '°F', detail: `1 sd of reported-minus-guidance at ${contract.station_id}, ${table.bucket} lead, mean ${table.mean >= 0 ? '+' : ''}${table.mean.toFixed(1)}°F, n=${table.n} (${table.source})` },
    ...(grid?.max_temp_f != null ? [{ label: 'Official NWS forecast high', value: grid.max_temp_f, unit: '°F', detail: `issued ${grid.update_time}` }] : []),
  ];
  return {
    status: 'OK', model, features, featureSources, probability: publishable(p), rawProbability: p,
    confidence, evidence, provenance, explanation: { error_table: { bucket: table.bucket, source: table.source, n: table.n, mean: +table.mean.toFixed(2), sd: +table.sd.toFixed(2) }, quality: 'wx-quality/1 temp: HIGH = station table n>=300, run age <=12 h, lead <=30 h', artifact_version: tempArtifact.version, quality_rules: QUALITY_RULES_VERSION, run_age_h: +runAgeH.toFixed(1) },
    dataCutoffAt: runAvailableAt(mos.runtime), inputs: { mos_runtime: mos.runtime, grid_update: grid?.update_time ?? null },
  };
}
