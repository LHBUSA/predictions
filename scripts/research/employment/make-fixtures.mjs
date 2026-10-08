#!/usr/bin/env node
// Build small test fixtures from real archived releases (trimmed, content otherwise verbatim):
//   HTML format: everything up to the end of the lead narrative + the two Summary tables
//   text format: header + lead narrative + Table A-1 top block + Table B-1 top rows
//   node scripts/research/employment/make-fixtures.mjs <raw-release-dir> <raw-dol-dir> <out-dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [rel, dol, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const html = (f) => readFileSync(join(rel, f), 'utf8');

function trimHtml(f) {
  const s = html(f);
  const lower = s.toLowerCase(); // older pages use <PRE>
  const pre = lower.indexOf('<pre'); const body = s.slice(pre, lower.indexOf('</pre>', pre) + 6);
  const lead = body.split('\n').slice(0, 60).join('\n') + '\n</pre>';
  const tables = [...s.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]).filter((t) => /Summary table [AB]\.\s*(Household|Establishment) data, seasonally adjusted/i.test(t));
  return `<!-- trimmed fixture from https://www.bls.gov/news.release/archives/${f} -->\n<div class="normalnews">${lead}</div>\n${tables.join('\n')}\n`;
}
function trimText(f) {
  const lines = html(f).split('\n');
  const keep = new Set();
  const from = (re, n) => { const i = lines.findIndex((l) => re.test(l.replace(/<[^>]+>/g, ''))); if (i >= 0) for (let k = i; k < i + n; k++) keep.add(k); };
  from(/embargoed/i, 40);
  from(/Table A-1\.\s+Employment status/i, 24);
  from(/Table B-1\.\s+Employees on nonfarm payrolls/i, 14);
  return `<!-- trimmed fixture from https://www.bls.gov/news.release/archives/${f} -->\n<pre>\n${[...keep].sort((a, b) => a - b).map((k) => lines[k]).join('\n')}\n</pre>\n`;
}
writeFileSync(join(out, 'empsit_01092026.trim.htm'), trimHtml('empsit_01092026.htm'));
writeFileSync(join(out, 'empsit_05082020.trim.htm'), trimHtml('empsit_05082020.htm'));
writeFileSync(join(out, 'empsit_12162025.trim.htm'), trimHtml('empsit_12162025.htm'));
writeFileSync(join(out, 'empsit_02012008.trim.htm'), trimText('empsit_02012008.htm'));
writeFileSync(join(out, 'empsit_09042009.trim.htm'), trimText('empsit_09042009.htm'));
// DOL: one PDF-era (text via pdftotext) and one .asp-era release, first ~60 lines
const pdfText = execFileSync('pdftotext', ['-layout', '-q', join(dol, 'files', '2026-100126.pdf'), '-'], { encoding: 'utf8' }).split('\n').slice(0, 40).join('\n');
writeFileSync(join(out, 'dol_100126.txt'), `# trimmed pdftotext -layout of https://oui.doleta.gov/press/2026/100126.pdf\n${pdfText}\n`);
writeFileSync(join(out, 'dol_010809.asp'), readFileSync(join(dol, 'files', '2009-010809.asp'), 'latin1'));
console.log('fixtures written to', out);
