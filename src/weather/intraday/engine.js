// Weather INTRADAY v2 engine (separate model generation; never edits or replaces pre-window v1.x forecasts).
// For contracts whose CLI climate-day window has started (observation_start <= now < observation_end).
//   MAX_TEMP_BUCKET -> pbe-weather-maxtemp-intraday@2.0.0   PRECIP_ANY -> pbe-weather-precip-intraday@2.0.0
// Inputs are domain data only: exact-station ASOS observations valid inside the window and published by `now`,
// NWS NBM / GFS MOS guidance runs usable at cycle + 5 h (<= 24 h old), station climatology. No market data.
//
// forecastIntraday(contract, sources, { now, strict })
//   sources = { obs: [{ station, valid_at, available_at, tmpf, p01i, trace? }],
//               nbm: run | run[],  mos: run | run[]      (run = { icao, runtime, rows, url, observationKey }) }
// Observations outside the window or not yet available are never used (strict: true -> PointInTimeError instead).
import tempArtifact from '../artifacts/temp-intraday-v2.0.json' with { type: 'json' };
import tempArtifact21 from '../artifacts/temp-intraday-v2.1.json' with { type: 'json' };
import precipArtifact from '../artifacts/precip-intraday-v2.0.json' with { type: 'json' };
import { cliStation } from '../stations.js';
import { runAvailableAt } from '../mos.js';
import { integerRange } from '../temp-model.js';
import { climatologyFor } from '../engine.js';
import { buildFeatureVector, assertModelInput, assertContractTermsOnly } from '../../engine/leakage.js';
import { canonicalJson } from '../../engine/evidence.js';
import { usableObs, assertPointInTime, obsSummary, obsMax6, usableRuns, dayMaxFromRuns, remainingPop, PointInTimeError, OBS_PUBLICATION_LAG_MIN } from './features.js';
import { tableHour, tempFinalDistribution, tempAnchor, rangeProbability, tempCellSample, belowRate, precipIntradayProbability, stationGroup } from './models.js';
import { sha256Hex } from './sha256.js';

export const INTRADAY_MODELS = Object.freeze({
  MAX_TEMP_BUCKET: Object.freeze({ id: tempArtifact.model_id, version: tempArtifact.version, state: tempArtifact.state }),
  PRECIP_ANY: Object.freeze({ id: precipArtifact.model_id, version: precipArtifact.version, state: precipArtifact.state }),
});
// Max-temp intraday versions, selected per call ({ tempModelVersion }). 2.0.0 = hourly/special tmpf only (default, unchanged);
// 2.1.0 = also the METAR 6-hour maximum groups (obs rows must carry max6_f: number|null).
export const INTRADAY_TEMP_MODELS = Object.freeze({
  '2.0.0': Object.freeze({ id: tempArtifact.model_id, version: tempArtifact.version, state: tempArtifact.state }),
  '2.1.0': Object.freeze({ id: tempArtifact21.model_id, version: tempArtifact21.version, state: tempArtifact21.state }),
});
const TEMP_ARTIFACTS = Object.freeze({ '2.0.0': tempArtifact, '2.1.0': tempArtifact21 });
export const INTRADAY_QUALITY_RULES = 'wx-intraday-quality/1';
export { PointInTimeError };

const H = 3600000;
const pct = (p) => Math.round(p * 100);
// whole-percent publication precision; 1% / 99% is the publication floor/ceiling, the calibrated value stays in rawProbability
export const publishableIntraday = (p) => Math.min(0.99, Math.max(0.01, Math.round(p * 100) / 100));
const asRuns = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// wx-intraday-quality/1: HIGH = newest ob <= 90 min old, NBM guidance, calibration cell sample >= 30;
// LOW = newest ob > 3 h old or guidance run > 18 h old; MEDIUM otherwise.
export function gradeIntraday({ lastObAgeMin, guidanceKind, guidanceAgeH, cellN }) {
  if (lastObAgeMin == null || lastObAgeMin > 180 || (guidanceAgeH != null && guidanceAgeH > 18)) return 'LOW';
  if (lastObAgeMin <= 90 && guidanceKind === 'nbm' && (cellN == null || cellN >= 30)) return 'HIGH';
  return 'MEDIUM';
}

