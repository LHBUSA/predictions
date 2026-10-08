// DOL/ETA "Unemployment Insurance Weekly Claims" news release -> one as-published record. Pure (text in, record out).
// Values are the ADVANCE seasonally adjusted figures exactly as printed in that week's release; later revisions live in
// later releases and are never written back into this record.
//   initial_claims_sa      advance SA initial claims for week W (week ending Saturday)
//   continuing_claims_sa   advance SA insured unemployment for week W-1
// Any failed guard returns { ok: false, reason } instead of a record: a release we cannot read exactly is not data.
export const DOL_PARSER_VERSION = 'dol-claims-parser/1';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const monthIdx = (s) => MONTHS[String(s).toLowerCase().replace(/\.$/, '').slice(0, String(s).toLowerCase().startsWith('sept') ? 4 : 3)];
const num = (s) => Number(String(s).replace(/,/g, ''));
const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;

// Text normalization shared by the PDF (pdftotext -layout) and .asp (HTML) inputs.
export function normalizeReleaseText(raw) {
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

// "8:30 A.M. (Eastern) Thursday, October 1, 2026" (also "8:30 A.M. (Eastern) Thursday, Jan. 8, 2009" and variants).
function embargo(text) {
  const at = text.search(/EMBARGOED\s+UNTIL/i);
  if (at < 0) return null;
  // older releases are two-column: contact names sit between the embargo words, the time, the weekday and the date
  const win = text.slice(at, at + 320);
  const t = win.match(/(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?/i);
  const wd = win.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  const dm = win.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (!t || !wd || !dm) return null;
  const mi = monthIdx(dm[1]);
  if (mi === undefined) return null;
  const date = iso(Number(dm[3]), mi, Number(dm[2]));
  const weekday = wd[1][0].toUpperCase() + wd[1].slice(1).toLowerCase();
  // the weekday printed must be the weekday of the printed date
  if (['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(date).getUTCDay()] !== weekday) return null;
  let hh = Number(t[1]) % 12; if (t[3].toUpperCase() === 'P') hh += 12;
  return { date, weekday, time_et: `${String(hh).padStart(2, '0')}:${t[2]}` };
}

// Resolve a "Month D" week-ending date to the year that puts it on or before the release date (Dec/Jan wrap).
function weekEnding(monthText, day, releaseDate) {
  const mi = monthIdx(monthText);
  if (mi === undefined) return null;
  const y = Number(releaseDate.slice(0, 4));
  for (const yy of [y, y - 1]) { const d = iso(yy, mi, Number(day)); if (d <= releaseDate) return d; }
  return null;
}

export function parseClaimsRelease(raw, { sourceUrl = null, sha256 = null, fileName = null } = {}) {
  const text = normalizeReleaseText(raw);
  const emb = embargo(text);
  if (!emb) return { ok: false, reason: 'NO_EMBARGO_LINE', fileName };
  const ic = text.match(/week ending ([A-Za-z]+\.?) (\d{1,2}),? the advance figure for seasonally adjusted initial claims (?:was|were) ([\d,]+)/i);
  if (!ic) return { ok: false, reason: 'NO_INITIAL_CLAIMS_SENTENCE', fileName, release_date: emb.date };
  const cc = text.match(/advance number for seasonally adjusted insured unemployment during (?:the )?week ending ([A-Za-z]+\.?) (\d{1,2}),? (?:was|were) ([\d,]+)/i);
  if (!cc) return { ok: false, reason: 'NO_CONTINUING_CLAIMS_SENTENCE', fileName, release_date: emb.date };
  const icWeek = weekEnding(ic[1], ic[2], emb.date);
  const ccWeek = weekEnding(cc[1], cc[2], emb.date);
  if (!icWeek || !ccWeek) return { ok: false, reason: 'UNPARSEABLE_WEEK', fileName, release_date: emb.date };
  // guards: Saturday weeks, the continuing week is one week before the initial week, release 4-7 days after the week
  if (new Date(icWeek).getUTCDay() !== 6 || new Date(ccWeek).getUTCDay() !== 6) return { ok: false, reason: 'WEEK_NOT_SATURDAY', fileName, release_date: emb.date, icWeek, ccWeek };
  if (days(icWeek, ccWeek) !== 7) return { ok: false, reason: 'CONTINUING_WEEK_NOT_PRIOR_WEEK', fileName, release_date: emb.date, icWeek, ccWeek };
  const lag = days(emb.date, icWeek);
  if (lag < 3 || lag > 7) return { ok: false, reason: 'RELEASE_LAG_OUT_OF_RANGE', fileName, release_date: emb.date, icWeek, lag };
  return {
    ok: true,
    release_date: emb.date, release_time_et: emb.time_et, release_weekday: emb.weekday,
    initial_week_ending: icWeek, initial_claims_sa: num(ic[3]),
    continuing_week_ending: ccWeek, continuing_claims_sa: num(cc[3]),
    source_url: sourceUrl, source_document_sha256: sha256, file_name: fileName, parser_version: DOL_PARSER_VERSION,
  };
}
