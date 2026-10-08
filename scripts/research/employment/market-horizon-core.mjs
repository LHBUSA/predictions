// Research-only utilities for point-in-time market snapshot auditing.
// Do not import this file in production workers or prediction features.
export const HORIZONS_DAYS = Object.freeze([1, 3, 7, 14]);
export const MAX_QUOTE_AGE_SECONDS = 2 * 60 * 60;

export function archivedWindow(manifestEntry, cutoffSeconds) {
  if (!manifestEntry || manifestEntry.status !== 200 || !manifestEntry.url) return { covered: false, reason: 'NO_ARCHIVE_MANIFEST' };
  let query;
  try { query = new URL(manifestEntry.url).searchParams; } catch { return { covered: false, reason: 'INVALID_ARCHIVE_URL' }; }
  const from = Number(query.get('start_ts'));
  const to = Number(query.get('end_ts'));
  if (!query.has('start_ts') || !query.has('end_ts') || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
    return { covered: false, reason: 'INVALID_ARCHIVE_WINDOW' };
  }
  return (from <= cutoffSeconds && cutoffSeconds <= to)
    ? { covered: true, from, to }
    : { covered: false, reason: 'HORIZON_NOT_ARCHIVED', from, to };
}

export function quoteAt(candles, cutoffSeconds, maxAgeSeconds = MAX_QUOTE_AGE_SECONDS) {
  if (!Array.isArray(candles)) return { status: 'NO_CANDLES' };
  if (!Number.isSafeInteger(cutoffSeconds) || maxAgeSeconds < 0) throw new Error('invalid cutoff or age');
  const valid = candles.filter((c) => Number.isSafeInteger(c?.end_period_ts)
    && c.end_period_ts <= cutoffSeconds
    && c.yes_bid?.close !== null && c.yes_bid?.close !== undefined
    && c.yes_ask?.close !== null && c.yes_ask?.close !== undefined
    && Number.isFinite(Number(c.yes_bid.close)) && Number.isFinite(Number(c.yes_ask.close)))
    .sort((a, b) => b.end_period_ts - a.end_period_ts);
  if (valid.length === 0) return { status: 'NO_QUOTE_AT_CUTOFF' };
  const latest = valid[0];
  const bid = Number(latest.yes_bid.close);
  const ask = Number(latest.yes_ask.close);
  const ageSeconds = cutoffSeconds - latest.end_period_ts;
  if (ageSeconds > maxAgeSeconds) return { status: 'STALE', age_seconds: ageSeconds, candle_end: latest.end_period_ts };
  if (bid < 0 || ask > 1 || bid > ask) return { status: 'INVALID_CROSSED_QUOTE', age_seconds: ageSeconds, candle_end: latest.end_period_ts };
  return { status: 'PRICED', age_seconds: ageSeconds, candle_end: latest.end_period_ts, bid, ask, mid: (bid + ask) / 2, spread: ask - bid };
}

const FLOOR = 1e-4;
export function binaryLogLoss(probability, outcome) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1 || ![0, 1].includes(outcome)) throw new Error('invalid probability or outcome');
  const p = Math.min(1 - FLOOR, Math.max(FLOOR, probability));
  return -(outcome ? Math.log(p) : Math.log(1 - p));
}

export function average(numbers) {
  return numbers.length ? numbers.reduce((sum, v) => sum + v, 0) / numbers.length : null;
}

export function summarizePairedEventScores(events, early = 3, late = 1) {
  const paired = [];
  for (const event of events) {
    const rows = event.contracts.filter((c) => c.prices?.[early]?.status === 'PRICED'
      && c.prices?.[late]?.status === 'PRICED' && [0, 1].includes(c.outcome));
    if (!rows.length || !event.feature_status?.[early] || !event.feature_status?.[late]) continue;
    if (event.feature_status[early] !== 'OK' || event.feature_status[late] !== 'OK') continue;
    const earlyLL = average(rows.map((r) => binaryLogLoss(r.prices[early].mid, r.outcome)));
    const lateLL = average(rows.map((r) => binaryLogLoss(r.prices[late].mid, r.outcome)));
    paired.push({ event: event.event, month: event.month, contracts: rows.length,
      early_log_loss: earlyLL, late_log_loss: lateLL, early_minus_late: earlyLL - lateLL });
  }
  return { events: paired.length, contracts: paired.reduce((sum, p) => sum + p.contracts, 0),
    early_mean_event_log_loss: average(paired.map((p) => p.early_log_loss)),
    late_mean_event_log_loss: average(paired.map((p) => p.late_log_loss)),
    early_minus_late: average(paired.map((p) => p.early_minus_late)),
    detail: paired };
}
