// Employment V2 ledger extension (approved 2026-10-08, research only): the ADVANCE seasonally adjusted insured
// unemployment rate (IUR) exactly as printed in a DOL weekly claims release. Pure (text in, value out).
// The release identity and time come from the frozen V1 claims record for the same document; the IUR must be for that
// record's continuing-claims week, or the document is refused.
import { normalizeReleaseText } from './dol-claims.js';

export const DOL_IUR_PARSER_VERSION = 'dol-iur-parser/1';
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// PDF text can carry kerning spaces inside words; fixed phrases are matched letter by letter with optional spaces
const loose = (phrase) => phrase.split(' ').map((w) => w.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ?')).join('\\s+');
const IUR_RE = new RegExp(`${loose('advance seasonally adjusted insured unemployment rate')} (?:${loose('was')}|${loose('remained')}|${loose('is')}) (\\d{1,2}\\.\\d) ${loose('percent')} ${loose('for the week ending')} ([A-Za-z]+)\\.? ?(\\d{1,2})`, 'i');

export function parseInsuredRate(raw, record) {
  const text = normalizeReleaseText(raw);
  const m = text.match(IUR_RE);
  if (!m) return { ok: false, reason: 'NO_IUR_SENTENCE', file_name: record.file_name };
  const mi = MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (mi === undefined) return { ok: false, reason: 'UNPARSEABLE_IUR_WEEK', file_name: record.file_name, week_text: `${m[2]} ${m[3]}` };
  const cw = record.continuing_week_ending; // YYYY-MM-DD, the week the IUR must describe
  if (Number(cw.slice(5, 7)) - 1 !== mi || Number(cw.slice(8, 10)) !== Number(m[3])) return { ok: false, reason: 'IUR_WEEK_NOT_CONTINUING_WEEK', file_name: record.file_name, week_text: `${m[2]} ${m[3]}`, continuing_week_ending: cw };
  return { ok: true, week_ending: cw, iur_sa_pct: Number(m[1]), sentence: m[0] };
}
