// Rates path engine (RESEARCH). Live input: U.S. Treasury Daily Par Yield Curve CSV (the settlement source).
import ratesArtifact from './artifacts/rates-path-v1.json' with { type: 'json' };
import { ewmaSigma, simulateExtremes, crossProbability, seedFrom } from './rates-model.js';
import { buildFeatureVector, assertModelInput, assertContractTermsOnly } from '../engine/leakage.js';

export const RATES_MODEL = Object.freeze({ id: ratesArtifact.model_id, version: ratesArtifact.version, state: 'RESEARCH' });
export const TREASURY_CSV = (year) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
const COLUMN = { 5: '5 Yr', 7: '7 Yr', 10: '10 Yr', 30: '30 Yr' };

// Bond-market full closes (SIFMA) on which Treasury publishes no par curve.
export const NO_PUBLICATION = new Set(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24']);

export function parseTreasuryCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = lines.shift().split(',').map((h) => h.replace(/"/g, '').trim());
  return lines.map((l) => {
    const c = l.split(',').map((x) => x.replace(/"/g, '').trim());
    const [m, d, y] = c[0].split('/');
    const row = { date: `${y}-${m}-${d}` };
    for (const [t, col] of Object.entries(COLUMN)) { const i = head.indexOf(col); const v = Number(c[i]); row[t] = i >= 0 && c[i] !== '' && Number.isFinite(v) ? v : null; }
    return row;
  }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)).sort((a, b) => a.date.localeCompare(b.date));
}

export function businessDaysAfter(lastDate, endDate) {
  let n = 0;
  for (let t = Date.parse(`${lastDate}T00:00:00Z`) + 86400000; t <= Date.parse(`${endDate}T00:00:00Z`); t += 86400000) {
    const d = new Date(t); const dow = d.getUTCDay(); const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !NO_PUBLICATION.has(iso)) n += 1;
  }
  return n;
}

// sources: { treasury: { rows, urls, observationKey } }
export function forecastRates(contract, sources, { now }) {
  assertContractTermsOnly(contract); // leakage guard: a contract reaches the model as terms only, never with a venue price
  if (!/^YIELD_PATH_(MAX|MIN)$/.test(contract.event_type)) return { status: 'UNSUPPORTED_EVENT_TYPE' };
  if (Date.parse(now) >= Date.parse(contract.observation_end)) return { status: 'WINDOW_CLOSED' };
  const { tenor, level, direction, period_start: start, period_end: end } = contract.detail;
  const rows = (sources.treasury?.rows || []).filter((r) => r[tenor] !== null && r.date <= now.slice(0, 10));
  if (rows.length < 300) return { status: 'INCOMPLETE_INPUTS' };
  const last = rows.at(-1);
  const inPeriod = rows.filter((r) => r.date >= start && r.date <= end).map((r) => r[tenor]);
  const runMax = inPeriod.length ? Math.max(...inPeriod) : null; const runMin = inPeriod.length ? Math.min(...inPeriod) : null;
  if (direction === 'high' && runMax !== null && runMax > level) return { status: 'DETERMINED_BY_PATH' };
  if (direction === 'low' && runMin !== null && runMin < level) return { status: 'DETERMINED_BY_PATH' };
  const steps = businessDaysAfter(last.date < start ? new Date(Date.parse(`${start}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : last.date, end);
  if (steps === 0) return { status: 'DETERMINED_BY_PATH' };
  const values = rows.map((r) => r[tenor]);
  const changes = values.slice(1).map((v, i) => v - values[i]).slice(-500);
  const sigma = ewmaSigma(changes, ratesArtifact.ewma_lambda);
  const src = { sourceClass: 'official', provider: 'U.S. Treasury Daily Par Yield Curve Rates', sourceId: `treasury-par:${tenor}Y@${last.date}`, observationKey: sources.treasury.observationKey ?? null };
  const { features, featureSources } = buildFeatureVector([
    { name: 'tenor_years', value: tenor, source: src },
    { name: 'last_published_yield', value: last[tenor], source: src },
    { name: 'last_published_date', value: last.date, source: src },
    { name: 'period_running_extreme', value: direction === 'high' ? runMax : runMin, source: src },
    { name: 'remaining_business_days', value: steps, source: src },
    { name: 'ewma_daily_sigma', value: +sigma.toFixed(5), source: src },
  ]);
  const sim = simulateExtremes(assertModelInput({ y0: last[tenor], sigma, steps, paths: ratesArtifact.paths, residuals: ratesArtifact.residuals[String(tenor)], seed: seedFrom(`${tenor}|${start}|${end}|${last.date}`) }));
  const [lo, hi] = ratesArtifact.probability_bounds;
  const raw = crossProbability(sim, assertModelInput({ direction, level }));
  const p = Math.min(hi, Math.max(lo, raw));
  const distBp = Math.round((level - last[tenor]) * 100);
  const staleDays = businessDaysAfter(last.date, now.slice(0, 10));
  const ho = ratesArtifact.holdout_2018_2026;
  return {
    status: 'OK', model: RATES_MODEL, features, featureSources, probability: Math.round(p * 100) / 100, rawProbability: raw,
    confidence: staleDays <= 1 ? 'HIGH' : staleDays <= 3 ? 'MEDIUM' : 'LOW',
    evidence: [
      { label: `Latest official ${tenor}Y par yield`, value: last[tenor].toFixed(2), unit: '%', detail: `U.S. Treasury, ${last.date}` },
      ...(inPeriod.length ? [{ label: `Period ${direction === 'high' ? 'high' : 'low'} so far`, value: (direction === 'high' ? runMax : runMin).toFixed(2), unit: '%', detail: `${inPeriod.length} business days published since ${start}` }] : []),
      { label: 'Distance to threshold', value: `${distBp > 0 ? '+' : ''}${distBp}`, unit: ' bp', detail: `threshold ${level.toFixed(2)}%` },
      { label: 'Daily volatility (EWMA)', value: (sigma * 100).toFixed(1), unit: ' bp', detail: `lambda ${ratesArtifact.ewma_lambda}, last 500 business days` },
      { label: 'Business days left', value: steps, unit: '', detail: `through ${end}` },
    ],
    provenance: [
      { source: 'Daily Treasury Par Yield Curve Rates', provider: 'U.S. Department of the Treasury', url: sources.treasury.urls?.at(-1), latest_value_date: last.date, role: 'model input + settlement source' },
      { source: 'Residual distribution', provider: 'PBE calibration rates-path-v1 (standardized daily changes 1962-2017)', role: 'model input' },
      { source: 'Contract resolution', provider: contract.resolution_authority, dataset: contract.resolution_dataset, verification: contract.verification_dataset, role: 'resolution' },
    ],
    explanation: { artifact_version: ratesArtifact.version, quality_rules: 'rates-quality/1: HIGH if the latest Treasury publication is <= 1 business day old', holdout: { candidate: { brier: ho.candidate.brier, log_loss: ho.candidate.log_loss }, baseline: { brier: ho.baseline.brier, log_loss: ho.baseline.log_loss } } },
    dataCutoffAt: new Date(Math.min(Date.parse(now), Date.parse(`${last.date}T23:59:59Z`))).toISOString(),
    inputs: { last_published_date: last.date },
  };
}

// Official outcome from the Treasury series: YES once crossed; NO only when the full period is published.
export function ratesOfficialOutcome(contract, rows) {
  const { tenor, level, direction, period_start: start, period_end: end } = contract.detail;
  const inP = rows.filter((r) => r.date >= start && r.date <= end && r[tenor] !== null).map((r) => r[tenor]);
  if (!inP.length) return null;
  const ext = direction === 'high' ? Math.max(...inP) : Math.min(...inP);
  const crossed = direction === 'high' ? ext > level : ext < level;
  const complete = rows.some((r) => r.date >= end) || businessDaysAfter(rows.at(-1).date, end) === 0;
  if (!crossed && !complete) return null;
  return { outcome: crossed ? 'YES' : 'NO', value: ext, units: 'percent', basis: `period ${direction} ${start}..${end}` };
}
