import test from 'node:test';
import assert from 'node:assert/strict';
import { CensusBpsAdapter } from '../src/census-bps.js';
import { permitsToObservation } from '../workers/source-permits/src/index.js';

test('BPS adapter probes past unpublished month and computes exact YoY', async () => {
  const seen = [];
  const adapter = new CensusBpsAdapter({
    apiKey: 'census-secret',
    now: () => new Date('2026-09-16T20:00:00Z'),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      seen.push(parsed);
      assert.equal(parsed.searchParams.get('key'), 'census-secret');
      const period = parsed.searchParams.get('time');
      if (period === '2026-08') return new Response('not found', { status: 404 });
      if (period === '2026-07') {
        return Response.json([
          ['NAME', 'PERMIT', 'GEO_ID', 'state'],
          ['Minnesota', '1200', '0400000US27', '27']
        ]);
      }
      if (period === '2025-07') {
        return Response.json([
          ['NAME', 'PERMIT', 'GEO_ID', 'state'],
          ['Minnesota', '1000', '0400000US27', '27']
        ]);
      }
      return new Response('not found', { status: 404 });
    }
  });

  const payload = await adapter.latest({ state: 'MN' });
  assert.equal(payload.period, '2026-07');
  assert.equal(payload.value, 1200);
  assert.equal(payload.yearAgo, 1000);
  assert.ok(Math.abs(payload.yoyPct - 20) < 1e-12);
  assert.equal(payload.geography.state, 'MN');
  assert.equal(seen[0].searchParams.get('for'), 'state:27');
});

test('BPS observation becomes point-in-time safe at actual capture, not historical month end', () => {
  const observation = permitsToObservation({
    provider: 'U.S. Census Bureau',
    sourceId: 'census-bps:state:MN',
    sourceUrl: 'https://www.census.gov/construction/bps/',
    geography: { level: 'state', state: 'MN', cbsa: null, name: 'Minnesota' },
    dataset: 'Building Permits Survey (BPS)',
    frequency: 'monthly revised',
    metric: 'PERMIT',
    fetchedAt: '2026-09-16T21:20:00Z',
    period: '2026-07',
    periodEnd: '2026-07-31T23:59:59.999Z',
    value: 1200,
    yearAgoPeriod: '2025-07',
    yearAgo: 1000,
    yoyPct: 20,
    geoId: '0400000US27',
    availabilitySemantics: 'capture-time-of-published-revised-month'
  });
  assert.equal(observation.availableAt, '2026-09-16T21:20:00.000Z');
  assert.equal(observation.capturedAt, '2026-09-16T21:20:00.000Z');
  assert.equal(observation.vintage, '2026-07');
  assert.equal(observation.data.yoyPct, 20);
});
