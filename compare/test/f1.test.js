// F1 in Compare (owner 2026-10-06): race winner = approved comparable field (gap + cross per driver); championships =
// RULE_MISMATCH field (never compared).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, keyDifferences, ruleTermsView } from '../core.js';

const RT_RACE = { version: 'rule-terms/1', differs: ['cancellation', 'postponement', 'data_source'],
  kalshi: { complete: true, terms: [{ topic: 'postponement', condition: 'starts_within_48h', treatment: 'open_until_completed' }, { topic: 'cancellation', condition: 'cancelled_or_not_started_within_48h', treatment: 'fair_price' }] },
  polymarket: { complete: true, terms: [{ topic: 'cancellation', condition: 'cancelled_or_beyond_7d', treatment: 'other_bucket' }, { topic: 'postponement', condition: 'rescheduled_beyond_7d', treatment: 'other_bucket' }, { topic: 'data_source', condition: 'fallback', treatment: 'consensus_allowed' }] } };
const at = '2026-10-10T12:00:00Z';
const q = (venue, mid, match) => ({ venue, match, mid_bp: mid, bid_bp: mid - 50, ask_bp: mid + 50, freshness: 'live', observed_at: at, rule_terms: RT_RACE, disclosure: 'Official race result rules match. Postponement, cancellation and fallback-source settlement rules differ between venues.' });
const drv = (id, name, k, p) => ({ canonical_contract_id: `race_winner|f1:R|team:${id}`, label: name, role: `p:${id}`, venues: [q('kalshi', k, 'EXACT_MATCH'), q('polymarket', p, 'COMPARABLE_EXCEPT_EXCEPTIONS')], related: [], comparison: { aligned_within_s: 10, venue_gap_pts: Math.abs(k - p) / 100, disclosure: 'x' } });

test('race field: COMPARABLE, drivers by price, gap + top-of-book cross computed per driver', () => {
  const e = normalizeEvent({ canonical_event_id: '2026-singapore-grand-prix-race', sport: 'f1', title: 'Singapore Grand Prix', contracts: [drv('lando-norris', 'Lando Norris', 1200, 1100), drv('max-verstappen', 'Max Verstappen', 3000, 3150)] });
  assert.equal(e.badge, 'COMPARABLE');
  assert.deepEqual(e.field, { n: 2, noun: 'drivers' });
  assert.equal(e.contracts[0].label, 'Max Verstappen');
  assert.equal(e.contracts[0].gap_pts, 1.5);
  assert.deepEqual([e.contracts[0].cross.state, e.contracts[0].cross.bp, e.contracts[0].cross.bid_venue], ['CROSS', 50, 'polymarket'], 'PM bid 31.0 vs Kalshi ask 30.5');
  assert.equal(e.join.state, 'NOT_APPLICABLE');
});

test('race key difference + vocabulary render without gaps', () => {
  assert.deepEqual(keyDifferences(RT_RACE), ['Cancelled: Kalshi → fair price; Polymarket → "Other" (every listed driver No).']);
  const v = ruleTermsView(RT_RACE);
  assert.equal(v.kalshi.unknown || v.polymarket.unknown, false);
});

test('constructors championship is a TEAM field', () => {
  const e = normalizeEvent({ canonical_event_id: 'f1-2026-constructors-championship', sport: 'f1', title: "2026 F1 Constructors' Championship", contracts: [{ canonical_contract_id: 'season_champion|f1:C|team:mercedes', label: 'Mercedes', venues: [q('kalshi', 9850, 'EXACT_MATCH')], related: [{ ...q('polymarket', 9880, 'RULE_MISMATCH'), reasons: ['exceptions_differs'] }] }] });
  assert.equal(e.field.noun, 'teams');
  assert.equal(e.badge, 'RULE_MISMATCH');
  assert.ok(e.contracts.every((c) => c.gap_pts === null && c.cross === null));
});
