// BLS "The Employment Situation" news release -> as-published values. Pure (html in, record out).
// Two archive formats:
//   HTML tables (Feb 2010 ->): Summary table A (household, SA) and Summary table B (establishment, SA, over-the-month
//                              change), each column labelled with its month.
//   plain text  (-> Jan 2010): Table A-1 (TOTAL block, last column for the month = SA) and Table B-1 (Total nonfarm,
//                              "Change from" column, checked against the SA level difference).
// Every month a release prints is recorded with the release that printed it, so the first print of month X is simply the
// earliest release that carries a value for X. A value printed as "-" (not collected) is null, never 0.
// Guards (fail = { ok:false, reason }): embargo date + weekday agree; the headline month is the newest month in both
// tables; the narrative's unemployment rate and payroll change equal the table values for the reference month.
export const EMPSIT_PARSER_VERSION = 'bls-empsit-parser/1';

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const mkey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const monOf = (s) => { const k = String(s).toLowerCase().replace(/\./g, ''); return MON[k.startsWith('sept') ? 'sept' : k.slice(0, 3)]; };
export const shiftMonth = (key, n) => { const [y, m] = key.split('-').map(Number); const t = y * 12 + (m - 1) + n; return mkey(Math.floor(t / 12), (t % 12) + 1); };
const decode = (s) => String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
const numOrNull = (s) => { const t = String(s).replace(/[,\s]/g, '').replace(/\(p\)|p$/i, ''); if (t === '-' || t === '' || t === '–') return null; const v = Number(t.replace(/^\./, '0.').replace(/^-\./, '-0.')); return Number.isFinite(v) ? v : NaN; };

// The release's own headline. A title quoted inside a correction note ("... USDL 08-0757, "THE EMPLOYMENT SITUATION:
// MAY 2008."") is not the headline, so matches preceded by a quote mark are skipped.
const HEADLINE_RE = /THE EMPLOYMENT SITUATION\s*[:\-–—]*\s*(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d{4})/gi;
function headline(text) {
  for (const m of text.matchAll(HEADLINE_RE)) if (!/["“']\s*$/.test(text.slice(Math.max(0, m.index - 3), m.index))) return m;
  return null;
}

export function releaseMeta(html) {
  const text = decode(html);
  const at = text.search(/embargoed\b/i); // a USDL number can sit between "embargoed" and "until"
  if (at < 0) return { error: 'NO_EMBARGO_LINE' };
  const win = text.slice(at, at + 260);
  const t = win.match(/(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i);
  const wd = win.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  const dm = win.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i);
  if (!t || !wd || !dm) return { error: 'UNPARSEABLE_EMBARGO' };
  const date = `${dm[3]}-${String(FULL.indexOf(dm[1].toLowerCase()) + 1).padStart(2, '0')}-${dm[2].padStart(2, '0')}`;
  const weekday = wd[1][0].toUpperCase() + wd[1].slice(1).toLowerCase();
  if (WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] !== weekday) return { error: 'EMBARGO_WEEKDAY_MISMATCH', date, weekday };
  let hh = Number(t[1]) % 12; if (t[3].toLowerCase() === 'p') hh += 12;
  const head = headline(text);
  if (!head) return { error: 'NO_HEADLINE_MONTH' };
  return { release_date: date, release_time_et: `${String(hh).padStart(2, '0')}:${t[2]}`, weekday, reference_month: mkey(Number(head[2]), FULL.indexOf(head[1].toLowerCase()) + 1) };
}

// ------------------------------------------------------------------ HTML format
function tableByCaption(html, re) {
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/gi)) { const cap = m[0].match(/<caption[\s\S]*?<\/caption>/i); if (cap && re.test(decode(cap[0]))) return m[0]; }
  return null;
}
function htmlTable(table) {
  const head = (table.match(/<thead[\s\S]*?<\/thead>/i) || [''])[0];
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((c) => decode(c[1])).slice(1).map((label) => {
    if (/change/i.test(label)) return null;
    const mm = label.match(/^([A-Za-z]+)\.?\s+(\d{4})/);
    return mm && monOf(mm[1]) ? mkey(Number(mm[2]), monOf(mm[1])) : null;
  });
  const rows = [];
  for (const r of (table.match(/<tbody[\s\S]*?<\/tbody>/i) || [''])[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const th = r[1].match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => decode(c[1]));
    if (th) rows.push({ label: decode(th[1]), values: tds });
  }
  return { cols, rows };
}
function rowByMonth({ cols, rows }, labelRe) {
  const row = rows.find((r) => labelRe.test(r.label));
  if (!row) return null;
  const out = {};
  cols.forEach((k, i) => { if (k) out[k] = numOrNull(row.values[i]); });
  return out;
}
function parseHtmlFormat(html) {
  const a = tableByCaption(html, /Summary table A\.\s*Household data, seasonally adjusted/i);
  const b = tableByCaption(html, /Summary table B\.\s*Establishment data, seasonally adjusted/i);
  if (!a || !b) return { error: 'NO_SUMMARY_TABLES' };
  const u3 = rowByMonth(htmlTable(a), /^Unemployment rate$/i);
  const pay = rowByMonth(htmlTable(b), /^Total nonfarm$/i);
  if (!u3 || !pay) return { error: 'NO_SUMMARY_ROWS' };
  return { format: 'html-summary-tables', u3, payroll_change_k: pay };
}

