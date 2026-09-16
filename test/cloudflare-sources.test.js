import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareSourceTransport } from '../src/cloudflare-source.js';
import { BusinessIntelligenceAdapter, normalizeBusinessEin } from '../src/business-intelligence.js';
import { CensusIntelligenceAdapter, normalizeCensusZip } from '../src/census-intelligence.js';
import { createSourceObservation } from '../src/source-observation.js';

function bindingReturning(payload, onFetch = null) {
  return {
    async fetch(url, init) {
      if (onFetch) onFetch(String(url), init);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
}

test('Cloudflare source transport prefers service binding and keeps auth in header', async () => {
  let seenUrl;
  let seenInit;
  const transport = new CloudflareSourceTransport({
    serviceBinding: bindingReturning({ ok: true }, (url, init) => {
      seenUrl = url;
      seenInit = init;
    }),
    apiKey: 'internal-secret'
  });

  const response = await transport.request('/v1/example', { query: { zip: '55104' } });
  assert.match(seenUrl, /^https:\/\/source\.internal\/v1\/example\?zip=55104$/);
  assert.doesNotMatch(seenUrl, /internal-secret/);
  assert.equal(seenInit.headers['x-api-key'], 'internal-secret');
  assert.equal(response.transport, 'cloudflare_service_binding');
  assert.deepEqual(response.data, { ok: true });
});

test('Business Intelligence adapter normalizes EIN and preserves upstream source list', async () => {
  let seenUrl;
  const adapter = new BusinessIntelligenceAdapter({
    serviceBinding: bindingReturning({
      business_name: 'Example Co',
      data_sources: ['learned_businesses', 'sec_edgar']
    }, (url) => { seenUrl = url; }),
    apiKey: 'biz-secret'
  });

  const result = await adapter.lookup('12-3456789');
  assert.match(seenUrl, /\/v1\/business\?ein=12-3456789$/);
  assert.equal(result.sourceId, 'ein:123456789');
  assert.deepEqual(result.upstreamSources, ['learned_businesses', 'sec_edgar']);
  assert.equal(normalizeBusinessEin('123456789'), '12-3456789');
  assert.throws(() => normalizeBusinessEin('1234'), /9 digits/);
});

test('Census Intelligence adapter preserves ACS vintage and geography', async () => {
  const adapter = new CensusIntelligenceAdapter({
    serviceBinding: bindingReturning({
      data_year: 2023,
      data_source: 'Census ACS 5-Year Estimates',
      acs_survey: { acs_vintage: '2019-2023', geography: 'zcta5' },
      demographics: { total_population: 1000 }
    })
  });

  const result = await adapter.zip('55104');
  assert.equal(result.sourceId, 'acs:zcta:55104');
  assert.equal(result.vintage, '2019-2023');
  assert.deepEqual(result.geography, { zip: '55104' });
  assert.equal(normalizeCensusZip('55104-1234'), '55104');
});

test('source observations accept proprietary class without relabeling it official', () => {
  const observation = createSourceObservation({
    provider: 'PropTechUSA Business Intelligence',
    sourceId: 'ein:123456789',
    sourceClass: 'proprietary',
    capturedAt: '2026-09-16T18:00:00Z',
    data: { business_name: 'Example Co' },
    provenance: { upstreamSources: ['learned_businesses', 'sec_edgar'] }
  });
  assert.equal(observation.sourceClass, 'proprietary');
  assert.deepEqual(observation.provenance.upstreamSources, ['learned_businesses', 'sec_edgar']);
});
