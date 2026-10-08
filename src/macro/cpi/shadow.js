// CPI V1 PRIVATE SHADOW: pure forecast/grade logic for the pbe-predictions lane (workers/pbe-predictions/src/cpi-shadow.js).
//
// The frozen artifact (src/macro/artifacts/cpi-v1.json) is used exactly as frozen: no refit, no tuning. One forecast
// run per (target, reference month, T-1D): the inputs are the point-in-time view at the T-1D cutoff, built only from
//   * the as-published BLS ledger (archived release documents, data/cpi/bls-cpi-releases-v1.json) plus BLS releases
//     PBE captured FIRST-SEEN after the ledger (pred_macro_first_seen, observed_at <= cutoff), and
//   * EIA weekly gasoline FIRST-SEEN records only (observed_at <= cutoff). The historical EIA file has no vintage archive,
//     so the runtime never reads it: each week is available from max(EIA publication rule, PBE first observation).
// Market prices are never read. Contract probabilities are translated from the frozen distribution afterwards
// (contracts.js), from contract TERMS only.

import { assertContractTermsOnly, assertMarketFree } from '../../engine/leakage.js';
import { eiaAvailableAt } from './asof.js';
import { HORIZON, knownGap } from './calendar.js';
import { predictFromArtifact } from './artifact.js';
import { ADAPTER_VERSION, eventProbability, translateKalshiMarket } from './contracts.js';
import { makeDistribution, STEP } from './distribution.js';
import { buildFeatures, FEATURE_VERSION, TARGETS, targetValue } from './features.js';
import { MODEL_VERSION } from './models.js';
import { scoreDistribution, thresholdsFor, PROB_FLOOR } from './scoring.js';

export const SHADOW_MODEL_ID = 'pbe-cpi-distribution';
export const SHADOW_TARGETS = Object.freeze(['headline_mom', 'headline_yoy', 'core_yoy']); // owner 2026-10-07; core_mom stays research
export const DESIGNATION_RULES = 'cpi-shadow-t1d/1';
export const GRADING_VERSION = 'cpi-shadow-grade/1';
// sha256 of src/macro/artifacts/cpi-v1.json as committed (test/cpi-shadow.test.js re-hashes the file)
export const ARTIFACT_SHA256 = '6f90eaee42ff7737018a83dc7f3ae1e0c262018a0662f07060edc70100cec20f';
// sha256 of data/cpi/bls-cpi-releases-v1.json, the as-published ledger bundled into the Worker
export const BLS_LEDGER_SHA256 = 'bef950b012f1c74c8988ad8492279460f300fd34cc00ed872f019285d5138f56';
export const EIA_SERIES = 'EMM_EPM0_PTE_NUS_DPG';
export const BLS_SERIES = 'CPI-U Table A';

const round9 = (p) => Math.round(p * 1e9) / 1e9;

export function runId(target, referenceMonth, modelVersion = MODEL_VERSION) {
  return `cpi|${target}|${referenceMonth}|${HORIZON}|${modelVersion}`;
}

export function assertShadowArtifact(artifact) {
  if (artifact.modelVersion !== MODEL_VERSION || artifact.featureVersion !== FEATURE_VERSION || artifact.contractAdapterVersion !== ADAPTER_VERSION) {
    throw new Error(`CPI artifact versions ${artifact.modelVersion}/${artifact.featureVersion}/${artifact.contractAdapterVersion} do not match code ${MODEL_VERSION}/${FEATURE_VERSION}/${ADAPTER_VERSION}`);
  }
  const eligible = Object.entries(artifact.targets).filter(([, t]) => t.shadowEligible).map(([k]) => k).sort();
  if (JSON.stringify(eligible) !== JSON.stringify([...SHADOW_TARGETS].sort())) throw new Error(`artifact SHADOW-eligible targets ${eligible} != approved ${SHADOW_TARGETS}`);
  return artifact;
}