// ------------------------------------------------------------------ plain-text format
function textHeaderKeys(lines, i) {
  // the first two non-empty lines after a "Not seasonally adjusted" banner hold month tokens and year tokens
  const mon = []; const yrs = [];
  for (let j = i + 1; j < Math.min(lines.length, i + 12) && !yrs.length; j++) {
    const toks = lines[j].trim().split(/\s+/).filter(Boolean);
    const months = toks.filter((x) => monOf(x));
    const years = toks.map((x) => x.match(/^(\d{4})p?-?$/)).filter(Boolean).map((x) => Number(x[1]));
    if (!mon.length && months.length >= 6) mon.push(...months.map(monOf));
    else if (mon.length && years.length >= mon.length) yrs.push(...years.slice(0, mon.length));
  }
  return mon.length && yrs.length === mon.length ? mon.map((m, k) => mkey(yrs[k], m)) : null;
}
function parseTextFormat(html) {
  const lines = decode(html.replace(/\r/g, '').replace(/\n/g, '@@NL@@')).split('@@NL@@');
  const ia = lines.findIndex((l) => /Table A-1\.\s+Employment status of the civilian population/i.test(l));
  const ib = lines.findIndex((l) => /Table B-1\.\s+Employees on nonfarm payrolls/i.test(l));
  if (ia < 0 || ib < 0) return { error: 'NO_TEXT_TABLES' };
  const banner = (from) => lines.findIndex((l, k) => k > from && /Not seasonally adjusted/i.test(l));
  const keysA = textHeaderKeys(lines, banner(ia)); const keysB = textHeaderKeys(lines, banner(ib));
  if (!keysA || !keysB) return { error: 'UNPARSEABLE_TEXT_HEADER' };
  const vals = (l) => (l.split(/\.{2,}/).pop() || '').trim().split(/\s+/).filter(Boolean).map(numOrNull);
  const urow = lines.slice(ia).find((l) => /^\s*Unemployment rate\.{3,}/.test(l));
  const prow = lines.slice(ib).find((l) => /^\s*Total nonfarm\.{3,}/.test(l));
  if (!urow || !prow) return { error: 'NO_TEXT_ROWS' };
  const uv = vals(urow); const pv = vals(prow);
  if (uv.length !== keysA.length) return { error: 'TEXT_A1_COLUMN_COUNT', got: uv.length, want: keysA.length };
  if (pv.length !== keysB.length + 1) return { error: 'TEXT_B1_COLUMN_COUNT', got: pv.length, want: keysB.length + 1 };
  // SA columns are the right-hand block: for each month keep the LAST column that carries it
  const u3 = {}; keysA.forEach((k, i) => { u3[k] = uv[i]; });
  const levels = {}; keysB.forEach((k, i) => { levels[k] = pv[i]; });
  const ref = keysB.at(-1); const prev = keysB.at(-2);
  const change = pv.at(-1);
  if (levels[ref] - levels[prev] !== change) return { error: 'TEXT_B1_CHANGE_DISAGREES_WITH_LEVELS', change, diff: levels[ref] - levels[prev] };
  return { format: 'text-tables', u3, payroll_change_k: { [ref]: change }, payroll_level_k: levels };
}

