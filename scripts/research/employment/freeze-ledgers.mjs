#!/usr/bin/env node
// Employment V1: record the frozen as-published ledgers BEFORE any model is fit (owner order: target ledger frozen, input
// ledger frozen, availability tests pass, baselines frozen, then fit). validate.mjs refuses to run on any ledger whose
// sha256 differs from this file. Also hashes every raw archived document, so the ledgers can be rebuilt and checked.
//   node scripts/research/employment/freeze-ledgers.mjs <raw-release-dir> <raw-dol-dir>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPSIT_PARSER_VERSION } from '../../../src/macro/employment/bls-empsit.js';
import { DOL_PARSER_VERSION } from '../../../src/macro/employment/dol-claims.js';
import { LEDGER_VERSION } from '../../../src/macro/employment/ledger.js';
import { FEATURE_VERSION, CUTOFF_RULE } from '../../../src/macro/employment/features.js';

const [relDir, dolDir] = process.argv.slice(2);
if (!relDir || !dolDir) { console.error('usage: freeze-ledgers.mjs <raw-release-dir> <raw-dol-dir>'); process.exit(2); }
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ledgers = ['data/employment/bls-empsit-releases-v1.json', 'data/employment/bls-empsit-first-prints-v1.json', 'data/employment/dol-claims-releases-v1.json'];
const rawSet = (dir) => { const files = readdirSync(dir).sort(); const lines = files.map((f) => `${f} ${sha(readFileSync(join(dir, f)))}`); return { files: files.length, sha256_of_listing: sha(lines.join('\n')) }; };
const doc = {
  frozen_at: new Date().toISOString(),
  purpose: 'Employment V1 as-published ledgers, frozen before any model fit (protocol + Amendment A1)',
  versions: { bls_parser: EMPSIT_PARSER_VERSION, dol_parser: DOL_PARSER_VERSION, ledger: LEDGER_VERSION, features: FEATURE_VERSION, cutoff_rule: CUTOFF_RULE },
  files: Object.fromEntries(ledgers.map((p) => [p, { sha256: sha(readFileSync(p)) }])),
  raw: {
    bls_releases: { source: 'https://www.bls.gov/news.release/archives/empsit_MMDDYYYY.htm', ...rawSet(relDir) },
    dol_claims: { source: 'https://oui.doleta.gov/press/<year>/', manifest_sha256: sha(readFileSync(join(dolDir, 'manifest.json'))), ...rawSet(join(dolDir, 'files')) },
  },
};
writeFileSync('data/employment/LEDGER_FREEZE.json', JSON.stringify(doc, null, 1) + '\n');
console.log(JSON.stringify(doc, null, 1));
