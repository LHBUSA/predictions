// PBE branded subdomains (#66): exact host -> canonical path mappings, query/UTM kept, permanent vs proving status,
// inactive and unknown hosts 404, non-GET never redirected, no indexing, and wrangler routes == active hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, HOSTS, CANONICAL } from '../workers/pbe-vanity/src/index.js';

const req = (url, method = 'GET') => new Request(url, { method });
const all = Object.fromEntries(Object.entries(HOSTS).map(([h, v]) => [h, { ...v, active: true }]));

test('all five hosts map to their full canonical paths (when active)', () => {
  const want = {
    'crypto.propbetedge.ai': `${CANONICAL}/crypto/`,
    'gold.propbetedge.ai': `${CANONICAL}/commodities/gold/`,
    'silver.propbetedge.ai': `${CANONICAL}/commodities/silver/`,
    'platinum.propbetedge.ai': `${CANONICAL}/commodities/platinum/`,
    'futures.propbetedge.ai': `${CANONICAL}/markets/futures/`,
  };
  for (const [h, to] of Object.entries(want)) {
    const r = handle(req(`https://${h}/`), {}, all);
    assert.equal(r.status, 308, h); assert.equal(r.headers.get('location'), to, h);
  }
  assert.equal(Object.keys(HOSTS).length, 5);
  assert.ok(!Object.keys(HOSTS).some((h) => h.includes('*')), 'no wildcards');
});

test('crypto: permanent 308 by default, 307 while proving; query/UTM kept; any path lands on the canonical page', () => {
  const r = handle(req('https://crypto.propbetedge.ai/?utm_source=x&utm_campaign=y'));
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), 'https://predictions.propbetedge.ai/crypto/?utm_source=x&utm_campaign=y');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  assert.equal(r.headers.get('set-cookie'), null, 'never sets cookies');
  assert.equal(handle(req('https://crypto.propbetedge.ai/'), { REDIRECT_STATUS: '307' }).status, 307);
  assert.equal(handle(req('https://CRYPTO.propbetedge.ai/anything/deep')).headers.get('location'), 'https://predictions.propbetedge.ai/crypto/');
  assert.equal(handle(req('https://crypto.propbetedge.ai/', 'HEAD')).status, 308);
});

test('inactive and unknown hosts 404; the canonical host itself is never redirected (no loop)', () => {
  for (const h of ['gold', 'silver', 'platinum', 'futures']) assert.equal(handle(req(`https://${h}.propbetedge.ai/`)).status, 404, h);
  assert.equal(handle(req('https://predictions.propbetedge.ai/crypto/')).status, 404);
  assert.equal(handle(req('https://evil.example.com/')).status, 404);
  assert.equal(handle(req('https://propbetedge.ai/')).status, 404);
});

test('non-GET is never redirected (405 with Allow)', () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = handle(req('https://crypto.propbetedge.ai/', m));
    assert.equal(r.status, 405, m); assert.equal(r.headers.get('allow'), 'GET, HEAD'); assert.equal(r.headers.get('location'), null);
  }
});

test('wrangler custom domains are exactly the active hosts; proving status configured', () => {
  const cfg = readFileSync(new URL('../workers/pbe-vanity/wrangler.jsonc', import.meta.url), 'utf8');
  const patterns = [...cfg.matchAll(/"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/g)].map((m) => m[1]).sort();
  const active = Object.entries(HOSTS).filter(([, v]) => v.active).map(([h]) => h).sort();
  assert.deepEqual(patterns, active);
  assert.match(cfg, /"REDIRECT_STATUS":\s*"30[78]"/);
});
