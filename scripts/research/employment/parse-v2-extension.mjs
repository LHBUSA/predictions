#!/usr/bin/env node
// Employment V2 ledger extension (owner-approved 2026-10-08; research only, no fitting):
//   <out-dir>/bls-empsit-levels-v1.json   first-print SA civilian labor force + unemployed, every month each release prints
//   <out-dir>/dol-iur-releases-v1.json    advance SA insured unemployment rate per DOL release (joined to the frozen V1
//                                         claims ledger by document; release time from that record)
//   node scripts/research/employment/parse-v2-extension.mjs <raw-release-dir> <raw-dol-dir> <out-dir>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLS_LEVELS_PARSER_VERSION, parseEmpsitLevels } from '../../../src/macro/employment/bls-levels.js';
import { DOL_IUR_PARSER_VERSION, parseInsuredRate } from '../../../src/macro/employment/dol-iur.js';
import { releaseAtUtc } from '../../../src/macro/employment/ledger.js';

const [relDir, dolDir, outDir] = process.argv.slice(2);
if (!relDir || !dolDir || !outDir) { console.error('usage: parse-v2-extension.mjs <raw-release-dir> <raw-dol-dir> <out-dir>'); process.exit(2); }
const sha = (b) => createHash('sha256').update(b).digest('hex');
mkdirSync(outDir, { recursive: true });

// ---- BLS levels
const files = readdirSync(relDir).filter((f) => /^empsit_\d{8}\.htm$/.test(f) && statSync(join(relDir, f)).size > 0).sort();
const levels = []; const levelFailures = [];
for (const f of files) {
  const html = readFileSync(join(relDir, f), 'utf8');
  const r = parseEmpsitLevels(html, { fileName: f, sha256: sha(html), sourceUrl: `https://www.bls.gov/news.release/archives/${f}` });
  if (r.ok) levels.push({ ...r, release_at: releaseAtUtc(r) }); else levelFailures.push(r);
}
levels.sort((a, b) => a.release_at.localeCompare(b.release_at));
const levelsDoc = { parser_version: BLS_LEVELS_PARSER_VERSION, source: 'BLS Employment Situation news release archive (Summary table A / Table A-1, SA)', files: files.length, parsed: levels.length, failures: levelFailures, releases: levels };
const levelsJson = JSON.stringify(levelsDoc, null, 1);
writeFileSync(join(outDir, 'bls-empsit-levels-v1.json'), levelsJson);

// ---- DOL IUR, joined to the frozen V1 claims ledger
const claims = JSON.parse(readFileSync('data/employment/dol-claims-releases-v1.json', 'utf8'));
const manifest = JSON.parse(readFileSync(join(dolDir, 'manifest.json'), 'utf8'));
const iur = []; const iurFailures = [];
for (const rec of claims.records) {
  const key = rec.file_name; const path = join(dolDir, 'files', key.replace('/', '-'));
  const buf = readFileSync(path);
  if (sha(buf) !== rec.source_document_sha256 || manifest.files[key]?.sha256 !== rec.source_document_sha256) { iurFailures.push({ file_name: key, reason: 'DOCUMENT_HASH_DIFFERS_FROM_FROZEN_LEDGER' }); continue; }
  const text = key.endsWith('.pdf') ? execFileSync('pdftotext', ['-layout', '-q', path, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }) : buf.toString('latin1');
  const r = parseInsuredRate(text, rec);
  if (!r.ok) { iurFailures.push(r); continue; }
  iur.push({ release_date: rec.release_date, release_at: rec.release_at, week_ending: r.week_ending, iur_sa_pct: r.iur_sa_pct, source_url: rec.source_url, source_document_sha256: rec.source_document_sha256, file_name: key, parser_version: DOL_IUR_PARSER_VERSION });
}
const iurDoc = { parser_version: DOL_IUR_PARSER_VERSION, joined_to: { path: 'data/employment/dol-claims-releases-v1.json', parser_version: claims.parser_version }, records_in: claims.records.length, parsed: iur.length, failures: iurFailures, records: iur };
const iurJson = JSON.stringify(iurDoc, null, 1);
writeFileSync(join(outDir, 'dol-iur-releases-v1.json'), iurJson);

const refused = levels.filter((r) => r.rate_check !== 'MATCH');
console.log(JSON.stringify({
  bls_levels: { files: files.length, parsed: levels.length, failures: levelFailures.map((f) => `${f.fileName}:${f.reason}${f.implied !== undefined ? ` implied ${f.implied} vs ${f.u3} (unrounded ${f.unrounded.toFixed(4)})` : ''}`), reference_not_available: refused.map((r) => r.reference_month), sha256: sha(levelsJson) },
  dol_iur: { records_in: claims.records.length, parsed: iur.length, failures: iurFailures.map((f) => `${f.file_name}:${f.reason}${f.week_text ? ` (${f.week_text})` : ''}`), first: iur[0]?.week_ending, last: iur.at(-1)?.week_ending, sha256: sha(iurJson) },
}, null, 1));
