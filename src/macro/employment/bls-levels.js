// Employment V2 ledger extension (approved 2026-10-08, research only): first-print SA household LEVELS from the BLS
// Employment Situation (thousands): civilian labor force and unemployed, every month the release prints. Pure.
// Guard: for the reference month, round(100 * unemployed / civilian labor force, 1) must equal the U-3 the same release
// prints, or the release is refused (LEVELS_DISAGREE_WITH_RATE). A release we cannot read exactly is not data.
import { decode, htmlTable, numOrNull, releaseMeta, rowByMonth, tableByCaption, textHeaderKeys } from './bls-empsit.js';

export const BLS_LEVELS_PARSER_VERSION = 'bls-levels-parser/1';

function htmlLevels(html) {
  const a = tableByCaption(html, /Summary table A\.\s*Household data, seasonally adjusted/i);
  if (!a) return { error: 'NO_SUMMARY_TABLE_A' };
  const t = htmlTable(a);
  const clf = rowByMonth(t, /^Civilian labor force$/i); const un = rowByMonth(t, /^Unemployed$/i); const u3 = rowByMonth(t, /^Unemployment rate$/i);
  if (!clf || !un || !u3) return { error: 'NO_LEVEL_ROWS' };
  return { format: 'html-summary-tables', clf, un, u3 };
}

function textLevels(html) {
  const lines = decode(html.replace(/\r/g, '').replace(/\n/g, '@@NL@@')).split('@@NL@@');
  const ia = lines.findIndex((l) => /Table A-1\.\s+Employment status of the civilian population/i.test(l));
  if (ia < 0) return { error: 'NO_TEXT_TABLE_A1' };
  const banner = lines.findIndex((l, k) => k > ia && /Not seasonally adjusted/i.test(l));
  const keys = textHeaderKeys(lines, banner);
  if (!keys) return { error: 'UNPARSEABLE_TEXT_HEADER' };
  const vals = (l) => (l.split(/\.{2,}/).pop() || '').trim().split(/\s+/).filter(Boolean).map(numOrNull);
  // the first block of Table A-1 is TOTAL; take the first matching row after the banner
  const body = lines.slice(banner);
  const row = (re) => body.find((l) => re.test(l));
  const rc = row(/^\s*Civilian labor force\.{3,}/); const ru = row(/^\s*Unemployed\.{3,}/); const rr = row(/^\s*Unemployment rate\.{3,}/);
  if (!rc || !ru || !rr) return { error: 'NO_TEXT_LEVEL_ROWS' };
  const out = { format: 'text-tables', clf: {}, un: {}, u3: {} };
  for (const [name, l] of [['clf', rc], ['un', ru], ['u3', rr]]) {
    const v = vals(l);
    if (v.length !== keys.length) return { error: 'TEXT_A1_COLUMN_COUNT', row: name, got: v.length, want: keys.length };
    keys.forEach((k, i) => { out[name][k] = v[i]; }); // SA block is right-hand: the last column for a month wins
  }
  return out;
}

export function parseEmpsitLevels(html, { fileName = null, sha256 = null, sourceUrl = null } = {}) {
  const meta = releaseMeta(html);
  if (meta.error) return { ok: false, reason: meta.error, fileName };
  const body = /Summary table A\./i.test(html) && /<table/i.test(html) ? htmlLevels(html) : textLevels(html);
  if (body.error) return { ok: false, reason: body.error, fileName, ...meta, detail: body };
  const ref = meta.reference_month;
  const c = body.clf[ref]; const u = body.un[ref]; const r = body.u3[ref];
  if (c === null && u === null && r === null) return { ok: true, ...meta, format: body.format, reference_levels: null, levels_by_month: { civilian_labor_force_k: body.clf, unemployed_k: body.un }, rate_check: 'REFERENCE_MONTH_NOT_AVAILABLE', source_url: sourceUrl, source_document_sha256: sha256, file_name: fileName, parser_version: BLS_LEVELS_PARSER_VERSION };
  if (![c, u, r].every(Number.isFinite)) return { ok: false, reason: 'REFERENCE_LEVELS_MISSING', fileName, ...meta, clf: c, un: u, u3: r };
  const implied = Math.round((1000 * u) / c) / 10; // 100 * u / c rounded to one decimal, done on integers
  if (implied !== r) return { ok: false, reason: 'LEVELS_DISAGREE_WITH_RATE', fileName, ...meta, clf: c, un: u, u3: r, implied, unrounded: (100 * u) / c };
  return {
    ok: true, ...meta, format: body.format,
    reference_levels: { civilian_labor_force_k: c, unemployed_k: u, u3_published: r, u3_unrounded: (100 * u) / c },
    levels_by_month: { civilian_labor_force_k: body.clf, unemployed_k: body.un },
    rate_check: 'MATCH',
    source_url: sourceUrl, source_document_sha256: sha256, file_name: fileName, parser_version: BLS_LEVELS_PARSER_VERSION,
  };
}
