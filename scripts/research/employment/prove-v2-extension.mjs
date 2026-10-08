#!/usr/bin/env node
// Manual proof of the Employment V2 ledger extension. For named BLS releases and DOL releases, print the raw text from the
// archived document (a different extraction path from the parsers: tag-stripped text / plain pdftotext, no table walking)
// beside the ledger values, so a reviewer can read both. Exit 1 on any mismatch.
//   node scripts/research/employment/prove-v2-extension.mjs <raw-release-dir> <raw-dol-dir> --bls f1,f2,... --dol k1,k2,...
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [relDir, dolDir, ...rest] = process.argv.slice(2);
const arg = (k) => (rest[rest.indexOf(k) + 1] || '').split(',').filter(Boolean);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const levels = JSON.parse(readFileSync('data/employment/bls-empsit-levels-v1.json', 'utf8')).releases;
const iur = JSON.parse(readFileSync('data/employment/dol-iur-releases-v1.json', 'utf8')).records;
const out = { bls: [], dol: [] };

for (const f of arg('--bls')) {
  const html = readFileSync(join(relDir, f), 'utf8');
  const rec = levels.find((r) => r.file_name === f);
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/[ \t]+/g, ' ');
  // the first "Civilian labor force" / "Unemployed" lines that carry numbers, verbatim
  const line = (re) => flat.split('\n').map((l) => l.trim()).find((l) => re.test(l)) || null;
  // HTML era: the raw <tr> of the first matching row after the "Summary table A" caption, tags stripped to one line
  const htmlRow = (label) => {
    const at = html.search(/Summary table A\./i); if (at < 0) return null;
    const tr = html.slice(at).match(new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?>\\s*${label}\\s*<(?:(?!</tr>)[\\s\\S])*</tr>`, 'i'));
    return tr ? `${label} ${tr[0].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()}` : null;
  };
  const isHtml = /<table/i.test(html) && /Summary table A\./i.test(html);
  const clfLine = isHtml ? htmlRow('Civilian labor force') : line(/^Civilian labor force[ .]*[\d,]{6,}/);
  const unLine = isHtml ? htmlRow('Unemployed') : line(/^Unemployed[ .]*[\d,]{4,}/);
  const ref = rec?.reference_levels;
  const nums = (l) => (l ? (l.match(/\d{1,3}(?:,\d{3})+/g) || []).map((x) => Number(x.replace(/,/g, ''))) : []);
  out.bls.push({
    file: f, sha256: sha(html), reference_month: rec?.reference_month, clf_line: clfLine, unemployed_line: unLine,
    ledger: ref, u3_unrounded: ref ? +ref.u3_unrounded.toFixed(4) : null,
    // the ledger value must appear verbatim among the numbers printed on the document's own row
    match: !!ref && rec.source_document_sha256 === sha(html) && nums(clfLine).includes(ref.civilian_labor_force_k) && nums(unLine).includes(ref.unemployed_k),
  });
}
for (const key of arg('--dol')) {
  const path = join(dolDir, 'files', key.replace('/', '-'));
  const buf = readFileSync(path);
  const text = (key.endsWith('.pdf') ? execFileSync('pdftotext', ['-q', path, '-'], { encoding: 'utf8' }) : buf.toString('latin1')).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
  const s = (text.match(/advance seasonally adjusted insured unemployment rate[^.]*?\d+\.\d percent[^.]{0,60}/i) || [null])[0];
  const rec = iur.find((r) => r.file_name === key);
  out.dol.push({ key, sha256: sha(buf), sentence: s, ledger: rec && { week_ending: rec.week_ending, iur_sa_pct: rec.iur_sa_pct, release_at: rec.release_at }, match: !!rec && !!s && Number(s.match(/(\d+\.\d) percent/)[1]) === rec.iur_sa_pct && rec.source_document_sha256 === sha(buf) });
}
console.log(JSON.stringify(out, null, 1));
if ([...out.bls, ...out.dol].some((x) => !x.match)) process.exitCode = 1;
