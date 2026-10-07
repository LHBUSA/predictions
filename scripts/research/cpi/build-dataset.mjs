#!/usr/bin/env node
// Build the CPI V1 research dataset from the parsed BLS release ledger and EIA
// weekly gasoline prices. One observation per (reference month, horizon).
//
// Horizons (forecast cutoffs, US Eastern):
//   T-1D       20:00 ET on the calendar day before the CPI release
//   MONTH_END  23:59 ET on the last day of the reference month
//
// Usage: node scripts/research/cpi/build-dataset.mjs [releases.json] [gasoline.json] [out.json]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildFeatures, FEATURES, TARGETS, targetValue } from '../../../src/macro/cpi/features.js';
import { addDaysYmd, etToUtcIso, lastDayOfMonth } from '../../../src/macro/cpi/timeline.js';

export const DATASET_VERSION = 'cpi-v1-dataset/1';

export const HORIZONS = Object.freeze({
  'T-1D': (release) => etToUtcIso(addDaysYmd(release.releaseDate, -1), 20, 0),
  MONTH_END: (release) => etToUtcIso(lastDayOfMonth(release.referenceMonth), 23, 59)
});

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function compactProvenance(prov) {
  const out = {};
  for (const [name, p] of Object.entries(prov)) {
    const bls = p.inputs.filter((i) => i.source === 'bls_cpi_release_table_a');
    const eia = p.inputs.filter((i) => i.source === 'eia_weekly_retail_gasoline' && i.week);
    out[name] = {
      ...(bls.length ? { bls: bls.map((i) => `${i.series}:${i.field ?? 'saMoM'}:${i.month}@${i.vintage}|${i.publishedAt}`) } : {}),
      ...(eia.length ? { eiaWeeks: [eia[0].week, eia[eia.length - 1].week], eiaWeekCount: eia.length, eiaLastAvailableAt: eia.map((i) => i.publishedAt).sort().pop() } : {}),
      ...(p.partialMonth ? { partialMonth: true } : {})
    };
  }
  return out;
}

export function buildDataset({ releases, gasWeeks }) {
  const observations = [];
  const exclusions = [];
  for (const release of releases) {
    const targets = {};
    for (const t of Object.keys(TARGETS)) targets[t] = targetValue(release, t);
    for (const [horizon, cutoffFn] of Object.entries(HORIZONS)) {
      const cutoffAt = cutoffFn(release);
      if (Date.parse(cutoffAt) >= Date.parse(release.releaseAt)) {
        exclusions.push({ referenceMonth: release.referenceMonth, horizon, reason: 'cutoff_not_before_release' });
        continue;
      }
      const f = buildFeatures({ releases, gasWeeks, referenceMonth: release.referenceMonth, cutoffAt });
      const missingTargets = Object.entries(targets).filter(([, v]) => v === null).map(([k]) => k);
      observations.push({
        referenceMonth: release.referenceMonth,
        horizon,
        releaseDate: release.releaseDate,
        releaseAt: release.releaseAt,
        cutoffAt: f.cutoffAt,
        vintage: f.vintage,
        vintagePublishedAt: f.vintagePublishedAt,
        features: f.values,
        missingFeatures: f.missing,
        provenance: compactProvenance(f.provenance),
        targets,
        missingTargets,
        targetSource: { release: release.id, url: release.sourceUrl, publishedAt: release.releaseAt }
      });
    }
  }
  return { observations, exclusions };
}

function main() {
  const [relPath = 'data/cpi/bls-cpi-releases-v1.json', gasPath = 'data/cpi/eia-gasoline-weekly-v1.json', out = 'data/cpi/cpi-v1-dataset.json'] = process.argv.slice(2);
  const relBuf = readFileSync(relPath);
  const gasBuf = readFileSync(gasPath);
  const rel = JSON.parse(relBuf);
  const gas = JSON.parse(gasBuf);
  if (rel.failures?.length) throw new Error(`release ledger has ${rel.failures.length} parse failures; fix before building`);
  const { observations, exclusions } = buildDataset({ releases: rel.releases, gasWeeks: gas.weeks });
  const payload = {
    datasetVersion: DATASET_VERSION,
    builtFrom: {
      releases: { path: relPath, sha256: sha(relBuf), parserVersion: rel.parserVersion, releaseCount: rel.releaseCount },
      gasoline: { path: gasPath, sha256: sha(gasBuf), series: gas.series, first: gas.first, last: gas.last }
    },
    featureNames: Object.keys(FEATURES),
    horizons: Object.keys(HORIZONS),
    observationCount: observations.length,
    exclusions,
    observations
  };
  const text = `${JSON.stringify(payload)}\n`;
  writeFileSync(out, text);
  console.log(`dataset ${out}: ${observations.length} observations, sha256 ${sha(text)}`);
}

if (process.argv[1]?.endsWith('build-dataset.mjs')) main();
