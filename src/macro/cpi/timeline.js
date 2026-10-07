// CPI V1 time helpers. Every timestamp the CPI dataset carries is UTC ISO;
// BLS and EIA publish on US Eastern time, so conversion lives in one place.

const ET = 'America/New_York';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function monthIndex(name) {
  const i = MONTHS.indexOf(String(name).slice(0, 3).toLowerCase());
  if (i < 0) throw new TypeError(`unknown month: ${name}`);
  return i + 1;
}

export function ym(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function addMonths(refMonth, delta) {
  const [y, m] = refMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return ym(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

export function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});

function etOffsetMinutes(utcMs) {
  const parts = ET_FORMAT.formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - utcMs) / 60000);
}

// Wall-clock Eastern time -> UTC ISO. DST-correct for every date in range.
export function etToUtcIso(dateYmd, hour, minute = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) throw new TypeError('dateYmd must be YYYY-MM-DD');
  const [y, mo, d] = dateYmd.split('-').map(Number);
  const naive = Date.UTC(y, mo - 1, d, hour, minute);
  let utc = naive - etOffsetMinutes(naive) * 60000;
  utc = naive - etOffsetMinutes(utc) * 60000;
  return new Date(utc).toISOString();
}

export function addDaysYmd(dateYmd, days) {
  const d = new Date(`${dateYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function lastDayOfMonth(refMonth) {
  const [y, m] = refMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
