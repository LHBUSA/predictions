#!/usr/bin/env node
// Freeze the CPI V1 candidate (RIDGE_T_EWMA) into a versioned artifact.
// Fits each target on every usable T-1D observation in the dataset, records
// the exact data, code and evidence identities, and the per-target SHADOW gate.
// It never deploys anything.
//
// Usage: node scripts/research/cpi/freeze-artifact.mjs [dataset.json] [evidence.json] [out.json]

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { FEATURE_VERSION, FEATURES, TARGETS } from '../../../src/macro/cpi/features.js';
import { HYPER, MODEL_VERSION, ridgeStudentEwma } from '../../../src/macro/cpi/models.js';
import { ADAPTER_VERSION } from '../../../src/macro/cpi/contracts.js';
import { usableRows } from './validate.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

export function freeze(dataset, evidence, { datasetSha, evidenceSha, codeSha, codeDirty }) {
  const targets = {};
  for (const target of Object.keys(TARGETS)) {
    const rows = usableRows(dataset.observations, target, 'T-1D');
    const predictor = ridgeStudentEwma(rows, target, evidence.targetFeatureSets[target]);
    const { fit, scale, sigma, nu, names } = predictor.state;
    const gate = evidence.targets[target].gate;
    targets[target] = {
      kalshiSeries: TARGETS[target].kalshiSeries,
      shadowEligible: gate.verdict === 'PASS',
      gate,
      features: names,
      anchor: TARGETS[target].anchor,
      ridge: { intercept: fit.intercept, beta: fit.beta, featureMean: fit.featureMean, featureSd: fit.featureSd },
      sigma,
      scale,
      nu,
      trainingWindow: { first: rows[0].referenceMonth, last: rows[rows.length - 1].referenceMonth, n: rows.length, lastReleaseAt: rows[rows.length - 1].releaseAt }
    };
  }
  return {
    artifactVersion: 'cpi-v1-artifact/1',
    modelId: 'pbe-cpi-distribution',
    modelVersion: MODEL_VERSION,
    family: 'RIDGE_T_EWMA',
    status: 'FROZEN_CANDIDATE_NOT_DEPLOYED',
    featureVersion: FEATURE_VERSION,
    contractAdapterVersion: ADAPTER_VERSION,
    hyper: HYPER,
    horizon: 'T-1D (20:00 ET the day before the BLS release)',
    dataset: { version: dataset.datasetVersion, sha256: datasetSha, builtFrom: dataset.builtFrom },
    evidence: { path: 'docs/research/cpi-v1-evidence.json', sha256: evidenceSha, validationVersion: evidence.validationVersion },
    code: { gitSha: codeSha, dirtyAtFreeze: codeDirty },
    sourceManifest: {
      bls: 'BLS CPI news release archive, Table A (Table 1 for the 2016-05 PDF-only archive entry); as-published values',
      eia: 'EIA weekly retail gasoline EMM_EPM0_PTE_NUS_DPG; available from week date + 1 day 17:00 ET; no public vintage archive',
      features: Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, v.kind]))
    },
    marketInputs: 'NONE',
    targets
  };
}

function main() {
  const [dsPath = 'data/cpi/cpi-v1-dataset.json', evPath = 'docs/research/cpi-v1-evidence.json', out = 'src/macro/artifacts/cpi-v1.json'] = process.argv.slice(2);
  const dsBuf = readFileSync(dsPath);
  const evBuf = readFileSync(evPath);
  const evidence = JSON.parse(evBuf);
  if (evidence.dataset.sha256 !== sha(dsBuf)) throw new Error('evidence was produced from a different dataset; rerun validate.mjs');
  const codeSha = execSync('git -c safe.directory=* rev-parse HEAD').toString().trim();
  const codeDirty = execSync('git -c safe.directory=* status --porcelain -- src/macro/cpi scripts/research/cpi').toString().trim().length > 0;
  const artifact = freeze(JSON.parse(dsBuf), evidence, { datasetSha: sha(dsBuf), evidenceSha: sha(evBuf), codeSha, codeDirty });
  const text = `${JSON.stringify(artifact, null, 1)}\n`;
  writeFileSync(out, text);
  console.log(`artifact ${out} sha256 ${sha(text)} code ${codeSha}${codeDirty ? ' (DIRTY)' : ''}`);
  for (const [t, s] of Object.entries(artifact.targets)) console.log(`  ${t}: gate ${s.gate.verdict}, n=${s.trainingWindow.n} ${s.trainingWindow.first}..${s.trainingWindow.last}, sigma ${s.sigma.toFixed(3)}`);
}

if (process.argv[1]?.endsWith('freeze-artifact.mjs')) main();