// BLS releases visible at the cutoff: ledger releases, plus first-seen captures observed and published by then.
// A month present in both must agree exactly (the archive document and the first-seen page are the same release).
export function releasesAsOf({ ledger, firstSeenBls = [], cutoffAt }) {
  const cut = Date.parse(cutoffAt);
  const byMonth = new Map(ledger.map((r) => [r.referenceMonth, { release: r, observedAt: r.releaseAt, origin: 'ledger' }]));
  const firstFor = new Map();
  for (const row of [...firstSeenBls].sort((a, b) => a.observed_at.localeCompare(b.observed_at))) {
    if (Date.parse(row.observed_at) > cut) continue;
    const r = row.payload;
    if (!r?.referenceMonth || Date.parse(r.releaseAt) > cut) continue;
    if (!firstFor.has(r.referenceMonth)) firstFor.set(r.referenceMonth, row); // first seen wins
  }
  const conflicts = [];
  for (const [month, row] of firstFor) {
    const have = byMonth.get(month);
    if (have) {
      if (JSON.stringify(have.release.series) !== JSON.stringify(row.payload.series)) conflicts.push(month);
      continue;
    }
    byMonth.set(month, { release: row.payload, observedAt: row.observed_at, origin: 'first_seen', firstSeenId: row.first_seen_id });
  }
  if (conflicts.length) throw new Error(`first-seen BLS release disagrees with the archived ledger for ${conflicts.join(', ')}`);
  const list = [...byMonth.values()].sort((a, b) => a.release.releaseAt.localeCompare(b.release.releaseAt));
  return { releases: list.map((x) => x.release), meta: new Map(list.map((x) => [x.release.referenceMonth, x])) };
}

// EIA weeks visible at the cutoff from first-seen rows only: per week, the latest value PBE had observed by the cutoff.
export function gasWeeksAsOf(firstSeenEia, cutoffAt) {
  const cut = Date.parse(cutoffAt);
  const byWeek = new Map();
  for (const row of firstSeenEia) {
    if (Date.parse(row.observed_at) > cut) continue;
    const cur = byWeek.get(row.period);
    if (!cur || cur.observed_at < row.observed_at) byWeek.set(row.period, row);
  }
  return [...byWeek.values()].sort((a, b) => a.period.localeCompare(b.period)).map((row) => {
    const rule = eiaAvailableAt(row.period);
    return { date: row.period, price: Number(row.value), observedAt: row.observed_at, availableAt: Date.parse(row.observed_at) > Date.parse(rule) ? new Date(Date.parse(row.observed_at)).toISOString() : rule };
  });
}

function featureNames(artifact, target) {
  const names = [...artifact.targets[target].features];
  const anchor = TARGETS[target].anchor;
  if (anchor && !names.includes(anchor)) names.push(anchor);
  return names;
}

function observedSummary(f, meta, gasWeeks) {
  const bls = {};
  const weeks = new Set();
  for (const p of Object.values(f.provenance)) {
    for (const i of p.inputs) {
      if (i.vintage) {
        const m = meta.get(i.vintage.replace(/^bls-cpi:/, ''));
        bls[i.vintage] = { published_at: i.publishedAt, observed_at: m?.observedAt ?? null, origin: m?.origin ?? null, first_seen_id: m?.firstSeenId ?? null };
      }
      if (i.week) weeks.add(i.week);
    }
  }
  const used = gasWeeks.filter((w) => weeks.has(w.date));
  return {
    bls,
    eia: used.length ? { weeks: [used[0].date, used.at(-1).date], count: used.length, latest_observed_at: used.map((w) => w.observedAt).sort().at(-1), latest_available_at: used.map((w) => w.availableAt).sort().at(-1) } : null,
    eia_seasonal_norm: 'mean same-month change over up to 10 prior years, first-seen rows visible at the cutoff'
  };
}

function compactProvenance(prov) {
  const out = {};
  for (const [name, p] of Object.entries(prov)) {
    const bls = p.inputs.filter((i) => i.vintage).map((i) => `${i.series}:${i.field ?? 'saMoM'}:${i.month}@${i.vintage}`);
    const eia = p.inputs.filter((i) => i.week).map((i) => i.week);
    out[name] = { ...(bls.length ? { bls } : {}), ...(eia.length ? { eia_weeks: [eia[0], eia.at(-1)], eia_week_count: eia.length } : {}), ...(p.partialMonth ? { partial_month: true } : {}) };
  }
  return out;
}

