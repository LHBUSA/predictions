#!/usr/bin/env node
// Manual proof of the DOL claims ledger (Employment V1 Stage 2). For each named archived release, print the raw sentences
// from the document itself (plain pdftotext, no -layout, or tag-stripped HTML: a different extraction path from the
// parser) beside the ledger record, so a reviewer can read the published wording and the stored values side by side.
//   node scripts/research/employment/prove-dol-weeks.mjs <raw-dol-dir> <ledger.json> <key> [<key> ...]
//   key = <listing year>/<file>, e.g. 2020/032620.pdf
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ledgerPath, ...keys] = process.argv.slice(2);
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const byFile = new Map(ledger.records.map((r) => [r.file_name, r]));
const flat = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
const out = [];
for (const key of keys) {
  const path = join(dir, 'files', key.replace('/', '-'));
  const buf = readFileSync(path);
  const text = flat(key.endsWith('.pdf') ? execFileSync('pdftotext', ['-q', path, '-'], { encoding: 'utf8' }) : buf.toString('latin1'));
  const grab = (re) => { const m = text.match(re); return m ? m[0].slice(0, 260) : null; };
  const rec = byFile.get(key) ?? null;
  const embargo = grab(/EMBARGOED[\s\S]{0,160}?\d{4}/i);
  const icSentence = grab(/In the week ending\s*[A-Za-z]+\.?\s*\d{1,2},?\s*the advance figure for seasonally adjusted initial claims (?:was|were)\s*[\d,]*\d/i);
  const ccSentence = grab(/advance number for seasonally adjusted insured unemployment during (?:the )?week ending\s*[A-Za-z]+\.?\s*\d{1,2},?\s*(?:was|were)\s*[\d,]*\d/i);
  // numbers read back out of the raw sentences, compared with the stored record
  const lastNum = (s) => (s ? Number(s.match(/([\d,]{5,})\s*$/)?.[1]?.replace(/,/g, '')) : null);
  out.push({
    key, sha256: createHash('sha256').update(buf).digest('hex'), embargo, icSentence, ccSentence,
    ledger: rec && { release_at: rec.release_at, initial_week_ending: rec.initial_week_ending, initial_claims_sa: rec.initial_claims_sa, continuing_week_ending: rec.continuing_week_ending, continuing_claims_sa: rec.continuing_claims_sa, sha256: rec.source_document_sha256 },
    match: !!rec && lastNum(icSentence) === rec.initial_claims_sa && lastNum(ccSentence) === rec.continuing_claims_sa && rec.source_document_sha256 === createHash('sha256').update(buf).digest('hex'),
  });
}
console.log(JSON.stringify(out, null, 1));
if (out.some((o) => !o.match)) process.exitCode = 1;
