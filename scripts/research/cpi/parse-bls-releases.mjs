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

export { PARSER_VERSION, narrativeHeadline, parseRelease, parseReleasePdfText, vintageConsistency } from '../../../src/macro/cpi/bls-release.js';
import { parseRelease, parseReleasePdfText, vintageConsistency, PARSER_VERSION } from '../../../src/macro/cpi/bls-release.js';

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
      releases.push(parseRelease(html, f, { sha256: createHash('sha256').update(html).digest('hex') }));
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
