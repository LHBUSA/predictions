// PREDICTIONS V4 — Kalshi + Polymarket as independent first-class benchmarks. No averaging, comparisons only where
// semantics permit, and a benchmark at T is never repaired with a later observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { venueBlock, quoteAtOrBefore, divergence, semantics, kalshiQuote, polymarketQuote, freshness, NO_OBSERVATION, AGREEMENT_PTS } from '../src/engine/venues.js';
import { coverageFromTicks } from '../workers/pbe-predictions/src/venue-data.js';
import { venueScores } from '../workers/pbe-predictions/src/api.js';
import { publicEventView, premiumEventView } from '../workers/pbe-predictions/src/premium.js';

const pmRow = (t, bid, ask) => polymarketQuote({ observed_at: t, bid_bp: bid, ask_bp: ask, comparable_mid_bp: (bid + ask) / 2, market_state: 'open', observation_ref: t });
const quotes = [pmRow('2026-10-04T10:00:00Z', 5800, 6000), pmRow('2026-10-04T11:00:00Z', 6100, 6300), pmRow('2026-10-04T13:00:00Z', 7000, 7200)];
const forecasts = [{ forecast_id: 'f-first', captured_at: '2026-10-04T09:00:00Z', probability: 0.68, roles: ['FIRST_PUBLISHED'] }, { forecast_id: 'f-cur', captured_at: '2026-10-04T12:00:00Z', probability: 0.68, roles: [] }];
const NOW = '2026-10-04T13:05:00Z';

test('benchmark at T = latest observation at or before T; never a later one; none -> permanent NO_OBSERVATION', () => {
  assert.equal(quoteAtOrBefore(quotes, '2026-10-04T12:00:00Z').observed_at, '2026-10-04T11:00:00Z');
  assert.equal(quoteAtOrBefore(quotes, '2026-10-04T11:00:00Z').observed_at, '2026-10-04T11:00:00Z');
  assert.equal(quoteAtOrBefore(quotes, '2026-10-04T09:59:59Z'), null);
  const b = venueBlock({ venue: 'polymarket', quotes, state: 'EXACT_MATCH', marketId: 'pm1', forecasts, now: NOW });
  assert.equal(b.at_forecast[0].benchmark, NO_OBSERVATION, 'PBE published before the first stored observation');
  assert.equal(b.at_forecast[1].benchmark.observed_at, '2026-10-04T11:00:00Z');
  assert.equal(b.at_forecast[1].benchmark.mid_pct, 62);
  assert.equal(b.at_forecast[1].benchmark.observation_age_s, 3600);
  assert.deepEqual(b.at_forecast[1].divergence, { pts: 6, label: 'PBE_ABOVE_MARKET' });
  // adding later observations (the market moving after the call) cannot change the frozen benchmark
  const later = venueBlock({ venue: 'polymarket', quotes: [...quotes, pmRow('2026-10-04T12:30:00Z', 9000, 9200)], state: 'EXACT_MATCH', marketId: 'pm1', forecasts, now: NOW });
  assert.deepEqual(later.at_forecast, b.at_forecast);
  assert.equal(later.current.mid_pct, 71);
});

test('observer coverage: a stale change row is not a benchmark when the observer was not reading at T', () => {
  const ticks = ['2026-10-04T10:55:00Z', '2026-10-04T11:00:00Z'].map(Date.parse);
  const cov = coverageFromTicks(ticks);
  assert.equal(cov('2026-10-04T11:10:00Z'), true);
  assert.equal(cov('2026-10-04T12:00:00Z'), false, 'last tick 60 min before T');
  const b = venueBlock({ venue: 'polymarket', quotes, state: 'EXACT_MATCH', marketId: 'pm1', forecasts, now: NOW, coverageAt: cov });
  assert.equal(b.at_forecast[1].benchmark, NO_OBSERVATION);
  assert.equal(coverageFromTicks([]), null);
});

test('semantics: EXACT compares; RULE_MISMATCH shows native price without divergence; UNVERIFIED no inference; others omitted', () => {
  assert.equal(semantics('EXACT_MATCH').comparable, true);
  assert.equal(semantics('DEFINING_VENUE').comparable, true);
  assert.equal(semantics('COMPARABLE_EXCEPT_EXCEPTIONS', 'fed_decision').comparable, false, 'exception family not approved');
  assert.equal(semantics('COMPARABLE_EXCEPT_EXCEPTIONS', 'sports_postponement_cancellation').comparable, true);
  for (const s of ['VENUE_ONLY', 'SAME_EVENT_DIFFERENT_OUTCOME', 'UNRELATED', undefined]) assert.equal(semantics(s).display, 'omit');
  const rm = venueBlock({ venue: 'polymarket', quotes, state: 'RULE_MISMATCH', reasons: ['exceptions_differs'], marketId: 'pm1', forecasts, now: NOW });
  assert.equal(rm.comparable, false);
  assert.equal(rm.current.mid_pct, 71, 'native price still shown');
  assert.equal(rm.divergence_now, null);
  assert.ok(rm.at_forecast.every((a) => !a.divergence));
  assert.equal(venueBlock({ venue: 'polymarket', quotes, state: 'SAME_EVENT_DIFFERENT_OUTCOME', marketId: 'pm1', forecasts, now: NOW }), null);
  const un = venueBlock({ venue: 'polymarket', quotes, state: 'UNVERIFIED', marketId: 'pm1', forecasts, now: NOW });
  assert.equal(un.display, 'native_price_unverified'); assert.equal(un.divergence_now, null);
});