function baseRun({ target, release, now, artifactSha }) {
  return {
    run_id: runId(target, release.referenceMonth),
    model_id: SHADOW_MODEL_ID,
    model_version: MODEL_VERSION,
    feature_version: FEATURE_VERSION,
    adapter_version: ADAPTER_VERSION,
    artifact_sha256: artifactSha,
    model_state: 'SHADOW',
    public: false,
    target,
    kalshi_series: TARGETS[target].kalshiSeries,
    reference_month: release.referenceMonth,
    horizon: HORIZON,
    release_at: release.releaseAt,
    cutoff_at: release.cutoffAt,
    forecast_created_at: now,
    contracts: []
  };
}

const noForecast = (run, reason, detail) => ({ ...run, status: 'NO_FORECAST', reason, detail, features: null, distribution: null, median: null, q10: null, q90: null, ladder: null, location: null, scale: null, nu: null });

// Translate contract terms (never prices) into probabilities from a frozen distribution.
export function contractProbabilities(dist, target, referenceMonth, contracts) {
  const out = [];
  for (const c of contracts) {
    assertContractTermsOnly(c); // the whole contract row: a venue price/size field anywhere refuses it
    const terms = { ticker: c.market_id, strike_type: c.comparator, floor_strike: c.threshold_low, cap_strike: c.threshold_high };
    const t = translateKalshiMarket(terms);
    if (t.status !== 'SUPPORTED' || t.target !== target || t.referenceMonth !== referenceMonth) continue;
    const p = eventProbability(dist, t.event);
    out.push({ contract_id: c.contract_id, market_id: c.market_id, event_id: c.event_id, observation_start: c.observation_start, event: t.event, probability: p });
  }
  return out.sort((a, b) => a.event.threshold - b.event.threshold);
}

// One forecast run. `now` must be in [cutoff, release); otherwise the caller records RUNTIME_MISSED_WINDOW.
export function buildShadowRun({ artifact, artifactSha = ARTIFACT_SHA256, target, release, ledger, firstSeenBls, firstSeenEia, contracts = [], now }) {
  if (!SHADOW_TARGETS.includes(target)) throw new Error(`target ${target} is not approved for SHADOW`);
  const run = baseRun({ target, release, now, artifactSha });
  const nowMs = Date.parse(now);
  if (nowMs >= Date.parse(release.releaseAt)) return noForecast(run, 'RUNTIME_MISSED_WINDOW', { note: 'The lane did not run between the T-1D cutoff and the release; no forecast is created after publication.' });
  if (nowMs < Date.parse(release.cutoffAt)) throw new Error('a CPI shadow run is built only after its cutoff');
  const { releases, meta } = releasesAsOf({ ledger, firstSeenBls, cutoffAt: release.cutoffAt });
  const gasWeeks = gasWeeksAsOf(firstSeenEia, release.cutoffAt);
  const f = buildFeatures({ releases, gasWeeks, referenceMonth: release.referenceMonth, cutoffAt: release.cutoffAt, names: featureNames(artifact, target) });
  const gap = knownGap(target, release.referenceMonth);
  if (gap) return noForecast(run, gap.reason, { known_gap: gap.detail, missing: f.missing, vintage: f.vintage });
  if (Object.keys(f.missing).length) return noForecast(run, 'INPUT_UNAVAILABLE', { missing: f.missing, vintage: f.vintage });
  assertMarketFree(f.values);
  const pred = predictFromArtifact(artifact, target, f.values);
  const dist = pred.distribution;
  const ladder = thresholdsFor(target, { features: f.values }).map((t) => ({ threshold: t, p_above: dist.probAbove(t) }));
  return {
    ...run,
    status: 'OK',
    reason: null,
    detail: { vintage: f.vintage, vintage_published_at: f.vintagePublishedAt, ledger_sha256: BLS_LEDGER_SHA256, artifact_dataset_sha256: artifact.dataset?.sha256 ?? null, eia_weeks_visible: gasWeeks.length },
    features: f.values,
    input_provenance: compactProvenance(f.provenance),
    inputs_observed_at: observedSummary(f, meta, gasWeeks),
    location: pred.location,
    scale: pred.scale,
    nu: pred.nu,
    distribution: { lo: dist.support[0], step: STEP, mass: dist.mass },
    median: dist.quantile(0.5),
    q10: dist.quantile(0.1),
    q90: dist.quantile(0.9),
    ladder,
    contracts: contractProbabilities(dist, target, release.referenceMonth, contracts).map(({ contract_id, market_id, event, probability }) => ({ contract_id, market_id, event, probability }))
  };
}

