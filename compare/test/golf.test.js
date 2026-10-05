// Golf field winner in Compare (owner decision 2026-10-05): RULE_MISMATCH, both prices shown, never a gap or cross.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, keyDifferences, ruleTermsView, termLine } from '../core.js';

const K = (mid) => ({ venue: 'kalshi', match: 'EXACT_MATCH', mid_bp: mid, bid_bp: mid - 50, ask_bp: mid + 50, freshness: 'live', observed_at: '2026-10-08T12:00:00Z' });
const P = (mid) => ({ venue: 'polymarket', match: 'RULE_MISMATCH', mid_bp: mid, bid_bp: mid - 50, ask_bp: mid + 50, freshness: 'live', observed_at: '2026-10-08T12:00:10Z', reasons: ['exceptions_differs'], reason: 'Rules differ: dead heat, postponement and cancellation settlement' });
// rule_terms exactly as the Worker emits them for golf (src/pm/golf.js + venues.js vocabulary)
const RT = {
  version: 'rule-terms/1', differs: ['dead_heat', 'postponement', 'cancellation', 'withdrawal', 'dns', 'disqualification', 'shortened', 'tie', 'unlisted_winner', 'source'],
  kalshi: { complete: true, terms: [
    { topic: 'dns', condition: 'withdraws_or_does_not_tee_off', treatment: 'no' }, { topic: 'postponement', condition: 'postponed', treatment: 'open_up_to_2_weeks' },
    { topic: 'cancellation', condition: 'cancelled_no_official_result', treatment: 'last_traded_price_or_fair' }, { topic: 'dead_heat', condition: 'multiple_winners', treatment: 'split_1_over_n' },
    { topic: 'withdrawal', condition: 'withdraws', treatment: 'no' }, { topic: 'shortened', condition: 'truncated_with_official_result', treatment: 'reported_result_stands' },
    { topic: 'disqualification', condition: 'dq_before_expiry', treatment: 'no' }, { topic: 'eliminated', condition: 'eliminated_from_contention', treatment: 'no' },
    { topic: 'source', condition: 'primary', treatment: 'league_ap_espn_wsj_fox' }] },
  polymarket: { complete: true, terms: [
    { topic: 'eliminated', condition: 'eliminated_from_contention', treatment: 'no' }, { topic: 'unlisted_winner', condition: 'unlisted_player_wins', treatment: 'other_bucket' },
    { topic: 'tie', condition: 'tie_after_regulation', treatment: 'official_winner_per_tour_rules' }, { topic: 'dead_heat', condition: 'multiple_winners', treatment: 'alphabetical_last_name_wins' },
    { topic: 'postponement', condition: 'no_winner_by_deadline', treatment: 'other_bucket' }, { topic: 'cancellation', condition: 'no_winner_by_deadline', treatment: 'other_bucket' },
    { topic: 'source', condition: 'primary', treatment: 'pga_tour' }] },
};
const golfer = (id, name, k, p) => ({ canonical_contract_id: `field_winner|golf:ED|team:${id}`, label: name, role: `p:${id}`, venues: [K(k)], related: [{ ...P(p), rule_terms: RT }] });
const EV = { canonical_event_id: 'ED', sport: 'golf', title: 'Baycurrent Classic', start_at: '2026-10-08T00:00:00Z', contracts: [golfer('a', 'Doug Ghim', 400, 220), golfer('b', 'Xander Schauffele', 880, 700), golfer('c', 'Ryan Gerard', 430, 240)] };

test('field event: RULE_MISMATCH, ordered by venue price, NO gap and NO cross on any golfer', () => {
  const e = normalizeEvent(EV);
  assert.equal(e.badge, 'RULE_MISMATCH');
  assert.deepEqual(e.field, { n: 3 });
  assert.deepEqual(e.contracts.map((c) => c.label), ['Xander Schauffele', 'Ryan Gerard', 'Doug Ghim']);
  assert.ok(e.contracts.every((c) => c.gap_pts === null && c.cross === null && !c.comparison));
  assert.equal(e.best_gap, null);
  assert.equal(e.three_way, null);
});

test('drawer key difference: dead heat stated plainly, only from parsed terms', () => {
  assert.deepEqual(keyDifferences(RT), ['Dead heat: Kalshi → $1 split across co-winners; Polymarket → alphabetically first last name wins, other co-winners No.']);
  assert.deepEqual(keyDifferences({ ...RT, kalshi: { complete: false, terms: [] } }), []);
});

test('every golf term renders (no "not confidently parsed" for the live vocabulary)', () => {
  const v = ruleTermsView(RT);
  assert.equal(v.kalshi.unknown, false);
  assert.equal(v.polymarket.unknown, false);
  for (const venue of ['kalshi', 'polymarket']) for (const t of RT[venue].terms) assert.ok(termLine(t, venue), `${venue} ${t.topic}`);
  assert.equal(termLine({ topic: 'dead_heat', condition: 'multiple_winners', treatment: 'split_1_over_n' }, 'kalshi'), 'Dead heat (co-winners declared) → $1 split equally across co-winners');
  assert.ok(v.polymarket.lines.some((l) => l.text === 'Withdraws → no clause stated'), 'Kalshi-only clauses are shown as not stated on Polymarket');
});