// allowGfsFallback: the 2023-2026 archive had a usable NBM run at every intraday cutoff, so the GFS-MOS-only path has
// no training cases (temp: 0 train / 129 val+holdout; rain: 0). It is OFF by default (fails closed: INCOMPLETE_GUIDANCE).
export function forecastIntraday(contract, sources, { now, strict = false, allowGfsFallback = false, tempModelVersion = '2.0.0' } = {}) {
  assertContractTermsOnly(contract); // a contract reaches the model as terms only
  if (!INTRADAY_MODELS[contract.event_type]) return { status: 'UNSUPPORTED_EVENT_TYPE' };
  const tArt = TEMP_ARTIFACTS[tempModelVersion];
  if (contract.event_type === 'MAX_TEMP_BUCKET' && !tArt) throw new RangeError(`unknown maxtemp-intraday version ${tempModelVersion}`);
  const v21 = contract.event_type === 'MAX_TEMP_BUCKET' && tempModelVersion === '2.1.0';
  const model = contract.event_type === 'MAX_TEMP_BUCKET' ? INTRADAY_TEMP_MODELS[tempModelVersion] : INTRADAY_MODELS[contract.event_type];
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be an ISO timestamp');
  const win = { start: contract.observation_start, end: contract.observation_end };
  if (nowMs < Date.parse(win.start)) return { status: 'WINDOW_NOT_STARTED', model };
  if (nowMs >= Date.parse(win.end)) return { status: 'WINDOW_CLOSED', model };
  const st = cliStation(contract.station_id);
  if (!st || st.cli !== contract.station_id) return { status: 'STATION_MISMATCH', model };
  const allObs = assertModelInput(sources?.obs || []); // no venue-derived key may ride along on an observation row
  if (allObs.some((r) => r.station !== st.icao)) return { status: 'STATION_MISMATCH', model, reason: 'observation from another station' };
  const nbmAll = asRuns(sources?.nbm); const mosAll = asRuns(sources?.mos);
  if ([...nbmAll, ...mosAll].some((r) => r.icao !== st.icao)) return { status: 'STATION_MISMATCH', model, reason: 'guidance for another station' };

  const used = usableObs(allObs, win, now);
  const excluded = allObs.length - used.length;
  if (strict && excluded) assertPointInTime(allObs, win, now); // throws on the first offending row
  assertPointInTime(used, win, now); // invariant: nothing outside the window or after the cutoff
  const date = contract.detail?.climate_date;
  const hoursIn = (nowMs - Date.parse(win.start)) / H;
  const hoursLeft = (Date.parse(win.end) - nowMs) / H;
  const summary = obsSummary(used, win);
  const nbm = usableRuns(nbmAll, now); const mos = allowGfsFallback ? usableRuns(mosAll, now) : [];
  const obsSrc = { sourceClass: 'official', provider: `NWS/FAA ASOS ${st.icao} (METAR)`, sourceId: `asos:${st.icao}:${win.start}`, observationKey: summary.last_valid_at };
  const lastObAgeMin = summary.last_valid_at ? (nowMs - Date.parse(summary.last_valid_at)) / 60000 : null;
  const provenance = [
    { source: `ASOS observations ${st.icao}`, provider: 'NOAA/NWS + FAA ASOS (METAR), via api.weather.gov or the IEM ASOS archive', station: st.icao, count: used.length, first_valid_at: used[0]?.valid_at ?? null, last_valid_at: summary.last_valid_at, publication_lag_min: OBS_PUBLICATION_LAG_MIN, role: 'model input' },
    { source: 'Contract resolution', provider: contract.resolution_authority, dataset: contract.resolution_dataset, verification: contract.verification_dataset, role: 'resolution' },
  ];
  const runProv = (run, kind) => ({ source: kind === 'nbm' ? 'NWS National Blend of Models (NBS) station guidance' : 'NWS GFS MOS (MAV) station guidance', provider: 'NOAA/NWS via Iowa Environmental Mesonet', station: st.icao, run: run.runtime, available_at: runAvailableAt(run.runtime), url: run.url ?? null, role: 'model input' });
  const runSrc = (run, kind) => ({ sourceClass: 'official', provider: kind === 'nbm' ? 'NWS National Blend of Models (NBS) via IEM' : 'NWS GFS MOS (MAV) via IEM', sourceId: `mos:${kind === 'nbm' ? 'NBS' : 'GFS'}:${st.icao}:${run.runtime}`, observationKey: run.observationKey ?? null });
  const obsCanon = used.map((r) => (v21 ? [r.valid_at, r.tmpf, r.p01i, r.trace ? 1 : 0, r.max6_f ?? null] : [r.valid_at, r.tmpf, r.p01i, r.trace ? 1 : 0]));
  const contractCanon = { event_type: contract.event_type, station_id: contract.station_id, observation_start: win.start, observation_end: win.end, climate_date: date, comparator: contract.comparator ?? null, threshold_low: contract.threshold_low ?? null, threshold_high: contract.threshold_high ?? null };
  const cutoff = (runs) => new Date(Math.max(...used.map((r) => Date.parse(r.available_at)), ...runs.map((r) => Date.parse(runAvailableAt(r.runtime))))).toISOString();

  if (contract.event_type === 'MAX_TEMP_BUCKET') {
    if (summary.n_temp === 0) return { status: 'NO_OBSERVATIONS', model };
    // v2.1 needs the 6-h max field on every row (null = no group in that report); without it the table would be fed an
    // hourly-only max it was not calibrated on.
    if (v21 && used.some((r) => !Object.prototype.hasOwnProperty.call(r, 'max6_f'))) return { status: 'INCOMPLETE_OBSERVATIONS', model, reason: 'maxtemp-intraday 2.1.0 requires max6_f (number|null) on every observation row' };
    const six = v21 ? obsMax6(used, win) : null;
    const obsMaxF = six?.max6_f != null ? Math.max(summary.obs_max_f, six.max6_f) : summary.obs_max_f;
    const gn = dayMaxFromRuns(nbm, date, 'nbm'); const gg = gn ? null : dayMaxFromRuns(mos, date, 'gfs');
    const guid = gn || gg; const kind = gn ? 'nbm' : 'gfs';
    if (!guid) return { status: 'INCOMPLETE_GUIDANCE', model };
    const run = (kind === 'nbm' ? nbm : mos).find((r) => r.runtime === guid.runtime);
    const h = tableHour(hoursIn);
    const x = assertModelInput({ station: st.cli, h, M: Math.round(obsMaxF), D: Math.round(summary.current_f), g: guid.max });
    const dist = tempFinalDistribution(tArt, x);
    const anchor = tempAnchor(tArt, x);
    const [lo, hi] = integerRange({ comparator: contract.comparator, low: contract.threshold_low === null ? null : Number(contract.threshold_low), high: contract.threshold_high === null ? null : Number(contract.threshold_high) });
    const raw = rangeProbability(dist, lo, hi);
    const cellN = tempCellSample(tArt, x);
    const pBelow = rangeProbability(dist, -Infinity, x.M - 1);
    const below = tArt.below_obs_max ? belowRate(tArt, x) : null;
    const { features, featureSources } = buildFeatureVector([
      { name: 'obs_max_so_far_f', value: obsMaxF, source: obsSrc },
      ...(v21 ? [{ name: 'obs_max_hourly_f', value: summary.obs_max_f, source: obsSrc }, { name: 'obs_max6_so_far_f', value: six.max6_f, source: obsSrc }, { name: 'obs_max6_groups', value: six.n, source: obsSrc }] : []),
      { name: 'obs_max_so_far_int_f', value: x.M, source: obsSrc },
      { name: 'current_temp_f', value: summary.current_f, source: obsSrc },
      { name: 'obs_count', value: summary.n_temp, source: obsSrc },
      { name: 'hours_into_window_lst', value: +hoursIn.toFixed(2), source: obsSrc },
      { name: 'calibration_hour_lst', value: h, source: obsSrc },
      { name: 'guidance_max_temp_f', value: guid.max, source: runSrc(run, kind) },
      { name: 'guidance_kind', value: kind, source: runSrc(run, kind) },
      { name: 'guidance_gap_f', value: Math.round(guid.max) - x.M, source: runSrc(run, kind) },
      { name: 'drop_from_max_f', value: x.M - x.D, source: obsSrc },
      { name: 'intraday_table', value: `${tArt.version}:${st.cli}:${tArt.anchor}:${Object.entries(cellN).map(([k, n]) => `${k}=${n}`).join(',')}`, source: { sourceClass: 'research', provider: `PBE calibration maxtemp-intraday ${tArt.version} (ASOS + guidance vs CLI, 2023-01..2025-06)`, sourceId: `artifact:temp-intraday-v${tArt.version.slice(0, 3)}`, observationKey: null } },
    ]);
    const deepest = cellN[tArt.levels[tArt.levels.length - 1]];
    const confidence = gradeIntraday({ lastObAgeMin, guidanceKind: kind, guidanceAgeH: (nowMs - Date.parse(guid.runtime)) / H, cellN: cellN.hour_gap_drop });
    const inputHash = sha256Hex(canonicalJson({ model: `${model.id}@${model.version}`, contract: contractCanon, obs: obsCanon, guidance: { kind, runtime: guid.runtime, max: guid.max }, model_input: x }));
    return {
      status: 'OK', model, features, featureSources, probability: publishableIntraday(raw), rawProbability: raw, confidence,
      evidence: [
        { label: 'Observed high so far (ASOS)', value: x.M, unit: '°F', detail: `hourly max ${summary.obs_max_f.toFixed(1)}°F at ${summary.obs_max_at}${six?.max6_f != null ? `; 6-hour max group ${six.max6_f.toFixed(1)}°F (report ${six.max6_at})` : ''}; ${summary.n_temp} reports since the climate day opened` },
        { label: 'Current temperature', value: x.D, unit: '°F', detail: `report valid ${summary.last_valid_at}` },
        { label: kind === 'nbm' ? 'National Blend of Models high' : 'GFS MOS guidance high', value: guid.max, unit: '°F', detail: `${guid.runtime.slice(0, 13)}Z run` },
        { label: 'Chance the final reported high ends below the observed high', value: Math.round(pBelow * 1000) / 10, unit: '%', detail: below ? `ASOS vs NWS CLI integer disagreement: ${below.below}/${below.n} past cases in this hour/guidance cell (all CLI sites, 2023-01..2025-06), shrunk to the hourly rate — calibrated, not a fixed bound` : 'calibrated from 2023-01..2025-06 history' },
        { label: 'Hours left in the climate day', value: +hoursLeft.toFixed(1), unit: 'h', detail: `CLI day = local standard time; calibration hour ${h}` },
      ],
      provenance: [provenance[0], runProv(run, kind), provenance[1]],
      explanation: {
        method: tArt.method, anchor: tArt.anchor, anchor_value: anchor, integer_range: [lo, hi], calibration_cells: cellN, deepest_cell_n: deepest,
        station_group: stationGroup(st.cli), observations_excluded: excluded, prob_below_observed_max: +pBelow.toFixed(5), below_obs_max_cell: below, quality_rules: INTRADAY_QUALITY_RULES, model_state: model.state,
        holdout: tArt.holdout ? { gate: tArt.holdout.gate } : null,
      },
      dataCutoffAt: cutoff([run]), inputHash,
    };
  }

  // PRECIP_ANY
  if (used.length === 0) return { status: 'NO_OBSERVATIONS', model };
  const clim = climatologyFor(st.cli, date);
  const measuredInWindow = summary.measurable && !summary.measurable_straddle_only;
  let rem = null; let remKind = null; let remRuns = [];
  const rn = remainingPop(nbm, now, win.end);
  if (rn) { rem = rn; remKind = 'nbm'; remRuns = nbm.filter((r) => rn.runs.includes(r.runtime)); }
  else { const rg = remainingPop(mos, now, win.end); if (rg) { rem = rg; remKind = 'gfs'; remRuns = mos.filter((r) => rg.runs.includes(r.runtime)); } }
  if (!measuredInWindow && (!rem || clim?.precip_rate_1991_2020 == null)) return { status: 'INCOMPLETE_GUIDANCE', model };
  const x = assertModelInput({
    station: st.cli, measured_in_window: measuredInWindow, straddle: summary.measurable_straddle_only, trace: summary.trace,
    rem_pop: rem ? +rem.pop.toFixed(4) : null, rem_h: +hoursLeft.toFixed(2), rem_src: remKind, clim_rate: clim?.precip_rate_1991_2020 ?? null,
  });
  const pred = precipIntradayProbability(precipArtifact, x);
  const totalIn = used.reduce((s, r) => s + (Number.isFinite(r.p01i) && r.p01i > 0 ? r.p01i : 0), 0);
  const climSrc = { sourceClass: 'official', provider: 'NOAA RCC-ACIS', sourceId: `acis:${st.ghcn}:climatology-v1`, observationKey: null };
  const entries = [
    { name: 'measurable_precip_observed', value: measuredInWindow, source: obsSrc },
    { name: 'measurable_precip_first_report_only', value: summary.measurable_straddle_only, source: obsSrc },
    { name: 'trace_precip_observed', value: summary.trace, source: obsSrc },
    { name: 'obs_count', value: used.length, source: obsSrc },
    { name: 'hours_into_window_lst', value: +hoursIn.toFixed(2), source: obsSrc },
    { name: 'hours_remaining', value: x.rem_h, source: obsSrc },
    ...(rem ? [{ name: 'remaining_pop', value: x.rem_pop, source: runSrc(remRuns[0], remKind) }, { name: 'remaining_pop_kind', value: remKind, source: runSrc(remRuns[0], remKind) }] : []),
    ...(clim?.precip_rate_1991_2020 != null ? [{ name: 'climatology_rate_1991_2020', value: clim.precip_rate_1991_2020, source: climSrc }] : []),
  ];
  const { features, featureSources } = buildFeatureVector(entries);
  const usedRuns = measuredInWindow ? [] : remRuns;
  const confidence = gradeIntraday({ lastObAgeMin, guidanceKind: measuredInWindow ? 'nbm' : remKind, guidanceAgeH: usedRuns.length ? (nowMs - Date.parse(usedRuns[0].runtime)) / H : null, cellN: measuredInWindow ? pred.bound.n : null });
  const inputHash = sha256Hex(canonicalJson({ model: `${model.id}@${model.version}`, contract: contractCanon, obs: obsCanon, guidance: usedRuns.map((r) => r.runtime), model_input: x }));
  return {
    status: 'OK', model, features, featureSources, probability: publishableIntraday(pred.probability), rawProbability: pred.probability, confidence,
    evidence: [
      { label: 'Measured rain so far (ASOS)', value: Math.round(totalIn * 100) / 100, unit: 'in', detail: measuredInWindow ? 'measurable rain reported inside the climate day' : summary.measurable_straddle_only ? 'measurable only in the first report (may include rain before the window opened)' : summary.trace ? 'trace only (counts as 0)' : 'none reported' },
      ...(measuredInWindow ? [{ label: 'Historical agreement: ASOS measurable -> final CLI measurable', value: Math.round(pred.bound.p * 1000) / 10, unit: '%', detail: `${pred.bound.yes}/${pred.bound.n} station-days at ${pred.bound.source === 'station' ? st.cli : 'all CLI sites'} (2023-01..2025-06), empirical-Bayes shrunk` }] : []),
      ...(rem ? [{ label: 'Guidance chance of rain in the remaining hours', value: pct(rem.pop), unit: '%', detail: `${remKind === 'nbm' ? 'National Blend' : 'GFS MOS'} 6-h periods, ${rem.hours.toFixed(1)} h left` }] : []),
      ...(clim?.precip_rate_1991_2020 != null ? [{ label: 'Historical seasonal rate (full day)', value: pct(clim.precip_rate_1991_2020), unit: '%', detail: '1991-2020, ±10 days' }] : []),
    ],
    provenance: [provenance[0], ...usedRuns.map((r) => runProv(r, remKind)), ...(clim ? [{ source: 'Station climatology 1991-2020', provider: 'NOAA Regional Climate Centers ACIS', station: st.ghcn, artifact: 'climatology-v1', role: 'model input' }] : []), provenance[1]],
    explanation: { branch: pred.branch, bound: pred.bound ?? null, contributions: pred.contributions ?? null, observations_excluded: excluded, station_group: stationGroup(st.cli), quality_rules: INTRADAY_QUALITY_RULES, model_state: model.state, holdout: precipArtifact.holdout ? { gate: precipArtifact.holdout.gate } : null },
    dataCutoffAt: cutoff(usedRuns), inputHash,
  };
}
