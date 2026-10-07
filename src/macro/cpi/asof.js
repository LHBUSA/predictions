// CPI V1 point-in-time data view.
//
// asOfView() is the only way model code reads source data. It drops every
// record whose publication timestamp is after the cutoff BEFORE any feature
// code runs, so a later release (or a later revision inside one) can never
// leak backward. Features read a value only from the latest release visible
// at the cutoff; that release IS the vintage.

import { addDaysYmd, etToUtcIso } from './timeline.js';

export const EIA_AVAILABLE_AFTER = Object.freeze({ days: 1, hourEt: 17 });

export function eiaAvailableAt(weekDate) {
  return etToUtcIso(addDaysYmd(weekDate, EIA_AVAILABLE_AFTER.days), EIA_AVAILABLE_AFTER.hourEt, 0);
}

function ms(iso, field) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new TypeError(`${field} must be an ISO timestamp`);
  return t;
}

// availability stamps are a pure function of the week date; compute once per list
const stamped = new WeakMap();
function stampWeeks(gasWeeks) {
  let out = stamped.get(gasWeeks);
  if (!out) {
    out = gasWeeks.map((w) => {
      const availableAt = w.availableAt ?? eiaAvailableAt(w.date);
      return Object.freeze({ ...w, availableAt, availableMs: ms(availableAt, 'availableAt') });
    });
    stamped.set(gasWeeks, out);
  }
  return out;
}

export function asOfView({ releases, gasWeeks = [], cutoffAt }) {
  const cutoff = ms(cutoffAt, 'cutoffAt');
  const visible = releases
    .filter((r) => ms(r.releaseAt, 'releaseAt') <= cutoff)
    .sort((a, b) => a.releaseAt.localeCompare(b.releaseAt));
  const weeks = stampWeeks(gasWeeks).filter((w) => w.availableMs <= cutoff);
  const byRef = new Map(visible.map((r) => [r.referenceMonth, r]));
  const latest = visible[visible.length - 1] ?? null;
  return Object.freeze({
    cutoffAt: new Date(cutoff).toISOString(),
    latest,
    releases: Object.freeze(visible),
    gasWeeks: Object.freeze(weeks),
    // value of `key` for `month` as published in the latest visible vintage
    vintage(key, month) {
      if (!latest) return null;
      const v = latest.series[key]?.saMoM?.[month];
      return Number.isFinite(v) ? { value: v, release: latest } : null;
    },
    // first print: the value in the release whose reference month is `month`
    firstPrint(key, month, field = 'saMoM') {
      const r = byRef.get(month);
      if (!r) return null;
      const v = field === 'nsa12m' ? r.series[key]?.nsa12m : r.series[key]?.saMoM?.[month];
      return Number.isFinite(v) ? { value: v, release: r } : null;
    },
    hasRelease(month) {
      return byRef.has(month);
    }
  });
}
