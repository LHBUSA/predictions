import test from 'node:test';
import assert from 'node:assert/strict';
import { ZillowZoriAdapter, parseZoriCsv } from '../src/zillow-zori.js';
import { zoriToObservation } from '../workers/source-zori/src/index.js';

test('ZORI CSV parser preserves quoted metro names with commas', () => {
  const rows = parseZoriCsv('RegionID,RegionName,StateName,2025-08-31,2026-07-31,2026-08-31\n102001,"Minneapolis-St. Paul-Bloomington, MN-WI",MN,1800,1880,1890\n');
  assert.equal(rows[1][1], 'Minneapolis-St. Paul-Bloomington, MN-WI');
});

test('ZORI adapter calculates exact calendar MoM and YoY', async () => {
  const csv = [
    'RegionID,SizeRank,RegionName,RegionType,StateName,2025-08-31,2026-07-31,2026-08-31',
    '102001,15,"Minneapolis-St. Paul-Bloomington, MN-WI",msa,MN,1800,1880,1890'
  ].join('\n');
  const adapter = new ZillowZoriAdapter({
    fetchImpl: async () => new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })
  });
  const payload = await adapter.metro('Minneapolis-St. Paul-Bloomington, MN-WI');
  assert.equal(payload.period, '2026-08');
  assert.equal(payload.value, 1890);
  assert.ok(Math.abs(payload.momPct - ((1890 / 1880 - 1) * 100)) < 1e-12);
  assert.ok(Math.abs(payload.yoyPct - 5) < 1e-12);
  assert.equal(payload.geography.regionId, '102001');
});

test('ZORI observation is only point-in-time safe from actual capture forward', () => {
  const observation = zoriToObservation({
    provider: 'Zillow Research',
    sourceId: 'zori:state:9',
    sourceUrl: 'https://files.zillowstatic.com/example.csv',
    scope: 'state',
    geography: { level: 'state', state: 'MN', metro: null, regionId: '9' },
    dataset: 'Zillow Observed Rent Index',
    frequency: 'monthly',
    fetchedAt: '2026-09-16T21:15:00Z',
    period: '2026-08',
    periodEnd: '2026-08-31T23:59:59.999Z',
    value: 1500,
    priorMonth: 1490,
    priorMonthPeriod: '2026-07',
    yearAgo: 1450,
    yearAgoPeriod: '2025-08',
    momPct: 0.6711409396,
    yoyPct: 3.4482758621
  });
  assert.equal(observation.availableAt, '2026-09-16T21:15:00.000Z');
  assert.equal(observation.capturedAt, '2026-09-16T21:15:00.000Z');
  assert.equal(observation.vintage, '2026-08');
  assert.equal(observation.provenance.availabilityPrecision, 'capture-time');
});
