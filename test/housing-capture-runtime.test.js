import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSourceObservation, sourceObservationKey } from '../src/source-observation.js';
import { ZillowZoriAdapter } from '../src/zillow-zori.js';
import {
  STATES,
  PERMIT_SHARDS,
  captureScheduledSignals,
  permitStatesForShard
} from '../workers/collector-housing-signals/src/index.js';

function sourceBinding(handler) {
  return { async fetch(_url, options) { return handler(JSON.parse(options.body)); } };
}

function observation(provider, sourceId, revision, vintage, geography = null) {
  return {
    provider,
    sourceId,
    sourceClass: provider === 'Zillow Research' ? 'research' : 'official',
    observedAt: '2026-08-31T23:59:59.999Z',
    availableAt: '2026-09-16T20:00:00.000Z',
    capturedAt: '2026-09-16T20:00:00.000Z',
    value: 1,
    data: {},
    units: null,
    geography,
    vintage,
    revision,
    provenance: {}
  };
}

test('revision identity makes recurring unchanged source captures idempotent', () => {
  const common = {
    provider: 'Zillow Research',
    sourceId: 'zori:state:9',
    sourceClass: 'research',
    observedAt: '2026-08-31T23:59:59.999Z',
    value: 1500,
    vintage: '2026-08',
    revision: '2026-08|1500|1490|1450'
  };
  const first = createSourceObservation({
    ...common,
    availableAt: '2026-09-16T20:00:00Z',
    capturedAt: '2026-09-16T20:00:00Z'
  });
  const second = createSourceObservation({
    ...common,
    availableAt: '2026-09-17T20:00:00Z',
    capturedAt: '2026-09-17T20:00:00Z'
  });
  assert.equal(sourceObservationKey(first), sourceObservationKey(second));
  assert.match(sourceObservationKey(first), /:rev:2026-08%7C1500%7C1490%7C1450$/);
});

test('sources without revision ids preserve capture-time identity', () => {
  const item = createSourceObservation({
    provider: 'Federal Housing Finance Agency',
    sourceId: 'fhfa-hpi:state:MN',
    sourceClass: 'official',
    observedAt: '2026-06-30T23:59:59.999Z',
    availableAt: '2026-09-16T08:17:01.977Z',
    capturedAt: '2026-09-16T08:17:01.977Z',
    value: 400
  });
  assert.equal(
    sourceObservationKey(item),
    'Federal Housing Finance Agency:fhfa-hpi:state:MN:2026-09-16T08:17:01.977Z'
  );
});

test('ZORI bulk state capture downloads one CSV and produces exact current rows', async () => {
  let calls = 0;
  const csv = [
    'RegionID,RegionName,StateName,2025-08-31,2026-07-31,2026-08-31',
    '9,Minnesota,Minnesota,1450,1490,1500',
    '12,Florida,Florida,2100,2190,2200'
  ].join('\n');
  const adapter = new ZillowZoriAdapter({
    fetchImpl: async () => {
      calls += 1;
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
    }
  });
  const rows = await adapter.states(['MN', 'FL']);
  assert.equal(calls, 1);
  assert.deepEqual(rows.map((item) => item.geography.state), ['MN', 'FL']);
  assert.deepEqual(rows.map((item) => item.value), [1500, 2200]);
});

test('ZORI bulk metro capture downloads one CSV for every populated metro row', async () => {
  let calls = 0;
  const csv = [
    'RegionID,RegionName,StateName,2025-08-31,2026-07-31,2026-08-31',
    '102001,"Minneapolis-St. Paul-Bloomington, MN-WI",MN,1800,1880,1890',
    '394913,"Miami-Fort Lauderdale-West Palm Beach, FL",FL,2400,2490,2500'
  ].join('\n');
  const adapter = new ZillowZoriAdapter({
    fetchImpl: async () => {
      calls += 1;
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
    }
  });
  const rows = await adapter.metros();
  assert.equal(calls, 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((item) => item.geography.regionId), ['102001', '394913']);
});

test('seven permit shards cover every state plus DC exactly once', () => {
  const all = [];
  for (let shard = 0; shard < PERMIT_SHARDS; shard += 1) all.push(...permitStatesForShard(shard));
  assert.equal(all.length, STATES.length);
  assert.equal(new Set(all).size, STATES.length);
  assert.deepEqual([...all].sort(), [...STATES].sort());
});

