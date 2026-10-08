#!/usr/bin/env node
// Exploratory post-gate check only. Not a fitted model, forecast or model-promotion gate.
// From repository root: node scripts/research/employment/rounding-signal-run.mjs [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutoffFor } from '../../../src/macro/employment/features.js';
import { report } from './rounding-signal-core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const source='data/employment/bls-empsit-levels-v1.json';
const raw=readFileSync(join(root,source));
const h=createHash('sha256').update(raw).digest('hex');
const freezePath=join(root,'data/employment/LEDGER_FREEZE_V2_EXTENSION.json');
const freeze=JSON.parse(readFileSync(freezePath,'utf8'));
if(h!==freeze.files?.[source]?.sha256)throw Error('Extended BLS ledger has changed');
const input=JSON.parse(raw.toString('utf8'));
if(!Array.isArray(input.releases)||input.releases.length!==input.parsed||input.failures?.length)throw Error('Frozen level ledger incomplete');
const evidence={status:'EXPLORATORY_POSTGATE_NOT_A_MODEL',version:'rounding-gap-descriptive/1',input_sha256:h,freeze_sha256:createHash('sha256').update(readFileSync(freezePath)).digest('hex'),...report(input.releases,cutoffFor)};
const result=JSON.stringify(evidence,null,2)+'\n';
if(process.argv[2])writeFileSync(resolve(process.argv[2]),result);else process.stdout.write(result);
