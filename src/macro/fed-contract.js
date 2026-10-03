// KXFEDDECISION contract normalizer. Outcome identity comes from three venue fields that must agree:
// custom_strike ({"Cut":">25"} ...), yes_sub_title ("Cut >25bps" ...) and the rules text. Kalshi's rules text
// currently drops the ">" character ("Cut of   25bps"); when the structured strike AND the title both carry
// ">", the contract is normalized with that recorded as an exception. Any other disagreement -> HOLD.
import registry from '../../data/fomc/scheduled-decisions.json' with { type: 'json' };

const FED_RE = /^If the Federal Reserve does a (Cut|Hike) of\s+(>\s*)?(\d+)bps on ([A-Z][a-z]+) (\d{1,2}), (\d{4}), then the market resolves to Yes\.?$/;
const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const pad = (n) => String(n).padStart(2, '0');

export const FED_BUCKETS = Object.freeze({
  cut_gt_25: { low: null, high: -50, label: 'Cut >25bps', yes: 'target range lowered by more than 25 bps' },
  cut_25: { low: -25, high: -25, label: 'Cut 25bps', yes: 'target range lowered by exactly 25 bps' },
  hold: { low: 0, high: 0, label: 'Fed maintains rate', yes: 'target range unchanged (or meeting canceled)' },
  hike_25: { low: 25, high: 25, label: 'Hike 25bps', yes: 'target range raised by exactly 25 bps' },
  hike_gt_25: { low: 50, high: null, label: 'Hike >25bps', yes: 'target range raised by more than 25 bps' },
});

function outcomeFromStrike(cs) {
  if (!cs || typeof cs !== 'object') return null;
  const [[dir, raw]] = Object.entries(cs).length === 1 ? Object.entries(cs) : [[null, null]];
  const v = String(raw ?? '').trim();
  if ((dir === 'Hike' || dir === 'Cut') && v === '0') return { outcome: 'hold', gt: false, n: 0 };
  const m = /^(>)?\s*(\d+)$/.exec(v);
  if (!m || !['Cut', 'Hike'].includes(dir)) return null;
  const n = Number(m[2]);
  if (n !== 25) return null;
  return { outcome: `${dir.toLowerCase()}_${m[1] ? 'gt_25' : '25'}`, gt: Boolean(m[1]), n };
}

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

export function meetingFor(date) {
  return registry.meetings.find((m) => m.meetingDate === date) || null;
}

export function normalizeFed(ctx) {
  const { market, event } = ctx;
  if (!/^KXFEDDECISION-/.test(market.ticker || '')) return null;
  const rules = String(market.rules_primary || '').trim();
  const m = FED_RE.exec(rules);
  const base = (status, reason, extra = {}) => ({ __fail: true, status, reason, extra });
  if (!m) return base('UNMODELABLE', 'NO_MACRO_CONTRACT_TEMPLATE');
  const [, dir, gtMark, numText, monthName, day, year] = m;
  const strike = outcomeFromStrike(market.custom_strike);
  if (!strike) return base('HOLD_RESOLUTION_AMBIGUOUS', 'CUSTOM_STRIKE_UNRECOGNIZED', { custom_strike: market.custom_strike });
  const bucket = FED_BUCKETS[strike.outcome];
  if (norm(market.yes_sub_title) !== norm(bucket.label)) return base('HOLD_RESOLUTION_AMBIGUOUS', 'TITLE_DISAGREES_WITH_STRIKE', { title: market.yes_sub_title, outcome: strike.outcome });
  const rulesN = Number(numText);
  const exceptions = ['If the scheduled FOMC meeting is canceled, "Fed maintains rate" resolves YES and all others NO', 'Outcomes are mutually exclusive: at most one resolves YES'];
  if (strike.outcome === 'hold') {
    if (rulesN !== 0) return base('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_DISAGREE_WITH_STRIKE');
  } else {
    if (dir.toLowerCase() !== strike.outcome.split('_')[0] || rulesN !== 25) return base('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_DISAGREE_WITH_STRIKE');
    if (strike.gt && !gtMark) {
      if (!/\s{2,}25bps/.test(rules)) return base('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_MISSING_GREATER_THAN');
      exceptions.push('Venue rules text lost the ">" sign ("of   25bps"); outcome taken from the structured custom_strike and title, which agree');
    }
  }
  const secondary = String(market.rules_secondary || '');
  if (!/mutually exclusive/i.test(secondary) || !/canceled/i.test(secondary)) return base('HOLD_RESOLUTION_AMBIGUOUS', 'FED_SECONDARY_RULES_CHANGED');
  if (!MONTHS[monthName]) return base('HOLD_RESOLUTION_AMBIGUOUS', 'RULES_DATE_UNPARSEABLE');
  const date = `${year}-${pad(MONTHS[monthName])}-${pad(day)}`;
  const meeting = meetingFor(date);
  if (!meeting) return base('HOLD_RESOLUTION_AMBIGUOUS', 'MEETING_NOT_IN_OFFICIAL_CALENDAR', { date });
  const announce = event?.strike_date || market.expected_expiration_time;
  const start = new Date(Date.parse(announce)).toISOString();
  return {
    normalization_status: 'NORMALIZED',
    status_reason: null,
    event_type: 'FOMC_DECISION_BUCKET',
    subject: `Change in the federal funds target range announced at the FOMC meeting ending ${date}`,
    comparator: 'bucket',
    threshold_low: bucket.low,
    threshold_high: bucket.high,
    units: 'bps',
    location: null,
    station_id: null,
    station_source: null,
    observation_start: start,
    observation_end: new Date(Date.parse(start) + 2 * 3600000).toISOString(),
    timezone: 'America/New_York',
    resolution_authority: 'Federal Reserve Board (FOMC policy statement)',
    resolution_dataset: `FOMC statement and implementation note, ${date} (federalreserve.gov)`,
    verification_dataset: 'FRED DFEDTARU / DFEDTARL federal funds target range (H.15)',
    measurement_definition: 'Change in the federal funds target range decided at this scheduled meeting',
    rounding_rule: 'Basis points; >25 means 50 bps or more',
    exceptions,
    yes_condition: `${bucket.yes} on ${date}`,
    no_condition: 'any other decision',
    detail: { outcome: strike.outcome, meeting_date: date, calendar_source: meeting.calendarSource },
  };
}
