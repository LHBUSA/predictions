#!/usr/bin/env node
// Freeze the Employment V2 ledger extension (owner-approved 2026-10-08; research only, no fitting). Separate from the V1
// LEDGER_FREEZE.json, which is not modified. Records ledger hashes, parser versions, the V1 ledger the IUR joins to, and
// the manual-proof file hash.
//   node scripts/research/employment/freeze-v2-extension.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { BLS_LEVELS_PARSER_VERSION } from '../../../src/macro/employment/bls-levels.js';
import { DOL_IUR_PARSER_VERSION } from '../../../src/macro/employment/dol-iur.js';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const doc = {
  frozen_at: new Date().toISOString(),
  purpose: 'Employment V2 point-in-time ledger extension (EMPLOYMENT_V2_PROTOCOL.md section 3), frozen before any V2 fit; V2 status HOLD',
  versions: { bls_levels_parser: BLS_LEVELS_PARSER_VERSION, dol_iur_parser: DOL_IUR_PARSER_VERSION },
  files: Object.fromEntries(['data/employment/bls-empsit-levels-v1.json', 'data/employment/dol-iur-releases-v1.json', 'docs/research/employment-v2-extension-manual-proof.json'].map((p) => [p, { sha256: sha(p) }])),
  depends_on: { 'data/employment/LEDGER_FREEZE.json': { sha256: sha('data/employment/LEDGER_FREEZE.json') } },
};
writeFileSync('data/employment/LEDGER_FREEZE_V2_EXTENSION.json', JSON.stringify(doc, null, 1) + '\n');
console.log(JSON.stringify(doc, null, 1));
