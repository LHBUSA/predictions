// Kalshi partner CTA on the Predictions member event record (kalshi-partner/1, owner brief 2026-10-07).
// "Kalshi ↗" keeps the canonical market URL; ONE "New to Kalshi?" line per Market view, only when enabled + Kalshi shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventIntel, headlineOutcome } from '../workers/pbe-predictions/src/pages.js';
import { marketView } from '../workers/pbe-predictions/src/record-blocks.js';
import { partnerConfigFor, _resetPartnerMemo } from '../workers/pbe-predictions/src/partner-config.js';
import { venueBlock, kalshiQuote, polymarketQuote } from '../src/engine/venues.js';
import { buildEvidencePacket } from '../src/engine/evidence.js';
import { premiumEventView } from '../workers/pbe-predictions/src/premium.js';

const CFG = { contract: 'kalshi-partner/1', enabled: true, path: '/go/kalshi' };
const NOW = '2026-10-04T13:05:00Z';
const fc = [{ forecast_id: 'F1', captured_at: '2026-10-04T11:00:09Z', probability: 0.68, roles: ['FIRST_PUBLISHED'] }];
const kal = venueBlock({ venue: 'kalshi', quotes: [kalshiQuote({ captured_at: '2026-10-04T10:58:00Z', probability: 0.59, bid: 0.58, ask: 0.6 }), kalshiQuote({ captured_at: '2026-10-04T13:00:00Z', probability: 0.63, bid: 0.62, ask: 0.64 })], state: 'DEFINING_VENUE', marketId: 'KXRAIN-X', url: 'https://kalshi.com/markets/kxrain/x', forecasts: fc, now: NOW });
const pmRow = (t, b, a) => polymarketQuote({ observed_at: t, bid_bp: b, ask_bp: a, comparable_mid_bp: (a + b) / 2, market_state: 'open' });

async function record(polymarket, decision = { state: 'CALL', side: 'YES', official: false }) {
  const forecast = { forecast_id: 'F1', contract_id: 'C1', model_id: 'pbe-weather-precip', model_version: '1.1.0', model_state: 'RESEARCH', probability: 0.68, confidence: 'HIGH', captured_at: fc[0].captured_at, data_cutoff_at: '2026-10-04T11:00:00Z', feature_snapshot_id: 'S1', features_sha256: 'f'.repeat(64), provenance: [{ source: 'NWS National Blend of Models (NBS) station guidance', provider: 'NOAA/NWS', role: 'model input', available_at: '2026-10-04T11:00:00Z' }], explanation: {} };
  const { packet, sha256 } = await buildEvidencePacket({ event: { event_id: 'E' }, contract: { contract_id: 'C1' }, forecast, snapshot: { snapshot_id: 'S1', cutoff_at: '2026-10-04T11:00:00Z', features: { nbm_pop_union: 0.62 } } });
  const o = { contract_id: 'C1', market_id: 'KXRAIN-X', label: 'Rain in Boston', status: 'NORMALIZED', pbe_pct: 68, market_pct: 63, divergence_pts: 5, model: 'pbe-weather-precip@1.1.0', kalshi_url: kal.url, evidence: [], provenance: forecast.provenance, history: [{ forecast_id: 'F1', t: fc[0].captured_at, pct: 68, market_pct: 59, model: 'pbe-weather-precip@1.1.0', roles: ['FIRST_PUBLISHED'], changed: [], sha: 'x' }], market_path: [{ t: NOW, pct: 63 }], scores: [], venue_scores: [],
    venues: { kalshi: kal, polymarket }, call: { forecast_id: 'F1', pbe_pct: 68, confidence: 'HIGH', model: 'pbe-weather-precip@1.1.0', model_state: 'RESEARCH', published_at: fc[0].captured_at, data_cutoff_at: forecast.data_cutoff_at, evidence_sha256: sha256, evidence: packet, summary: 'National Blend of Models: chance of rain in the climate day 62%.', decision } };
  return premiumEventView({ event: { event_id: 'E', slug: 'rain-boston', title: 'Will it rain in Boston?', category: 'WEATHER', category_label: 'Weather', state: 'RESEARCH', venue: 'Kalshi', venue_event_id: 'KXRAIN-X', kalshi_url: kal.url, lifecycle: 'ACTIVE', close_time: '2026-10-05T04:59:00Z', latest_forecast_at: fc[0].captured_at, latest_market_at: NOW, date_modified: NOW, created_at: NOW }, model: null, contract: null, distribution: null, outcomes: [o] });
}


