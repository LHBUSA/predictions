// Soccer 3-way in Compare: ID-only score join, crest/draw media, book sums, never a shared spread for RULE_MISMATCH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, scoreIndex, joinScore, participantMedia, bookSums, ID_JOIN_SPORTS, termLine, ruleTermsView } from '../core.js';
import { enrichSoccer, crestUrl, __crestCache } from '../api/_lib/media.js';

const MATCH = 'dd8264d9-a90f-54bd-8da8-da17d6d41ef7', ARS = 'be541ba0-e56b-559c-9dbe-f6275f643f84', LEE = '747cff94-7740-5399-826a-7c1c15e9d81f';
const K = (mid) => ({ venue: 'kalshi', match: 'EXACT_MATCH', mid_bp: mid, bid_bp: mid - 50, ask_bp: mid + 50, freshness: 'live', observed_at: '2026-10-08T12:00:00Z' });
const P = (mid) => ({ venue: 'polymarket', match: 'RULE_MISMATCH', mid_bp: mid, bid_bp: mid - 50, ask_bp: mid + 50, freshness: 'live', observed_at: '2026-10-08T12:00:10Z', reasons: ['exceptions_differs'] });
const EV = { canonical_event_id: MATCH, sport: 'soccer', title: 'Arsenal vs Leeds United', start_at: '2026-10-10T11:30:00+00:00', contracts: [
  { canonical_contract_id: `soccer_result_90|soccer:${MATCH}|team:${ARS}`, label: 'Arsenal', role: 'home', venues: [K(7050)], related: [P(7150)] },
  { canonical_contract_id: `soccer_result_90|soccer:${MATCH}|draw`, label: 'Draw', role: 'draw', venues: [K(1750)], related: [P(1850)] },
  { canonical_contract_id: `soccer_result_90|soccer:${MATCH}|team:${LEE}`, label: 'Leeds', role: 'away', venues: [K(1150)], related: [P(1050)] }] };

test('one 3-way event: three ordered outcomes, RULE_MISMATCH, no shared spread or cross', () => {
  const e = normalizeEvent(EV);
  assert.deepEqual(e.contracts.map((c) => c.role), ['home', 'draw', 'away']);
  assert.equal(e.badge, 'RULE_MISMATCH');
  assert.ok(e.contracts.every((c) => c.gap_pts === null && c.cross === null));
  assert.deepEqual(e.three_way.book, { kalshi: { sum_bp: 9950, mids_bp: [7050, 1750, 1150] }, polymarket: { sum_bp: 10050, mids_bp: [7150, 1850, 1050] } });
});

test('book sum only when all three outcomes are priced on that venue', () => {
  const e = normalizeEvent({ ...EV, contracts: EV.contracts.map((c, i) => (i === 1 ? { ...c, related: [] } : c)) });
  assert.equal(e.three_way.book.polymarket, null);
  assert.equal(e.three_way.book.kalshi.sum_bp, 9950);
});

test('soccer score join is ID-only (soccer-api match UUID); a same-title match on another id never attaches', () => {
  assert.ok(ID_JOIN_SPORTS.has('soccer'));
  const idx = scoreIndex([{ sport: 'soccer', source_id: MATCH, status: 'live', title: 'Arsenal vs Leeds United' }, { sport: 'soccer', source_id: 'other-id', status: 'live', title: 'Arsenal vs Leeds United' }]);
  assert.equal(joinScore(EV, idx).score.source_id, MATCH);
  assert.equal(joinScore({ ...EV, canonical_event_id: 'not-in-feed' }, idx).state, 'NO_SCORE');
});

test('media: crest from server enrichment or the linked score feed; the draw gets a neutral marker, never an image', () => {
  const home = normalizeEvent(EV).contracts[0];
  assert.equal(participantMedia('soccer', home).src, null);
  assert.equal(participantMedia('soccer', { ...home, media: { logo: 'https://soccer.propbetedge.ai/api/soccer/media/ab' } }).src, 'https://soccer.propbetedge.ai/api/soccer/media/ab');
  assert.equal(participantMedia('soccer', home, { logo: 'https://x/l.png' }).src, 'https://x/l.png');
  assert.deepEqual(participantMedia('soccer', { role: 'draw', label: 'Draw' }), { kind: 'draw', src: null, initials: '=', alt: 'Draw' });
});

test('crest enrichment: by canonical match id, team id must equal the contract team, cached; unsafe paths refused', async () => {
  __crestCache.clear();
  assert.equal(crestUrl('/api/soccer/media/92f1bb35662ff56dde09e1f8084221a4'), 'https://soccer.propbetedge.ai/api/soccer/media/92f1bb35662ff56dde09e1f8084221a4');
  assert.equal(crestUrl('https://evil.example/x.png'), null);
  assert.equal(crestUrl('/api/soccer/media/../../x'), null);
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ data: { home: { id: ARS, crest: { url: '/api/soccer/media/aaaaaaaaaaaaaaaa' } }, away: { id: 'someone-else', crest: { url: '/api/soccer/media/bbbbbbbbbbbbbbbb' } } } }), { status: 200 }); };
  const evs = [JSON.parse(JSON.stringify(EV))];
  assert.equal(await enrichSoccer(evs, { fetchImpl }), 1);
  assert.equal(evs[0].contracts[0].media.logo, 'https://soccer.propbetedge.ai/api/soccer/media/aaaaaaaaaaaaaaaa');
  assert.equal(evs[0].contracts[2].media, undefined, 'crest team id disagrees with the contract team -> no image');
  assert.equal(evs[0].contracts[1].media, undefined, 'draw: no image');
  await enrichSoccer([JSON.parse(JSON.stringify(EV))], { fetchImpl });
  assert.equal(calls, 1, 'cached');
});

test('soccer settlement vocabulary renders as plain facts', () => {
  assert.equal(termLine({ topic: 'cancellation', condition: 'no_makeup', treatment: 'settles_as_draw' }, 'polymarket'), 'Cancelled (no make-up game) → settles as a draw (team markets No, draw Yes)');
  assert.equal(termLine({ topic: 'postponement', condition: 'rescheduled_beyond_48h', treatment: 'fair_price' }, 'kalshi'), 'Postponed (rescheduled more than 48h away) → resolves at a fair price');
  const v = ruleTermsView({ version: 'rule-terms/1', differs: ['postponement'], kalshi: { complete: true, terms: [{ topic: 'postponement', condition: 'rescheduled_beyond_48h', treatment: 'fair_price' }] }, polymarket: { complete: true, terms: [{ topic: 'postponement', condition: 'postponed', treatment: 'open_until_completed' }] } });
  assert.ok(!v.kalshi.lines.some((l) => /no clause/.test(l.text)), 'a two-topic clause is never reported as a missing postponement rule');
});
