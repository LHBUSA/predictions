#!/usr/bin/env node
// Parse archived BLS CPI news releases (www.bls.gov/news.release/archives/cpi_MMDDYYYY.htm)
// into the as-published CPI release ledger used by CPI V1.
//
// Every value comes from the release document itself, so each record is the
// vintage that existed at that release's embargo time. Nothing is backfilled
// from later releases.
//
// Usage: node scripts/research/cpi/parse-bls-releases.mjs <raw-release-dir> <out.json> [pdf-text-dir]

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addMonths, etToUtcIso, monthIndex, ym } from '../../../src/macro/cpi/timeline.js';

export const PARSER_VERSION = 'bls-cpi-table-a/1';

// Table A rows CPI V1 keeps. Keys are normalized labels.
const ROWS = Object.freeze({
  'all items': 'headline',
  'food': 'food',
  'energy': 'energy',
  'all items less food and energy': 'core',
  'gasoline (all types)': 'gasoline',
  'shelter': 'shelter'
});

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#160;': ' ', '&ndash;': '-', '&mdash;': '-', '&#8211;': '-', '&minus;': '-' };

function decode(s) {
  return s.replace(/&[#a-z0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ');
}

function htmlToText(html) {
  return decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/t[dh]>/gi, ' \t ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ''));
}

const NUM = /^-?(\d+)?\.\d+$|^-?\d+$|^-$/;

function normLabel(s) {
  return s.toLowerCase()
    .replace(/\(\d+\)/g, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/[\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ .]+$/, '')
    .trim();
}

function toValue(tok) {
  if (tok === '-') return null;
  const n = Number(tok);
  if (!Number.isFinite(n)) throw new Error(`bad numeric token ${tok}`);
  return n;
}

// Split a table line into label + trailing numeric tokens.
function splitLine(line) {
  const toks = line.replace(/\t/g, ' ').trim().split(/\s+/).filter(Boolean);
  const nums = [];
  while (toks.length && NUM.test(toks[toks.length - 1])) nums.unshift(toks.pop());
  // a label made of dots only ("....") collapses to empty
  return { label: toks.join(' '), nums };
}

function tableARegion(html) {
  const htmlMatch = /class="tableTitle">\s*Table A\.[\s\S]*?<\/table>/i.exec(html);
  if (htmlMatch) return { format: 'html-table', text: htmlToText(htmlMatch[0].replace(/\r?\n/g, ' ')) };
  const text = htmlToText(html);
  const i = text.search(/Table A\.\s+Percent changes/i);
  if (i < 0) return null;
  // The text table ends at the first blank-line-separated prose paragraph or note.
  const rest = text.slice(i);
  const end = rest.search(/\n\s*(Note:|Footnote|\(1\)\s+Not seasonally|Table 1\.)/i);
  return { format: 'pre-text', text: rest.slice(0, end > 0 ? end : 6000) };
}

function parseTableA(region) {
  // Only the column header may declare a compound-annual-rate column; the
  // same words appear in prose after the table and must not shift columns.
  const headerEnd = region.text.search(/^\s*All items\b/im);
  if (headerEnd < 0) throw new Error('Table A: All items row not found');
  const hasCompound = /compound/i.test(region.text.slice(0, headerEnd));
  const rows = {};
  let pending = '';
  let width = null;
  for (const raw of region.text.split('\n')) {
    const { label, nums } = splitLine(raw);
    if (!nums.length) {
      // pre-text label continuation ("All items less food and" / "energy....")
      const l = normLabel(label);
      if (region.format === 'pre-text' && l && !/^(table a|seasonally|expenditure|category|changes|preceding|un-|adjusted|12-mos|ended|compound|annual|rate|3-mos|special indexes)/.test(l) && !/\b(19|20)\d{2}\b/.test(l)) {
        pending = pending ? `${pending} ${l}` : l;
      } else {
        pending = '';
      }
      continue;
    }
    let l = normLabel(label);
    if (region.format === 'pre-text' && pending) l = normLabel(`${pending} ${l}`);
    pending = '';
    // header lines ("2017 2017 ...") are all numeric with an empty label
    if (!l) continue;
    if (width === null && l === 'all items') width = nums.length;
    const key = ROWS[l];
    if (!key || rows[key]) continue;
    rows[key] = nums.map(toValue);
  }
  if (!rows.headline) throw new Error('Table A: All items row not found');
  if (!rows.core) throw new Error('Table A: core row not found');
  const trailing = hasCompound ? 2 : 1;
  const saCount = width - trailing;
  if (saCount < 3 || saCount > 13) throw new Error(`Table A: implausible SA column count ${saCount}`);
  for (const [k, v] of Object.entries(rows)) {
    if (v.length !== width) throw new Error(`Table A: row ${k} has ${v.length} values, expected ${width}`);
  }
  return { rows, saCount, hasCompound };
}

function parseEmbargo(text, fileDate) {
  const flat = text.replace(/\s+/g, ' ');
  const re = /embargoed until:? (\d{1,2}):(\d{2}) ?([ap])\.? ?m\.? ?\(?(?:E[DS]?T)\)?,? (?:[A-Za-z]+day,? )?([A-Za-z]+)\.? (\d{1,2}),? (\d{4})/i;
  const m = re.exec(flat);
  if (!m) return { releaseAt: etToUtcIso(fileDate, 8, 30), releaseTimeSource: 'bls_standard_0830_et_filename_date' };
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') hour += 12;
  const date = `${m[6]}-${String(monthIndex(m[4])).padStart(2, "0")}-${String(Number(m[5])).padStart(2, '0')}`;
  if (date !== fileDate) throw new Error(`embargo date ${date} != archive filename date ${fileDate}`);
  return { releaseAt: etToUtcIso(date, hour, Number(m[2])), releaseTimeSource: 'release_embargo_line' };
}

function checkNarrative(text, series, referenceMonth) {
  const stated = narrativeHeadline(text);
  const parsed = series.headline.saMoM[referenceMonth];
  if (stated === 'NSA') return 'unavailable_text_states_unadjusted_change';
  if (stated === null || parsed === null) return 'unavailable';
  if (Math.abs(stated - parsed) > 1e-9) {
    throw new Error(`Table A headline ${parsed} != release text ${stated} for ${referenceMonth} (column misalignment)`);
  }
  return 'match';
}

// Independent check: the release's first paragraph states the headline SA
// change ("increased 0.7 percent in February", "was unchanged in May").
const WORD_NUM = { unchanged: 0 };
export function narrativeHeadline(text) {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.search(/Consumer Price Index for All Urban Consumers \(CPI-U\)/i);
  if (i < 0) return null;
  // the first sentence only; 2008-2009 releases lead with the UNADJUSTED change
  const s = flat.slice(Math.max(0, i - 60), i + 300).split(/\. (?=[A-Z])/).find((x) => x.includes('(CPI-U)')) ?? '';
  if (/(before|prior to) seasonal adjustment/i.test(s)) return 'NSA';
  const m = /\(CPI-U\) (increased|rose|declined|decreased|fell|was unchanged)(?: by)? ?(\d+\.\d)? ?(?:percent)?/i.exec(s);
  if (!m) return null;
  if (/unchanged/i.test(m[1])) return WORD_NUM.unchanged;
  if (!m[2]) return null;
  const v = Number(m[2]);
  return /declined|decreased|fell/i.test(m[1]) ? -v : v;
}

function parseReferenceMonth(text) {
  const flat = text.replace(/\s+/g, ' ');
  const m = /CONSUMER PRICE INDEX ?[^A-Za-z0-9 ]{1,3} ?([A-Za-z]+) (\d{4})/i.exec(flat);
  if (!m) throw new Error('reference month header not found');
  return ym(Number(m[2]), monthIndex(m[1]));
}

export function parseRelease(html, fileName) {
  const fm = /cpi_(\d{2})(\d{2})(\d{4})\.htm$/.exec(fileName);
  if (!fm) throw new Error(`unexpected file name ${fileName}`);
  const fileDate = `${fm[3]}-${fm[1]}-${fm[2]}`;
  const text = htmlToText(html);
  const referenceMonth = parseReferenceMonth(text);
  const { releaseAt, releaseTimeSource } = parseEmbargo(text, fileDate);
  const region = tableARegion(html);
  if (!region) throw new Error('Table A not found');
  const { rows, saCount, hasCompound } = parseTableA(region);

  // SA columns are consecutive months ending at the reference month.
  const saMonths = Array.from({ length: saCount }, (_, i) => addMonths(referenceMonth, i - (saCount - 1)));
  const series = {};
  for (const [key, values] of Object.entries(rows)) {
    const sa = {};
    saMonths.forEach((month, i) => { sa[month] = values[i]; });
    series[key] = { saMoM: sa, nsa12m: values[values.length - 1] };
  }
  const narrativeHeadlineCheck = checkNarrative(text, series, referenceMonth);
  return {
    id: `bls-cpi:${referenceMonth}`,
    referenceMonth,
    releaseDate: fileDate,
    releaseAt,
    releaseTimeSource,
    sourceUrl: `https://www.bls.gov/news.release/archives/${fileName}`,
    sourceSha256: createHash('sha256').update(html).digest('hex'),
    tableFormat: region.format,
    compoundColumn: hasCompound,
    narrativeHeadlineCheck,
    saMonths,
    series
  };
}

// Fallback for archive entries whose HTML is empty (BLS serves a 0-byte
// cpi_06162016.htm). Input is `pdftotext -layout` output of the archived PDF.
// That PDF prints Table 1 (3 SA months + unadjusted 12-month change), not
// Table A, so the record carries only those 3 SA months.
export function parseReleasePdfText(text, fileName, pdfSha256) {
  const fm = /cpi_(\d{2})(\d{2})(\d{4})\.(?:pdf|txt)$/.exec(fileName);
  if (!fm) throw new Error(`unexpected file name ${fileName}`);
  const fileDate = `${fm[3]}-${fm[1]}-${fm[2]}`;
  const referenceMonth = parseReferenceMonth(text);
  const { releaseAt, releaseTimeSource } = parseEmbargo(text, fileDate);
  const start = text.search(/\[1982-84=100, unless otherwise noted\]/);
  if (start < 0) throw new Error('Table 1 not found in PDF text');
  const series = {};
  const saMonths = [addMonths(referenceMonth, -2), addMonths(referenceMonth, -1), referenceMonth];
  for (const raw of text.slice(start).split('\n')) {
    const { label, nums } = splitLine(raw);
    const key = ROWS[normLabel(label.replace(/(\s?\.)+\s*$/, '').replace(/(\s?\.){2,}/g, ' '))];
    if (!key || series[key] || nums.length !== 9) continue;
    const v = nums.map(toValue);
    // [relative importance, 3 unadjusted indexes, NSA 12m, NSA 1m, SA m-2, SA m-1, SA m]
    series[key] = { saMoM: { [saMonths[0]]: v[6], [saMonths[1]]: v[7], [saMonths[2]]: v[8] }, nsa12m: v[4] };
  }
  if (!series.headline || !series.core) throw new Error('PDF Table 1: headline/core rows not found');
  return {
    id: `bls-cpi:${referenceMonth}`,
    referenceMonth,
    releaseDate: fileDate,
    releaseAt,
    releaseTimeSource,
    sourceUrl: `https://www.bls.gov/news.release/archives/${fileName.replace(/\.txt$/, '.pdf')}`,
    sourceSha256: pdfSha256,
    tableFormat: 'pdf-table-1',
    compoundColumn: false,
    narrativeHeadlineCheck: checkNarrative(text, series, referenceMonth),
    saMonths,
    series
  };
}

// Column-alignment guard: release M+1 re-prints month M. Outside the release of
// January data (when BLS revises five years of seasonal factors) the two must
// agree exactly; a one-column shift breaks this immediately.
export function vintageConsistency(releases) {
  const out = [];
  for (let i = 0; i < releases.length - 1; i += 1) {
    const a = releases[i];
    const b = releases[i + 1];
    if (b.referenceMonth.endsWith('-01')) continue;
    for (const k of ['headline', 'core', 'food', 'energy']) {
      const va = a.series[k]?.saMoM?.[a.referenceMonth];
      const vb = b.series[k]?.saMoM?.[a.referenceMonth];
      if (va == null || vb == null) continue;
      if (va !== vb) out.push({ file: b.sourceUrl, error: `${k} ${a.referenceMonth}: ${va} in its own release, ${vb} in the next (not a seasonal-revision release)` });
    }
  }
  return out;
}

function main() {
  const [dir, out, pdfDir] = process.argv.slice(2);
  if (!dir || !out) {
    console.error('usage: parse-bls-releases.mjs <raw-release-dir> <out.json> [pdf-text-dir]');
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => /^cpi_\d{8}\.htm$/.test(f));
  const releases = [];
  const failures = [];
  for (const f of files) {
    try {
      const html = readFileSync(join(dir, f), 'utf8');
      if (html.length === 0 && pdfDir) {
        const base = f.replace(/\.htm$/, '');
        const pdf = readFileSync(join(pdfDir, `${base}.pdf`));
        const txt = readFileSync(join(pdfDir, `${base}.txt`), 'utf8');
        releases.push(parseReleasePdfText(txt, `${base}.txt`, createHash('sha256').update(pdf).digest('hex')));
        continue;
      }
      releases.push(parseRelease(html, f));
    } catch (error) {
      failures.push({ file: f, error: error.message });
    }
  }
  releases.sort((a, b) => a.releaseAt.localeCompare(b.releaseAt));
  failures.push(...vintageConsistency(releases));
  const dup = releases.filter((r, i) => releases.findIndex((x) => x.referenceMonth === r.referenceMonth) !== i);
  if (dup.length) failures.push(...dup.map((r) => ({ file: r.sourceUrl, error: `duplicate reference month ${r.referenceMonth}` })));
  const payload = {
    parserVersion: PARSER_VERSION,
    source: 'U.S. Bureau of Labor Statistics, CPI news release archive (public domain)',
    archiveIndex: 'https://www.bls.gov/bls/news-release/cpi.htm',
    releaseCount: releases.length,
    failures,
    releases
  };
  writeFileSync(out, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`parsed ${releases.length} releases, ${failures.length} failures`);
  for (const f of failures) console.log('  FAIL', f.file, f.error);
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('parse-bls-releases.mjs')) main();
