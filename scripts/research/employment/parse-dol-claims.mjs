#!/usr/bin/env node
// Parse the archived DOL/ETA weekly claims releases fetched by fetch-dol-claims.mjs into the as-published claims ledger
//   <out-dir>/dol-claims-releases-v1.json
// One record per release: release date/time (from the embargo line, never the filename), advance SA initial claims for
// week W, advance SA insured unemployment (continuing claims) for week W-1, source URL, document sha256, parser version.
// PDFs are converted with `pdftotext -layout` (poppler/xpdf); .asp pages are parsed as HTML.
//   node scripts/research/employment/parse-dol-claims.mjs <raw-dol-dir> <out-dir>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOL_PARSER_VERSION, parseClaimsRelease } from '../../../src/macro/employment/dol-claims.js';
import { etToUtcIso } from '../../../src/macro/cpi/timeline.js';

const [dir, outDir] = process.argv.slice(2);
if (!dir || !outDir) { console.error('usage: parse-dol-claims.mjs <raw-dol-dir> <out-dir>'); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const records = []; const failures = [];
for (const [key, f] of Object.entries(manifest.files).sort()) {
  if (f.status !== 200) { failures.push({ key, reason: `HTTP_${f.status}` }); continue; }
  const path = join(dir, 'files', key.replace('/', '-'));
  const buf = readFileSync(path);
  if (sha(buf) !== f.sha256) { failures.push({ key, reason: 'SHA256_DIFFERS_FROM_MANIFEST' }); continue; }
  const text = key.endsWith('.pdf') ? execFileSync('pdftotext', ['-layout', '-q', path, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }) : buf.toString('latin1');
  const r = parseClaimsRelease(text, { sourceUrl: f.url, sha256: f.sha256, fileName: key });
  if (!r.ok) { failures.push({ key, ...r }); continue; }
  records.push({ ...r, release_at: etToUtcIso(r.release_date, Number(r.release_time_et.slice(0, 2)), Number(r.release_time_et.slice(3, 5))), fetched_at: f.fetched_at });
}
records.sort((a, b) => a.release_at.localeCompare(b.release_at));
// the same release can appear twice (a file misfiled under the next year's listing): keep one, require identical values
const byDate = new Map(); const duplicates = [];
for (const r of records) {
  const k = r.release_date;
  if (!byDate.has(k)) { byDate.set(k, r); continue; }
  const a = byDate.get(k);
  duplicates.push({ release_date: k, files: [a.file_name, r.file_name], identical: a.initial_claims_sa === r.initial_claims_sa && a.continuing_claims_sa === r.continuing_claims_sa && a.initial_week_ending === r.initial_week_ending });
}
const releases = [...byDate.values()];
// weeks with no release (shutdown, archive gaps) are listed, never filled
const missing = [];
for (let i = 1; i < releases.length; i++) {
  const gap = (Date.parse(releases[i].initial_week_ending) - Date.parse(releases[i - 1].initial_week_ending)) / 86400000;
  if (gap !== 7) missing.push({ after_week: releases[i - 1].initial_week_ending, next_week: releases[i].initial_week_ending, weeks_missing: gap / 7 - 1 });
}
mkdirSync(outDir, { recursive: true });
const doc = { parser_version: DOL_PARSER_VERSION, source: manifest.source, files: Object.keys(manifest.files).length, parsed: records.length, releases: releases.length, duplicates, failures, missing_weeks: missing, records: releases };
const json = JSON.stringify(doc, null, 1);
writeFileSync(join(outDir, 'dol-claims-releases-v1.json'), json);
console.log(JSON.stringify({ files: doc.files, parsed: doc.parsed, releases: doc.releases, first: releases[0]?.initial_week_ending, last: releases.at(-1)?.initial_week_ending,
  duplicates: duplicates.length, duplicates_not_identical: duplicates.filter((d) => !d.identical), failures: failures.map((f) => `${f.key}:${f.reason}`), missing_weeks: missing, sha256: sha(json) }, null, 1));
