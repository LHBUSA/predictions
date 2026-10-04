// PREDICTIONS V4 event record rendering: forecast + frozen facts + independent venues; a venue that does not list the
// contract never breaks the record; a non-official decision never renders as a PBE call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEvent } from '../workers/pbe-predictions/src/pages.js';
import { venueBlock, kalshiQuote, polymarketQuote } from '../src/engine/venues.js';
import { buildEvidencePacket } from '../src/engine/evidence.js';
import { publicEventView } from '../workers/pbe-predictions/src/premium.js';

const NOW = '2026-10-04T13:05:00Z';
const fc = [{ forecast_id: 'F1', captured_at: '2026-10-04T11:00:09Z', probability: 0.68, roles: ['FIRST_PUBLISHED'] }];
const kal = venueBlock({ venue: 'kalshi', quotes: [kalshiQuote({ captured_at: '2026-10-04T10:58:00Z', probability: 0.59, bid: 0.58, ask: 0.6 }), kalshiQuote({ captured_at: '2026-10-04T13:00:00Z', probability: 0.63, bid: 0.62, ask: 0.64 })], state: 'DEFINING_VENUE', marketId: 'KXRAIN-X', url: 'https://kalshi.com/markets/kxrain/x', forecasts: fc, now: NOW });
const pmRow = (t, b, a) => polymarketQuote({ observed_at: t, bid_bp: b, ask_bp: a, comparable_mid_bp: (a + b) / 2, market_state: 'open' });

async function record(polymarket, decision = { state: 'CALL', side: 'YES', official: false }) {
  const forecast = { forecast_id: 'F1', contract_id: 'C1', model_id: 'pbe-weather-precip', model_version: '1.1.0', model_state: 'RESEARCH', probability: 0.68, confidence: 'HIGH', captured_at: fc[0].captured_at, data_cutoff_at: '2026-10-04T11:00:00Z', feature_snapshot_id: 'S1', features_sha256: 'f'.repeat(64), provenance: [{ source: 'NWS National Blend of Models (NBS) station guidance', provider: 'NOAA/NWS', role: 'model input', available_at: '2026-10-04T11:00:00Z' }], explanation: {} };
  const { packet, sha256 } = await buildEvidencePacket({ event: { event_id: 'E' }, contract: { contract_id: 'C1' }, forecast, snapshot: { snapshot_id: 'S1', cutoff_at: '2026-10-04T11:00:00Z', features: { nbm_pop_union: 0.62 } } });
  const o = { contract_id: 'C1', market_id: 'KXRAIN-X', label: 'Rain in Boston', status: 'NORMALIZED', pbe_pct: 68, market_pct: 63, divergence_pts: 5, model: 'pbe-weather-precip@1.1.0', kalshi_url: kal.url, evidence: [], provenance: forecast.provenance, history: [{ forecast_id: 'F1', t: fc[0].captured_at, pct: 68, market_pct: 59, model: 'pbe-weather-precip@1.1.0', roles: ['FIRST_PUBLISHED'], changed: [], sha: 'x' }], market_path: [{ t: NOW, pct: 63 }], scores: [], venue_scores: [],
    venues: { kalshi: kal, polymarket }, call: { forecast_id: 'F1', pbe_pct: 68, confidence: 'HIGH', model: 'pbe-weather-precip@1.1.0', model_state: 'RESEARCH', published_at: fc[0].captured_at, data_cutoff_at: forecast.data_cutoff_at, evidence_sha256: sha256, evidence: packet, summary: 'National Blend of Models: chance of rain in the climate day 62%.', decision } };
  return publicEventView({ event: { event_id: 'E', slug: 'rain-boston', title: 'Will it rain in Boston?', category: 'WEATHER', category_label: 'Weather', state: 'RESEARCH', venue: 'Kalshi', venue_event_id: 'KXRAIN-X', kalshi_url: kal.url, lifecycle: 'ACTIVE', close_time: '2026-10-05T04:59:00Z', latest_forecast_at: fc[0].captured_at, latest_market_at: NOW, date_modified: NOW, created_at: NOW }, model: null, contract: null, distribution: null, outcomes: [o] });
}

test('both venues: exact Polymarket compares; the record shows call-time benchmarks and movement', async () => {
  const pm = venueBlock({ venue: 'polymarket', quotes: [pmRow('2026-10-04T10:50:00Z', 6000, 6400), pmRow('2026-10-04T12:50:00Z', 6500, 6700)], state: 'EXACT_MATCH', marketId: 'PM1', url: 'https://polymarket.com/event/x', forecasts: fc, now: NOW });
  const html = renderEvent(await record(pm));
  assert.match(html, /PBE FORECAST/);
  assert.doesNotMatch(html, /PBE CALL|CALL YES/, 'DRAFT decision never renders as a call');
  assert.match(html, /Why PBE sees it — the frozen facts/);
  assert.match(html, /Market view — Rain in Boston/);
  assert.match(html, /PBE vs Kalshi \+5 pts/);
  assert.match(html, /PBE vs Polymarket \+2 pts<\/b> · PBE \/ market agreement/);
  assert.match(html, /PBE vs market at each forecast/);
  assert.match(html, /Kalshi: <b class="num">59%<\/b> at the current PBE forecast → <b class="num">63%<\/b> now/);
  assert.match(html, /Permanent record/);
  assert.doesNotMatch(html, /consensus|average[ds]? (?:of|price|probability)|blended/i);
});

test('related market (RULE_MISMATCH): native price, labelled, never a gap', async () => {
  const pm = venueBlock({ venue: 'polymarket', quotes: [pmRow('2026-10-04T10:50:00Z', 7000, 7200)], state: 'RULE_MISMATCH', reasons: ['exceptions_differs'], marketId: 'PM1', url: 'https://polymarket.com/event/x', forecasts: fc, now: NOW });
  const html = renderEvent(await record(pm));
  assert.match(html, /RELATED MARKET · RULES DIFFER/);
  assert.match(html, /exception rules differ/);
  assert.doesNotMatch(html, /PBE vs Polymarket [+−]/);
  assert.match(html, /not compared/);
});

test('venue absent: the record still renders, Polymarket reads "not listed"', async () => {
  const html = renderEvent(await record(null));
  assert.match(html, /Market view/);
  assert.match(html, /No comparable market/);
  assert.doesNotMatch(html, /Polymarket<\/span><strong/);
});

test('an OFFICIAL decision renders as the call', async () => {
  const html = renderEvent(await record(null, { state: 'CALL', side: 'YES', official: true, reasons: [] }));
  assert.match(html, /PBE CALL/);
  assert.match(html, /CALL YES · 68%/);
});