test('divergence labels (pbe-vs-venue/1) and freshness', () => {
  assert.deepEqual(divergence(60, 5800 + AGREEMENT_PTS * 100), { pts: 0, label: 'PBE_MARKET_AGREEMENT' });
  assert.equal(divergence(60, 5700).label, 'PBE_ABOVE_MARKET');
  assert.equal(divergence(50, 5700).label, 'PBE_BELOW_MARKET');
  assert.equal(divergence(null, 5700), null);
  assert.equal(divergence(50, null), null, 'no two-sided quote -> no divergence');
  assert.equal(freshness('2026-10-04T13:03:00Z', NOW).label, 'live');
  assert.equal(freshness('2026-10-04T13:00:00Z', NOW).label, 'delayed');
  assert.equal(freshness('2026-10-04T11:30:00Z', NOW).label, 'delayed');
  assert.equal(freshness('2026-10-04T05:00:00Z', NOW).label, 'stale');
});

test('kalshi quote shape from pred_venue_snapshots; final pre-close only once closed', () => {
  const k = kalshiQuote({ captured_at: '2026-10-04T11:00:00Z', probability: 0.595, bid: 0.59, ask: 0.6, lifecycle: 'ACTIVE', snapshot_key: 's1' });
  assert.deepEqual([k.mid_bp, k.bid_bp, k.ask_bp, k.ref], [5950, 5900, 6000, 's1']);
  const open = venueBlock({ venue: 'kalshi', quotes: [k], state: 'DEFINING_VENUE', marketId: 'KX', closeTime: '2026-10-05T00:00:00Z', forecasts, now: NOW });
  assert.equal(open.final_pre_close, null);
  const closed = venueBlock({ venue: 'kalshi', quotes: [k], state: 'DEFINING_VENUE', marketId: 'KX', closeTime: '2026-10-04T12:30:00Z', forecasts, now: NOW });
  assert.equal(closed.final_pre_close.mid_pct, 60);
});

test('venue scores: same contract, same outcome, same designated timestamp; missing venues carry a reason, never a number', () => {
  const kal = venueBlock({ venue: 'kalshi', quotes: [kalshiQuote({ captured_at: '2026-10-04T08:59:00Z', probability: 0.55, bid: 0.54, ask: 0.56 })], state: 'DEFINING_VENUE', marketId: 'KX', forecasts, now: NOW });
  const pmEx = venueBlock({ venue: 'polymarket', quotes, state: 'EXACT_MATCH', marketId: 'pm1', forecasts, now: NOW });
  const rows = [{ designation: 'FIRST_PUBLISHED', forecast_id: 'f-first', scoring_method: 'brier', score: 0.1024 }, { designation: 'FIRST_PUBLISHED', forecast_id: 'f-first', scoring_method: 'log_loss', score: 0.386 }];
  const [s] = venueScores(rows, { kalshi: kal, polymarket: pmEx }, 1);
  assert.equal(s.pbe_brier, 0.1024);
  assert.equal(s.kalshi.status, 'SCORED'); assert.equal(s.kalshi.brier, +((0.55 - 1) ** 2).toFixed(6));
  assert.equal(s.polymarket.status, NO_OBSERVATION, 'no Polymarket observation existed at the FIRST_PUBLISHED timestamp');
  const [s2] = venueScores(rows, { kalshi: kal, polymarket: null }, 1);
  assert.equal(s2.polymarket.status, 'VENUE_NOT_LISTED');
  const pmRm = venueBlock({ venue: 'polymarket', quotes, state: 'RULE_MISMATCH', marketId: 'pm1', forecasts, now: NOW });
  assert.equal(venueScores(rows, { kalshi: kal, polymarket: pmRm }, 1)[0].polymarket.status, 'NOT_COMPARABLE');
});

test('Free / All Access: public venue blocks keep checkpoints, drop the full path; DRAFT decisions never leave admin', () => {
  const v = venueBlock({ venue: 'polymarket', quotes, state: 'EXACT_MATCH', marketId: 'pm1', forecasts, now: NOW });
  const rec = { event: {}, outcomes: [{ history: [{ forecast_id: 'f-cur', roles: [], changed: [], sha: 'x' }], market_path: [], venues: { kalshi: null, polymarket: v }, call: { pbe_pct: 68, evidence: {}, decision: { state: 'CALL', official: false } } }] };
  const pub = publicEventView(rec);
  assert.deepEqual(pub.outcomes[0].venues.polymarket.path, []);
  assert.equal(pub.outcomes[0].venues.polymarket.path_n, 3);
  assert.equal(pub.outcomes[0].venues.polymarket.at_forecast.length, 2);
  assert.equal('decision' in pub.outcomes[0].call, false);
  assert.equal('decision' in premiumEventView(rec).outcomes[0].call, false);
  assert.equal(premiumEventView(rec).outcomes[0].venues.polymarket.path.length, 3, 'members get the complete stored path');
  const official = { ...rec, outcomes: [{ ...rec.outcomes[0], call: { ...rec.outcomes[0].call, decision: { state: 'CALL', official: true } } }] };
  assert.equal(publicEventView(official).outcomes[0].call.decision.state, 'CALL');
});
