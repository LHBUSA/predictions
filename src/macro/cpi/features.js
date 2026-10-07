// CPI V1 feature manifest and builder.
//
// Each feature records the exact inputs it read (source, vintage release,
// publication timestamp). buildFeatures() asserts every input was published at
// or before the cutoff and returns a missing-reason instead of a value when an
// input does not exist. Nothing is ever defaulted to 0 or to a proxy.

import { asOfView } from './asof.js';
import { addMonths, lastDayOfMonth } from './timeline.js';

export const FEATURE_VERSION = 'cpi-features/1';

const BLS = 'bls_cpi_release_table_a';
const EIA = 'eia_weekly_retail_gasoline';

function vintageMean(view, key, refMonth, lags) {
  const inputs = [];
  let sum = 0;
  for (const lag of lags) {
    const month = addMonths(refMonth, -lag);
    const v = view.vintage(key, month);
    if (!v) return { missing: `${key} SA m/m for ${month} not in vintage ${view.latest?.referenceMonth ?? 'none'}` };
    sum += v.value;
    inputs.push({ source: BLS, series: key, month, vintage: v.release.id, publishedAt: v.release.releaseAt });
  }
  return { value: sum / lags.length, inputs };
}

function firstPrint(view, key, month, field = 'saMoM') {
  const v = view.firstPrint(key, month, field);
  if (!v) return { missing: `${key} ${field} first print for ${month} not available` };
  return { value: v.value, inputs: [{ source: BLS, series: key, field, month, vintage: v.release.id, publishedAt: v.release.releaseAt }] };
}

function monthAvgLog(weeks, month) {
  const inMonth = weeks.filter((w) => w.date.startsWith(month));
  if (inMonth.length < 3) return null;
  return { value: inMonth.reduce((s, w) => s + Math.log(w.price), 0) / inMonth.length, weeks: inMonth };
}