test('scheduled signal collector captures mortgage, state+metro ZORI, and one permit shard', async () => {
  const ledgerBatches = [];
  const permitRequests = [];
  const env = {
    SOURCE_MACRO: sourceBinding((body) => {
      assert.equal(body.seriesKey, 'mortgage30');
      return Response.json({ ok: true, data: observation('FRED', 'MORTGAGE30US', 'mortgage-r1', '2026-09-10') });
    }),
    SOURCE_ZORI: sourceBinding((body) => {
      if (body.bulk === 'states') {
        return Response.json({ ok: true, data: [
          observation('Zillow Research', 'zori:state:9', 'mn-r1', '2026-08', { level: 'state', state: 'MN' }),
          observation('Zillow Research', 'zori:state:12', 'fl-r1', '2026-08', { level: 'state', state: 'FL' })
        ] });
      }
      assert.equal(body.bulk, 'metros');
      return Response.json({ ok: true, data: [
        observation('Zillow Research', 'zori:metro:1', 'metro-r1', '2026-08', { level: 'metro', metro: 'Test Metro' })
      ] });
    }),
    SOURCE_PERMITS: sourceBinding((body) => {
      permitRequests.push(body.geography.state);
      const state = body.geography.state;
      return Response.json({ ok: true, data: observation(
        'U.S. Census Bureau',
        `census-bps:state:${state}`,
        `${state}-r1`,
        '2026-07',
        { level: 'state', state }
      ) });
    }),
    LEDGER: sourceBinding((body) => {
      ledgerBatches.push(body.observations);
      return Response.json({
        ok: true,
        data: {
          count: body.observations.length,
          observationKeys: body.observations.map((item) => `${item.provider}:${item.sourceId}:rev:${item.revision}`)
        }
      });
    })
  };

  const scheduledTime = Date.UTC(2026, 8, 20, 14, 30, 0);
  const expectedPermitStates = permitStatesForShard(0);
  const result = await captureScheduledSignals(env, scheduledTime);

  assert.equal(result.ok, true);
  assert.equal(result.permitShard, 0);
  assert.deepEqual(result.permitStates, expectedPermitStates);
  assert.deepEqual(permitRequests, expectedPermitStates);
  assert.equal(ledgerBatches.length, 4);
  assert.equal(ledgerBatches.flat().length, 1 + 2 + 1 + expectedPermitStates.length);
});

const CONFIGS = [
  'ledger',
  'source-housing-history',
  'source-macro',
  'source-zori',
  'source-permits',
  'source-propdata',
  'source-census',
  'feature-housing',
  'model-housing',
  'pipeline-housing',
  'collector-housing-history',
  'collector-housing-signals'
];

function config(name) {
  return JSON.parse(readFileSync(new URL(`../workers/${name}/wrangler.jsonc`, import.meta.url), 'utf8'));
}

function services(value) {
  return Object.fromEntries((value.services || []).map((item) => [item.binding, item.service]));
}

test('housing Workers are private and only collector Workers own crons', () => {
  for (const name of CONFIGS) {
    const value = config(name);
    assert.equal(value.compatibility_date, '2026-09-16', name);
    assert.equal(value.workers_dev, false, name);
    assert.equal(value.preview_urls, false, name);
    assert.equal(value.observability?.enabled, true, name);
    assert.match(value.name, /^pbe-predictions-/, name);
    if (!name.startsWith('collector-')) assert.equal(value.triggers, undefined, name);
  }
  assert.deepEqual(config('collector-housing-history').triggers?.crons, ['15 9 * * *']);
  assert.deepEqual(config('collector-housing-signals').triggers?.crons, ['30 14 * * *']);
});

test('upstream and pipeline service bindings target the canonical Worker graph', () => {
  assert.equal(services(config('source-propdata')).PROPDATA, 'propdata-api-worker');
  assert.equal(services(config('source-census')).CENSUS_INTEL, 'propdata-census-api');
  assert.deepEqual(services(config('pipeline-housing')), {
    SOURCE_PROPDATA: 'pbe-predictions-source-propdata',
    SOURCE_CENSUS: 'pbe-predictions-source-census',
    SOURCE_HOUSING_HISTORY: 'pbe-predictions-source-housing-history',
    SOURCE_MACRO: 'pbe-predictions-source-macro',
    SOURCE_ZORI: 'pbe-predictions-source-zori',
    SOURCE_PERMITS: 'pbe-predictions-source-permits',
    FEATURE_HOUSING: 'pbe-predictions-feature-housing',
    MODEL_HOUSING: 'pbe-predictions-model-housing',
    LEDGER: 'pbe-predictions-ledger'
  });
});