export function distributionOf(run) {
  const { lo, step, mass } = run.distribution;
  return makeDistribution(mass.map((_, i) => Math.round((lo + i * step) * 10) / 10), mass);
}

// pred_forecasts_shadow row for one contract of an OK run (probability from the frozen distribution).
export function shadowContractRow(run, c, { capturedAt, predictiveHash, sourceStateHash, featuresSha }) {
  return {
    record_id: `${c.contract_id}|${SHADOW_MODEL_ID}@${run.model_version}|shadow|${run.run_id}`,
    event_id: c.event_id,
    contract_id: c.contract_id,
    market_id: c.market_id,
    model_id: SHADOW_MODEL_ID,
    model_version: run.model_version,
    model_state: 'SHADOW',
    record_type: 'shadow',
    public: false,
    designation_rules: DESIGNATION_RULES,
    probability: round9(c.probability),
    raw_probability: c.probability,
    captured_at: capturedAt,
    data_cutoff_at: run.cutoff_at,
    confidence: null,
    station_id: null,
    climate_date: null,
    observation_start: c.observation_start,
    predictive_input_hash: predictiveHash,
    source_state_hash: sourceStateHash,
    features: run.features,
    features_sha256: featuresSha,
    provenance: [],
    explanation: { event: c.event, median: run.median, interval_80: [run.q10, run.q90] },
    metadata: { run_id: run.run_id, cpi_target: run.target, reference_month: run.reference_month, release_at: run.release_at, feature_version: run.feature_version, adapter_version: run.adapter_version, artifact_sha256: run.artifact_sha256, frozen_at: run.forecast_created_at }
  };
}

// Grade an OK run against the first-seen BLS release (exact one-decimal published value).
export function gradeRun(run, blsRow, { now, shadowRows = [], venue = new Map() }) {
  const release = blsRow.payload;
  if (release.referenceMonth !== run.reference_month) throw new Error('release month mismatch');
  const actual = targetValue(release, run.target);
  if (actual === null) return null;
  const dist = distributionOf(run);
  const s = scoreDistribution(dist, actual, run.ladder.map((l) => l.threshold));
  const contractScores = shadowRows.map((r) => {
    const t = Number(r.explanation?.event?.threshold);
    const o = actual > t + 1e-9 ? 1 : 0;
    const p = Number(r.raw_probability ?? r.probability);
    const q = Math.min(1 - PROB_FLOOR, Math.max(PROB_FLOOR, p));
    const v = venue.get(r.market_id);
    return { market_id: r.market_id, threshold: t, probability: p, outcome: o, brier: (p - o) ** 2, log_loss: -(o * Math.log(q) + (1 - o) * Math.log(1 - q)), kalshi_result: v?.result ?? null, kalshi_agrees: v?.result ? (v.result === 'yes') === (o === 1) : null };
  });
  const checks = contractScores.filter((c) => c.kalshi_agrees !== null);
  return {
    run_id: run.run_id,
    actual_value: actual,
    actual_first_seen_id: blsRow.first_seen_id,
    actual_published_at: release.releaseAt,
    graded_at: now,
    grading_version: GRADING_VERSION,
    scores: { brier: s.brier, log_loss: s.logLoss, rps: s.rps, bucket_log_score: s.bucketLogScore, abs_error_median: s.absError, pit_low: s.pitLow, pit_high: s.pitHigh, in_80: actual >= Number(run.q10) - 1e-9 && actual <= Number(run.q90) + 1e-9, pairs: s.pairs, thresholds: run.ladder.length },
    contract_scores: contractScores,
    kalshi_cross_check: { contracts_checked: checks.length, all_agree: checks.length ? checks.every((c) => c.kalshi_agrees) : null, expiration_values: [...new Set([...venue.values()].map((v) => v.expiration_value).filter((x) => x !== null && x !== undefined))] }
  };
}