// EIA gasoline: log change of the reference-month average over the previous
// month (x100), minus the mean same-calendar-month change of the previous ten
// complete years (a seasonal norm computed only from data visible at cutoff).
function gasolineSeasonalChange(view, refMonth) {
  const weeks = view.gasWeeks;
  const cur = monthAvgLog(weeks, refMonth);
  const prev = monthAvgLog(weeks, addMonths(refMonth, -1));
  if (!cur || !prev) return { missing: `EIA weeks for ${addMonths(refMonth, -1)}..${refMonth} not available at cutoff` };
  // the reference month must be fully observed: its last Monday must be visible
  const lastDay = lastDayOfMonth(refMonth);
  const lastMonday = (() => {
    const d = new Date(`${lastDay}T00:00:00Z`);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const complete = weeks.some((w) => w.date === lastMonday);
  const raw = 100 * (cur.value - prev.value);
  const norms = [];
  for (let y = 1; y <= 10; y += 1) {
    const m = addMonths(refMonth, -12 * y);
    const a = monthAvgLog(weeks, m);
    const b = monthAvgLog(weeks, addMonths(m, -1));
    if (a && b) norms.push(100 * (a.value - b.value));
  }
  if (norms.length < 5) return { missing: `fewer than 5 seasonal-norm years for ${refMonth}` };
  const norm = norms.reduce((s, v) => s + v, 0) / norms.length;
  const used = [...prev.weeks, ...cur.weeks];
  return {
    value: raw - norm,
    complete,
    inputs: used.map((w) => ({ source: EIA, week: w.date, publishedAt: w.availableAt }))
      .concat([{ source: EIA, seasonalNormYears: norms.length }])
  };
}

// Feature definitions. `kind` documents the economic content for the manifest.
export const FEATURES = Object.freeze({
  H_L1: { kind: 'headline SA m/m, month M-1, latest vintage', build: (v, m) => vintageMean(v, 'headline', m, [1]) },
  H_AVG3: { kind: 'headline SA m/m, mean M-3..M-1, latest vintage', build: (v, m) => vintageMean(v, 'headline', m, [1, 2, 3]) },
  C_L1: { kind: 'core SA m/m, month M-1, latest vintage', build: (v, m) => vintageMean(v, 'core', m, [1]) },
  C_AVG3: { kind: 'core SA m/m, mean M-3..M-1, latest vintage', build: (v, m) => vintageMean(v, 'core', m, [1, 2, 3]) },
  C_AVG6: { kind: 'core SA m/m, mean M-6..M-1, latest vintage', build: (v, m) => vintageMean(v, 'core', m, [1, 2, 3, 4, 5, 6]) },
  F_L1: { kind: 'food SA m/m, month M-1, latest vintage', build: (v, m) => vintageMean(v, 'food', m, [1]) },
  E_L1: { kind: 'energy SA m/m, month M-1, latest vintage', build: (v, m) => vintageMean(v, 'energy', m, [1]) },
  GAS_SA: { kind: 'EIA retail gasoline log change M vs M-1 (x100) less 10y same-month norm', build: (v, m) => gasolineSeasonalChange(v, m) },
  H_YOY_L1: { kind: 'headline NSA 12-month change, month M-1, as published', build: (v, m) => firstPrint(v, 'headline', addMonths(m, -1), 'nsa12m') },
  C_YOY_L1: { kind: 'core NSA 12-month change, month M-1, as published', build: (v, m) => firstPrint(v, 'core', addMonths(m, -1), 'nsa12m') },
  H_BASE: { kind: 'headline SA m/m first print for M-12 (base month leaving the 12-month window)', build: (v, m) => firstPrint(v, 'headline', addMonths(m, -12)) },
  C_BASE: { kind: 'core SA m/m first print for M-12 (base month leaving the 12-month window)', build: (v, m) => firstPrint(v, 'core', addMonths(m, -12)) }
});

// Targets. `level` maps a YoY target to the change it is modelled as.
export const TARGETS = Object.freeze({
  headline_mom: { series: 'headline', field: 'saMoM', anchor: null, kalshiSeries: 'KXCPI' },
  core_mom: { series: 'core', field: 'saMoM', anchor: null, kalshiSeries: 'KXCPICORE' },
  headline_yoy: { series: 'headline', field: 'nsa12m', anchor: 'H_YOY_L1', kalshiSeries: 'KXCPIYOY' },
  core_yoy: { series: 'core', field: 'nsa12m', anchor: 'C_YOY_L1', kalshiSeries: 'KXCPICOREYOY' }
});

export function targetValue(release, target) {
  const t = TARGETS[target];
  const s = release.series[t.series];
  const v = t.field === 'nsa12m' ? s?.nsa12m : s?.saMoM?.[release.referenceMonth];
  return Number.isFinite(v) ? v : null;
}

export function buildFeatures({ releases, gasWeeks, referenceMonth, cutoffAt, names = Object.keys(FEATURES) }) {
  const view = asOfView({ releases, gasWeeks, cutoffAt });
  if (view.hasRelease(referenceMonth)) {
    throw new Error(`cutoff ${cutoffAt} is after the ${referenceMonth} CPI release; the target would be visible`);
  }
  const cutoffMs = Date.parse(view.cutoffAt);
  const values = {};
  const provenance = {};
  const missing = {};
  for (const name of names) {
    const out = FEATURES[name].build(view, referenceMonth);
    if (out.missing) {
      missing[name] = out.missing;
      continue;
    }
    for (const input of out.inputs) {
      if (input.publishedAt && Date.parse(input.publishedAt) > cutoffMs) {
        throw new Error(`LEAK: ${name} input published ${input.publishedAt} after cutoff ${view.cutoffAt}`);
      }
    }
    values[name] = out.value;
    provenance[name] = { inputs: out.inputs, ...(out.complete === false ? { partialMonth: true } : {}) };
  }
  return {
    featureVersion: FEATURE_VERSION,
    referenceMonth,
    cutoffAt: view.cutoffAt,
    vintage: view.latest?.id ?? null,
    vintagePublishedAt: view.latest?.releaseAt ?? null,
    values,
    provenance,
    missing
  };
}
