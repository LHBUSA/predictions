function finiteValue(row) {
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : null;
}

function parseMonth(date, field = 'date') {
  const match = /^(\d{4})-(\d{2})/.exec(String(date ?? ''));
  if (!match) throw new TypeError(`${field} must begin with YYYY-MM`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new RangeError(`${field} month must be 01-12`);
  return { year, month };
}

export function monthKey(date) {
  const { year, month } = parseMonth(date);
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function shiftMonthKey(date, deltaMonths) {
  if (!Number.isInteger(deltaMonths)) throw new TypeError('deltaMonths must be an integer');
  const { year, month } = parseMonth(date);
  const index = (year * 12) + (month - 1) + deltaMonths;
  const shiftedYear = Math.floor(index / 12);
  const shiftedMonth = (index % 12 + 12) % 12;
  return `${shiftedYear}-${String(shiftedMonth + 1).padStart(2, '0')}`;
}

export function usableMonthlyObservations(series) {
  return (series?.observations ?? [])
    .filter((row) => finiteValue(row) !== null && row?.date)
    .map((row) => Object.freeze({ ...row, value: Number(row.value), month: monthKey(row.date) }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

export function observationForMonth(series, targetMonth, field = 'series') {
  const target = monthKey(`${targetMonth}-01`);
  const row = usableMonthlyObservations(series).find((item) => item.month === target);
  if (!row) throw new Error(`missing ${field} observation for ${target}`);
  return row;
}

export function latestMonthlyObservation(series, field = 'series', offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer');
  const observations = usableMonthlyObservations(series);
  const row = observations[offset];
  if (!row) throw new Error(`missing usable observation for ${field} at offset ${offset}`);
  return row;
}

export function percentChangeCalendarMonths(series, monthsBack, field = 'series', offset = 0) {
  if (!Number.isInteger(monthsBack) || monthsBack <= 0) throw new RangeError('monthsBack must be a positive integer');
  const current = latestMonthlyObservation(series, field, offset);
  const priorMonth = shiftMonthKey(current.month, -monthsBack);
  const prior = observationForMonth(series, priorMonth, field);
  if (prior.value === 0) throw new Error(`invalid zero denominator for ${field}`);
  return ((current.value / prior.value) - 1) * 100;
}

export function levelChangeCalendarMonths(series, monthsBack, field = 'series', offset = 0) {
  if (!Number.isInteger(monthsBack) || monthsBack <= 0) throw new RangeError('monthsBack must be a positive integer');
  const current = latestMonthlyObservation(series, field, offset);
  const prior = observationForMonth(series, shiftMonthKey(current.month, -monthsBack), field);
  return current.value - prior.value;
}