const html = (rec, partner) => { const x = eventIntel(rec, { multiVenue: true, partner }); return x.main + x.aside; };

test('enabled: one partner line under Market view, first-party route, sponsored, disclosed', async () => {
  const out = html(await record(null), CFG);
  assert.equal((out.match(/class="kxp__a"/g) || []).length, 1);
  assert.match(out, /href="\/go\/kalshi\?placement=predictions_contract&amp;sport=predictions&amp;event=E&amp;contract=KXRAIN-X&amp;page=%2Fevents%2Frain-boston"/);
  assert.match(out, /rel="sponsored noopener noreferrer"/);
  assert.match(out, /New to Kalshi\? Get started/);
  assert.match(out, /may receive compensation for eligible new Kalshi customers/);
  assert.doesNotMatch(out, /\$\d|kalshi\.com\/p\/|referral=/);
});

test('VIEW MARKET links stay the canonical market URL, unchanged', async () => {
  const off = html(await record(null));
  const on = html(await record(null), CFG);
  const links = (s) => [...s.matchAll(/href="(https:\/\/kalshi\.com[^"]*)"/g)].map((m) => m[1]);
  assert.ok(links(off).length >= 1);
  assert.deepEqual(links(on), links(off));
  for (const u of links(on)) assert.equal(u, 'https://kalshi.com/markets/kxrain/x');
});

test('disabled / missing config: byte-identical to the pre-partner render', async () => {
  const rec = await record(null);
  const base = html(rec);
  assert.equal(html(rec, { contract: 'kalshi-partner/1', enabled: false }), base);
  assert.equal(html(rec, null), base);
  assert.doesNotMatch(base, /kxp|New to Kalshi/);
  const h = headlineOutcome(rec);
  assert.equal(marketView(h), marketView(h, {}));
});

test('no Kalshi market shown -> no partner line', async () => {
  const rec = await record(null);
  const h = headlineOutcome(rec);
  const noK = { ...h, venues: { ...h.venues, kalshi: null, polymarket: venueBlock({ venue: 'polymarket', quotes: [polymarketQuote({ observed_at: '2026-10-04T12:50:00Z', bid_bp: 6500, ask_bp: 6700, comparable_mid_bp: 6600, market_state: 'open' })], state: 'EXACT_MATCH', marketId: 'PM1', url: 'https://polymarket.com/event/x', forecasts: fc, now: NOW }) } };
  assert.doesNotMatch(marketView(noK, { partner: CFG }), /kxp/);
});

test('partnerConfigFor: reads the market service binding, fails closed, memoizes', async () => {
  _resetPartnerMemo();
  let calls = 0;
  const env = { MARKETS: { fetch: async (u) => { calls++; assert.equal(new URL(u).pathname, '/v1/partner/kalshi'); return new Response(JSON.stringify(CFG)); } } };
  assert.deepEqual(await partnerConfigFor(env, 0), CFG);
  assert.deepEqual(await partnerConfigFor(env, 1000), CFG);
  assert.equal(calls, 1);
  _resetPartnerMemo();
  assert.equal((await partnerConfigFor({ MARKETS: { fetch: async () => { throw new Error('down'); } } }, 0)).enabled, false);
  _resetPartnerMemo();
  assert.equal((await partnerConfigFor({ MARKETS: { fetch: async () => new Response(JSON.stringify({ ...CFG, path: 'https://evil.example' })) } }, 0)).enabled, false);
  _resetPartnerMemo();
  assert.equal((await partnerConfigFor({}, 0)).enabled, false);
  _resetPartnerMemo();
});

test('methodology states compensation never affects predictions; rewrite is fixed', () => {
  const m = readFileSync(new URL('../methodology/index.html', import.meta.url), 'utf8');
  assert.match(m, /Compensation never affects PBE predictions, model probabilities, rankings, comparison classifications or editorial conclusions/);
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(v.rewrites.find((r) => r.source === '/go/kalshi'), { source: '/go/kalshi', destination: 'https://propsports-markets.sales-fd3.workers.dev/go/kalshi' });
});