// ------------------------------------------------------------------ narrative cross-check (opening paragraphs only)
export function narrative(html) {
  const text = decode(html);
  const at = headline(text)?.index ?? -1;
  // skip a leading "(NOTE: BLS reissued this news release ...)" block so the lead paragraph is read, not the note
  let lead = text.slice(at, at + 3000);
  const note = lead.match(/^THE EMPLOYMENT SITUATION\s*[:\-–—]*\s*[A-Z]+\s+\d{4}\s*\(NOTE:[\s\S]*?\)\s*(?=[A-Z])/i);
  if (note) lead = lead.slice(note[0].length);
  lead = lead.slice(0, 1400);
  // the level the rate moved TO ("from 7.0 percent to 6.7 percent", "by 0.3 percentage point to 5.1 percent"), else the
  // first plain "X.X percent" in the unemployment-rate clause (never "X.X percentage point")
  const clause = (lead.match(/unemployment rate(?:[^.]|\.(?=\d)){0,220}/i) || [''])[0]; // a decimal point is not a sentence end
  const uTo = clause.match(/\bto (\d{1,2}\.\d) percent(?!age)/i);
  const u = uTo || clause.match(/(\d{1,2}\.\d) percent(?!age)/i);
  // payroll: the first signed or verb-signed number after "payroll employment" (thousands, or "X.X million")
  const p0 = lead.search(/(?:nonfarm )?payroll employment/i);
  let pay = null; let payRounding = 0;
  if (p0 >= 0) {
    const seg = lead.slice(p0, p0 + 420);
    // parenthesised change: "(+50,000)", "(-17,000)" or "(-20.5 million)"; a bare "(13.7 million)" is a level, not a change
    const paren = seg.match(/\(([+\-−–])\s*([\d,]+(?:\.\d+)?)(\s*million)?\)|\(([\d]{1,3}(?:,\d{3})+)\)/i);
    const verb = seg.match(/\b(rose|increased|grew|added|edged up|edged down|declined|decreased|fell|lost|dropped|was down|was up)\b[^0-9]{0,30}?by\s+([\d,]+(?:\.\d+)?)(\s*million)?/i);
    const amount = (n, unit) => { if (unit) { payRounding = 50; return Number(n.replace(/,/g, '')) * 1000; } return Number(n.replace(/,/g, '')) / 1000; };
    // whichever statement comes first is the total ("grew by 431,000 ... Private-sector ... (+41,000)")
    const useVerb = verb && (!paren || verb.index < paren.index);
    if (useVerb) pay = (/declin|decreas|fell|lost|dropped|down/i.test(verb[1]) ? -1 : 1) * amount(verb[2], verb[3]);
    else if (paren && paren[4]) pay = amount(paren[4]);
    else if (paren) pay = (/[-−–]/.test(paren[1]) ? -1 : 1) * amount(paren[2], paren[3]);
  }
  return { u3: u ? Number(u[1]) : null, payroll_change_k: pay, payroll_rounding_k: payRounding };
}

export function parseEmpsitRelease(html, { fileName = null, sha256 = null, sourceUrl = null } = {}) {
  const meta = releaseMeta(html);
  if (meta.error) return { ok: false, reason: meta.error, fileName };
  const body = /Summary table A\./i.test(html) && /<table/i.test(html) ? parseHtmlFormat(html) : parseTextFormat(html);
  if (body.error) return { ok: false, reason: body.error, fileName, ...meta, detail: body };
  const ref = meta.reference_month;
  const newest = (o) => Object.keys(o).sort().at(-1);
  if (newest(body.u3) !== ref || newest(body.payroll_change_k) !== ref) return { ok: false, reason: 'HEADLINE_MONTH_NOT_NEWEST_TABLE_MONTH', fileName, ...meta, u3_newest: newest(body.u3), pay_newest: newest(body.payroll_change_k) };
  const nar = narrative(html);
  const checks = {
    u3_narrative: nar.u3 === null ? 'UNPARSED' : (body.u3[ref] === null ? (nar.u3 === null ? 'MATCH' : 'TABLE_NULL') : (nar.u3 === body.u3[ref] ? 'MATCH' : 'MISMATCH')),
    payroll_narrative: nar.payroll_change_k === null ? 'UNPARSED'
      : nar.payroll_change_k === body.payroll_change_k[ref] ? 'MATCH'
        : nar.payroll_rounding_k && Math.abs(nar.payroll_change_k - body.payroll_change_k[ref]) <= nar.payroll_rounding_k ? 'MATCH_ROUNDED_MILLIONS' : 'MISMATCH',
  };
  if (checks.u3_narrative === 'MISMATCH' || checks.payroll_narrative === 'MISMATCH') return { ok: false, reason: 'NARRATIVE_DISAGREES_WITH_TABLE', fileName, ...meta, narrative: nar, table: { u3: body.u3[ref], pay: body.payroll_change_k[ref] } };
  return {
    ok: true, ...meta, format: body.format,
    // the archive keeps the LAST issued version; a reissue note means the file is not byte-for-byte what was first published
    reissued: (decode(html).match(/BLS reissued this news release on ([A-Z][a-z]+ \d{1,2}, \d{4})/) || [])[1] ?? null,
    u3_by_month: body.u3, payroll_change_k_by_month: body.payroll_change_k,
    headline: { u3: body.u3[ref] ?? null, payroll_change_k: body.payroll_change_k[ref] ?? null },
    narrative: nar, checks,
    source_url: sourceUrl, source_document_sha256: sha256, file_name: fileName, parser_version: EMPSIT_PARSER_VERSION,
  };
}
