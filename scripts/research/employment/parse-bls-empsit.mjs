#!/usr/bin/env node
// Parse archived BLS Employment Situation releases (www.bls.gov/news.release/archives/empsit_MMDDYYYY.htm) into
//   <out-dir>/bls-empsit-releases-v1.json   one record per release, every month it prints, guards, sha256
//   <out-dir>/bls-empsit-first-prints-v1.json  first print per reference month (U-3, total nonfarm change), with source
// Nothing comes from FRED/ALFRED. A release that fails any guard is listed under failures and contributes nothing.
//   node scripts/research/employment/parse-bls-empsit.mjs <raw-release-dir> <out-dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPSIT_PARSER_VERSION, parseEmpsitRelease } from '../../../src/macro/employment/bls-empsit.js';
import { firstPrints, LEDGER_VERSION, releaseAtUtc, u3ReprintConsistency } from '../../../src/macro/employment/ledger.js';

const [dir, outDir] = process.argv.slice(2);
if (!dir || !outDir) { console.error('usage: parse-bls-empsit.mjs <raw-release-dir> <out-dir>'); process.exit(2); }
const sha = (s) => createHash('sha256').update(s).digest('hex');
const files = readdirSync(dir).filter((f) => /^empsit_\d{8}\.htm$/.test(f)).sort();
const releases = []; const failures = []; const empty = [];
for (const f of files) {
  if (statSync(join(dir, f)).size === 0) { empty.push(f); continue; }
  const html = readFileSync(join(dir, f), 'utf8');
  const r = parseEmpsitRelease(html, { fileName: f, sha256: sha(html), sourceUrl: `https://www.bls.gov/news.release/archives/${f}` });
  if (r.ok) releases.push({ ...r, release_at: releaseAtUtc(r) }); else failures.push(r);
}
releases.sort((a, b) => a.release_at.localeCompare(b.release_at));
const dupRef = Object.entries(releases.reduce((a, r) => ((a[r.reference_month] = (a[r.reference_month] || 0) + 1), a), {})).filter(([, n]) => n > 1);
const ledger = firstPrints(releases);
const consistency = u3ReprintConsistency(releases);
mkdirSync(outDir, { recursive: true });
const relDoc = { parser_version: EMPSIT_PARSER_VERSION, source: 'BLS Employment Situation news release archive', files: files.length, parsed: releases.length, empty_files: empty, failures, duplicate_reference_months: dupRef, releases };
const relJson = JSON.stringify(relDoc, null, 1);
writeFileSync(join(outDir, 'bls-empsit-releases-v1.json'), relJson);
const fpDoc = { ledger_version: LEDGER_VERSION, parser_version: EMPSIT_PARSER_VERSION, releases_sha256: sha(relJson), definition: 'first print = earliest release (by embargo time) printing a non-null value for the month', u3_reprint_consistency: consistency, months: ledger };
const fpJson = JSON.stringify(fpDoc, null, 1);
writeFileSync(join(outDir, 'bls-empsit-first-prints-v1.json'), fpJson);
const unavailable = ledger.filter((m) => m.u3.status !== 'OK' || m.payroll_change_k.status !== 'OK');
const abnormal = ledger.filter((m) => (m.u3.status === 'OK' && !m.u3.in_own_release) || (m.payroll_change_k.status === 'OK' && !m.payroll_change_k.in_own_release) || m.own_release?.reissued);
console.log(JSON.stringify({ files: files.length, parsed: releases.length, failures: failures.map((f) => `${f.fileName}:${f.reason}`), empty, duplicate_reference_months: dupRef,
  months: ledger.length, first: ledger[0]?.reference_month, last: ledger.at(-1)?.reference_month, consistency,
  unavailable: unavailable.map((m) => ({ m: m.reference_month, u3: m.u3.status === 'OK' ? m.u3.value : `${m.u3.status}:${m.u3.reason}`, pay: m.payroll_change_k.status === 'OK' ? m.payroll_change_k.value : `${m.payroll_change_k.status}:${m.payroll_change_k.reason}` })),
  abnormal: abnormal.map((m) => ({ m: m.reference_month, own_release: m.own_release?.release_date ?? null, reissued: m.own_release?.reissued ?? null, u3_from: m.u3.release_date ?? null, pay_from: m.payroll_change_k.release_date ?? null })),
  releases_sha256: sha(relJson), first_prints_sha256: sha(fpJson) }, null, 1));
