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

test('key difference: "Cancelled: Polymarket → Draw; Kalshi → fair price." only when both terms are parsed', async () => {
  const { keyDifferences } = await import('../core.js');
  const rt = { version: 'rule-terms/1', differs: ['cancellation'], kalshi: { complete: true, terms: [{ topic: 'cancellation', condition: 'cancelled_or_beyond_48h', treatment: 'fair_price' }] }, polymarket: { complete: true, terms: [{ topic: 'cancellation', condition: 'no_makeup', treatment: 'settles_as_draw' }] } };
  assert.deepEqual(keyDifferences(rt), ['Cancelled: Polymarket → Draw; Kalshi → fair price.']);
  assert.deepEqual(keyDifferences({ ...rt, kalshi: { complete: false, terms: [] } }), [], 'never inferred');
  assert.deepEqual(keyDifferences(null), []);
});

// LIVE MARKET CARD (2026-10-10, owner P1): proCard() took e.contracts.slice(0, 2) as the two teams, so a desk that
// lists the draw first (or any order) showed "Draw" as a club and dropped one side. Teams = canonical HOME/AWAY roles.
import { cardModel, soccerSettlement, SOCCER_SETTLEMENT } from '../core.js';
import { readFileSync } from 'node:fs';
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

test('card model: every contract order -> HOME/AWAY sides by role, DRAW only as the third row', () => {
  for (const order of perms([0, 1, 2])) {
    const e = normalizeEvent({ ...EV, contracts: order.map((i) => EV.contracts[i]) });
    const m = cardModel(e);
    assert.deepEqual(m.teams.map((c) => c.role), ['home', 'away'], `order ${order}`);
    assert.deepEqual(m.rows.map((c) => c.role), ['home', 'draw', 'away'], `order ${order}`);
    assert.equal(m.threeWay, true);
    assert.deepEqual(m.teams.map((c) => c.label), ['Arsenal', 'Leeds']);
  }
});

test('card model: no verified roles -> no guessed sides (title only); other sports keep their two-way card', () => {
  const unroled = normalizeEvent({ ...EV, contracts: EV.contracts.map(({ role, ...c }) => c) });
  assert.deepEqual(cardModel(unroled).teams, []);
  const nhl = { sport: 'nhl', contracts: [{ label: 'BOS', role: 'away' }, { label: 'MIN', role: 'home' }] };
  assert.deepEqual(cardModel(nhl), { teams: nhl.contracts, rows: nhl.contracts, threeWay: false });
  const two = normalizeEvent({ ...EV, contracts: [EV.contracts[0], EV.contracts[2]] }); // no draw contract listed
  assert.deepEqual(cardModel(two).rows.map((c) => c.role), ['home', 'away']);
  assert.equal(cardModel(two).threeWay, false);
});

test('settlement line: 90 minutes + stoppage for both venues, related Polymarket quotes flagged', () => {
  const s = soccerSettlement(normalizeEvent(EV));
  assert.equal(s.short, '90 MIN + STOPPAGE · NO ET/PENS · * POLY RULES DIFFER');
  assert.ok(s.full.startsWith(SOCCER_SETTLEMENT));
  const exact = soccerSettlement(normalizeEvent({ ...EV, contracts: EV.contracts.map((c) => ({ ...c, related: [] })) }));
  assert.equal(exact.short, '90 MIN + STOPPAGE · NO ET/PENS');
});

test('live score + crest per side come from the role, so a reordered desk still pairs Leeds with the away score', () => {
  const e = normalizeEvent({ ...EV, contracts: [EV.contracts[2], EV.contracts[1], EV.contracts[0]] });
  const score = { away: { name: 'Leeds United', abbr: 'LEE', score: 1, logo: 'https://soccer.propbetedge.ai/api/soccer/media/lee' }, home: { name: 'Arsenal', abbr: 'ARS', score: 2, logo: null } };
  const side = (c) => score[c.role];
  const [home, away] = cardModel(e).teams;
  assert.equal(side(home).score, 2); assert.equal(side(away).score, 1);
  assert.equal(participantMedia('soccer', away, side(away)).src, 'https://soccer.propbetedge.ai/api/soccer/media/lee');
  assert.equal(participantMedia('soccer', home, side(home)).src, null, 'incomplete crest data -> initials, never another club\'s crest');
  assert.equal(participantMedia('soccer', home, side(home)).initials, 'A');
});

test('markup: proCard renders from cardModel (no positional slice), DRAW row + settlement line present', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('function proCard('), app.indexOf('function plainLiveCard('));
  assert.doesNotMatch(body, /contracts\.slice\(0, 2\)/);
  assert.match(body, /const model = cardModel\(e\)/);
  assert.match(body, /c\.role === 'draw' \? 'DRAW'/);
  assert.match(body, /class="pro-disc"/);
});
