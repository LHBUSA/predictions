// Top-of-book executable cross + rule-terms rendering (owner spec 2026-10-05).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContract, topOfBookCross, ruleTermsView, ruleTermsSummary, termLine, CROSS_TOOLTIP } from '../core.js';

const K = (bid, ask, extra = {}) => ({ venue: 'kalshi', match: 'EXACT_MATCH', bid_bp: bid, ask_bp: ask, mid_bp: (bid + ask) / 2, freshness: 'live', observed_at: '2026-10-05T22:00:00Z', ...extra });
const P = (bid, ask, extra = {}) => ({ venue: 'polymarket', match: 'COMPARABLE_EXCEPT_EXCEPTIONS', bid_bp: bid, ask_bp: ask, mid_bp: (bid + ask) / 2, freshness: 'live', observed_at: '2026-10-05T22:00:10Z', ...extra });
const CMP = (gap) => ({ venue_gap_pts: gap, match_class: 'COMPARABLE_EXCEPT_EXCEPTIONS', disclosure: 'Postponement/cancellation settlement rules differ between venues' });

test('cross = max(K bid − P ask, P bid − K ask); a 3¢ mid gap with no cross (real MIL @ OKC book shape)', () => {
  const c = normalizeContract({ label: 'OKC', venues: [K(6300, 6700), P(6100, 6300)], comparison: CMP(3) });
  assert.equal(c.gap_pts, 3);
  assert.equal(c.cross.state, 'NO_CROSS');
  assert.equal(c.cross.bp, 0);
  const pos = normalizeContract({ label: 'X', venues: [K(6400, 6500), P(6100, 6300)], comparison: CMP(2.5) });
  assert.deepEqual([pos.cross.state, pos.cross.bp, pos.cross.bid_venue, pos.cross.ask_venue], ['CROSS', 100, 'kalshi', 'polymarket']);
  const rev = topOfBookCross(K(5000, 5200), P(5300, 5400));
  assert.deepEqual([rev.state, rev.bp, rev.bid_venue], ['CROSS', 100, 'polymarket']);
  assert.equal(topOfBookCross(K(5000, null), P(5300, 5400)).state, 'NO_BOOK');
  assert.match(CROSS_TOOLTIP, /Before fees\. Available size not measured\./);
});

test('cross is computed ONLY for an approved, aligned COMPARABLE pair', () => {
  const mismatch = normalizeContract({ label: 'TB', venues: [K(1700, 1800)], related: [{ ...P(1800, 1900), match: 'RULE_MISMATCH', reasons: ['exceptions_differs'] }], comparison: null });
  assert.equal(mismatch.badge, 'RULE_MISMATCH');
  assert.equal(mismatch.cross, null, 'RULE_MISMATCH: no executable comparison');
  assert.equal(mismatch.gap_pts, null, 'RULE_MISMATCH: no shared spread');
  const notAligned = normalizeContract({ label: 'GS', venues: [K(5100, 5200), P(5100, 5300)], comparison: null });
  assert.equal(notAligned.note, 'NOT_ALIGNED');
  assert.equal(notAligned.cross, null);
  const single = normalizeContract({ label: 'A', venues: [K(5000, 5100)] });
  assert.equal(single.cross, null);
});

const RT_MLB = { version: 'rule-terms/1', differs: ['postponement', 'cancellation', 'tie'],
  kalshi: { complete: true, terms: [{ topic: 'postponement', condition: 'starts_within_48h', treatment: 'open_until_completed' }, { topic: 'cancellation', condition: 'cancelled_or_beyond_48h', treatment: 'fair_price' }] },
  polymarket: { complete: true, terms: [{ topic: 'postponement', condition: 'postponed', treatment: 'open_until_completed' }, { topic: 'tie', condition: null, treatment: 'split_50_50' }, { topic: 'cancellation', condition: 'no_makeup', treatment: 'split_50_50' }] } };

test('rule terms render only parsed facts; a topic only one venue states reads "no clause stated"', () => {
  const v = ruleTermsView(RT_MLB);
  assert.deepEqual(v.polymarket.lines.map((l) => l.text), ['Postponed → remains open until completed', 'Cancelled (no make-up game) → resolves 50-50', 'Tie → resolves 50-50']);
  assert.deepEqual(v.kalshi.lines.map((l) => l.text), ['Postponed (starts within 48h) → remains open, official final result', 'Cancelled (or moved beyond 48h) → resolves at a fair price', 'Tie → no clause stated']);
  assert.ok(v.kalshi.lines.every((l) => l.differs));
  assert.equal(ruleTermsSummary(RT_MLB), 'Postponed: Kalshi remains open, official final result · Polymarket remains open until completed | Cancelled: Kalshi resolves at a fair price · Polymarket resolves 50-50 | Tie: Kalshi no clause stated · Polymarket resolves 50-50');
  assert.equal(termLine({ topic: 'tie', condition: null, treatment: 'split_50_50' }, 'kalshi'), 'Tie → $0.50 each');
});

test('incomplete parse = "not confidently parsed", no "no clause" claims; unknown vocabulary never rendered', () => {
  const v = ruleTermsView({ version: 'rule-terms/1', differs: null, kalshi: { complete: true, terms: [{ topic: 'walkover', condition: 'or_cancelled_before_start', treatment: 'fair_price' }] }, polymarket: { complete: false, terms: [{ topic: 'tie', condition: null, treatment: 'split_50_50' }, { topic: 'teleport', condition: 'x', treatment: 'y' }] } });
  assert.equal(v.polymarket.unknown, true);
  assert.ok(!v.polymarket.lines.some((l) => /no clause/.test(l.text)), 'an incomplete venue never claims a missing clause');
  assert.ok(!JSON.stringify(v).includes('teleport'));
  assert.ok(v.kalshi.lines.some((l) => l.text === 'Tie → no clause stated'));
});

test('compatible when the desk has no rule_terms (older Worker): no terms, no crash', () => {
  const c = normalizeContract({ label: 'X', venues: [K(5000, 5100)], related: [{ ...P(5000, 5200), match: 'RULE_MISMATCH' }] });
  assert.equal(c.rule_terms, null);
  assert.equal(ruleTermsView(c.rule_terms), null);
  assert.equal(ruleTermsSummary(null), null);
  const wrongVersion = normalizeContract({ label: 'X', venues: [K(5000, 5100)], related: [{ ...P(5000, 5200), match: 'RULE_MISMATCH', rule_terms: { version: 'rule-terms/9' } }] });
  assert.equal(wrongVersion.rule_terms, null, 'unknown contract versions are ignored');
});
