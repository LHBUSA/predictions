// Compare core: joins, badges, ranking, movement, states. Fixtures = real production payloads captured
// 2026-10-05 ~20:15-21:00Z (propsports-markets desk; score board from the Members adapters at 59de9d2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeContract, normalizeEvent, rankEvents, scoreIndex, joinScore, moveOver, moves, fmtMove,
  membershipState, screenNotices, boardEmpty, VIEWS, ID_JOIN_SPORTS
} from '../core.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const withSport = (d, sport) => d.events.map((e) => ({ ...e, sport: e.sport || sport, lane: sport }));
const live = fx('live-board.json');
const idx = scoreIndex(live.items);

test('join: ID-only — the MLB NYY @ TB title collision never attaches the wrong game', () => {
  const mlb = withSport(fx('desk-mlb.json'), 'mlb');
  const e849835 = mlb.find((e) => e.canonical_event_id === '849835');
  assert.ok(e849835, 'fixture holds desk event 849835 (NYY @ TB, Oct 3)');
  const scoreTitles = live.items.filter((i) => i.sport === 'mlb' && i.title === e849835.title);
  assert.ok(scoreTitles.some((i) => i.source_id === '849839'), 'score feed has a different NYY @ TB game (849839)');
  const j = joinScore(e849835, idx);
  assert.equal(j.state, 'NO_SCORE');
  assert.equal(j.score, null, 'the old title fallback attached 849839 here; ID-only must not');
});

test('join: NBA/NFL link by exact provider id', () => {
  const nba = withSport(fx('desk-nba.json'), 'nba');
  const linked = nba.map((e) => joinScore(e, idx)).filter((j) => j.state === 'LINKED');
  assert.ok(linked.length >= 1);
  for (const j of linked) assert.ok(nba.some((e) => e.canonical_event_id === j.score.source_id));
  const nfl = withSport(fx('desk-nfl.json'), 'nfl');
  const j = joinScore(nfl.find((e) => e.canonical_event_id === '401872965'), idx);
  assert.equal(j.state, 'LINKED');
  assert.equal(j.score.source_id, '401872965');
  assert.equal(joinScore(nfl.find((e) => e.canonical_event_id === '401872980'), idx).state, 'NO_SCORE', 'not on this date\'s score board: no score, no guess');
});

test('join: UFC is UNMATCHED (bouts vs cards), never joined', () => {
  const ufc = withSport(fx('desk-ufc.json'), 'ufc');
  const fake = scoreIndex([{ sport: 'ufc', source_id: ufc[0].canonical_event_id, status: 'live', title: ufc[0].title }]);
  const j = joinScore(ufc[0], fake);
  assert.equal(j.state, 'UNMATCHED', 'even an accidental id equality is not trusted for UFC');
  assert.deepEqual([...ID_JOIN_SPORTS].sort(), ['mlb', 'nba', 'nfl', 'nhl', 'soccer'], 'soccer added 2026-10-05: market and score feed share the soccer-api match UUID (test/soccer.test.js)');
});

test('badges from real payloads: NBA COMPARABLE, NFL future RULE_MISMATCH, NFL past WITHDRAWN', () => {
  const nba = withSport(fx('desk-nba.json'), 'nba');
  const cmp = nba.flatMap((e) => e.contracts).map(normalizeContract).filter((c) => c.comparison);
  assert.ok(cmp.length > 0);
  for (const c of cmp) {
    assert.equal(c.badge, 'COMPARABLE');
    assert.equal(c.gap_pts, c.comparison.venue_gap_pts);
    assert.equal(c.kalshi.no_bp, 10000 - c.kalshi.yes_bp, 'NO = 100¢ − YES');
  }
  const nfl = withSport(fx('desk-nfl.json'), 'nfl');
  const past = normalizeEvent(nfl.find((e) => e.canonical_event_id === '401872965'), idx);
  assert.equal(past.badge, 'WITHDRAWN');
  assert.equal(past.tier, 3);
  assert.equal(past.active, false);
  const fut = normalizeEvent(nfl.find((e) => e.canonical_event_id === '401872980'), idx);
  assert.equal(fut.badge, 'RULE_MISMATCH');
  assert.equal(fut.best_gap, null, 'RULE_MISMATCH is never given a spread');
  assert.ok(fut.contracts.every((c) => c.gap_pts === null));
});

test('PBE: only when a probability exists', () => {
  const c = normalizeContract({ label: 'X', venues: [], pbe: null });
  assert.equal(c.pbe, null);
  const p = normalizeContract({ label: 'X', venues: [], pbe: { probability: 0.6895, state: 'FROZEN_AT_LOCK', issued_at: '2026-10-04T17:45:32Z' } });
  assert.equal(p.pbe.probability, 0.6895);
});

test('ranking: valid spreads first (largest), then aligned zero, then single/mismatch, stale/final last', () => {
  const mk = (id, venues, extra = {}) => ({ canonical_event_id: id, sport: 'nba', title: id, contracts: [{ canonical_contract_id: id, label: 'A', venues, related: extra.related || [], comparison: extra.cmp || null }] });
  const k = (mid, f = 'live') => ({ venue: 'kalshi', match: 'EXACT_MATCH', mid_bp: mid, freshness: f, observed_at: '2026-10-05T20:00:00Z' });
  const p = (mid, f = 'live') => ({ venue: 'polymarket', match: 'COMPARABLE_EXCEPT_EXCEPTIONS', mid_bp: mid, freshness: f, observed_at: '2026-10-05T20:00:00Z' });
  const evs = [
    mk('single', [k(5000)]),
    mk('gap1', [k(5000), p(5100)], { cmp: { venue_gap_pts: 1, match_class: 'COMPARABLE_EXCEPT_EXCEPTIONS' } }),
    mk('stale', [k(5000, 'stale')]),
    mk('gap4', [k(5000), p(5400)], { cmp: { venue_gap_pts: 4, match_class: 'COMPARABLE_EXCEPT_EXCEPTIONS' } }),
    mk('gap0', [k(5000), p(5000)], { cmp: { venue_gap_pts: 0, match_class: 'EXACT_MATCH' } })
  ].map((e) => normalizeEvent(e));
  assert.deepEqual(rankEvents(evs).map((e) => e.canonical_event_id), ['gap4', 'gap1', 'gap0', 'single', 'stale']);
  const fin = normalizeEvent(mk('final', [k(5000), p(5600)], { cmp: { venue_gap_pts: 6 } }), scoreIndex([{ sport: 'nba', source_id: 'final', status: 'final' }]));
  assert.equal(fin.tier, 3, 'a final game is demoted even with a big gap');
});

test('movement: stored points only; insufficient coverage is null, never 0', () => {
  const now = Date.parse('2026-10-05T21:00:00Z');
  const pts = [{ t: '2026-10-05T20:30:00Z', v: 5000 }, { t: '2026-10-05T20:58:00Z', v: 5420 }];
  assert.equal(moveOver(pts, 60e3, now).delta_bp, 0, '1m: last stored value held (no change row in window)');
  assert.equal(moveOver(pts, 5 * 60e3, now).delta_bp, 420);
  assert.equal(moveOver(pts, 15 * 60e3, now).delta_bp, 420);
  assert.equal(moveOver(pts, 3600e3, now), null, 'no observation at or before 60m ago');
  assert.equal(fmtMove(null), 'Not enough observations');
  assert.equal(moves([], now)['24h'], null);
});

test('movement from the real NBA event (Kalshi change rows + Polymarket desk points)', () => {
  const intel = fx('intel-nba-401898388.json');
  const pts = intel.event.movement.kalshi.away.points.filter((p) => p.mid_bp != null).map((p) => ({ t: p.t, v: p.mid_bp }));
  const at = Date.parse(intel.generated_at);
  const m = moves(pts, at);
  assert.ok(m['24h'] && Number.isFinite(m['24h'].delta_bp));
  assert.equal(m['24h'].to_v, pts.at(-1).v);
});

test('membership states: 401 anonymous, 403 forbidden, 503 unverified, owner/all_access entitled', () => {
  assert.equal(membershipState(401, null), 'anonymous');
  assert.equal(membershipState(403, null), 'forbidden');
  assert.equal(membershipState(503, null), 'unverified');
  assert.equal(membershipState(0, null), 'network_error');
  assert.equal(membershipState(200, { membership: { state: 'all_access', entitled: true } }), 'entitled');
  assert.equal(membershipState(200, { membership: { state: 'owner', entitled: true } }), 'entitled');
  assert.equal(membershipState(200, { membership: { state: 'signed_in', entitled: false } }), 'forbidden');
  assert.equal(membershipState(200, { membership: { state: 'anonymous', entitled: false } }), 'anonymous');
});

test('notices: upstream failure is never an empty board', () => {
  const desk = { page_limit: 50, lanes: [{ lane: 'nba', state: 'unavailable', upstream_status: 502 }, { lane: 'soccer', state: 'not_connected', upstream_status: 404 }, { lane: 'nhl', state: 'ok', events: 50, capped: true }], events: [] };
  const n = screenNotices({ desk, deskStatus: 200, live: { sources: [{ key: 'nhl', state: 'unavailable', error: 'HTTP_403' }, { key: 'nba', state: 'ok', fetched_at: '2026-10-05T20:00:00Z' }] }, liveStatus: 200, scope: 'soccer', events: [], now: Date.parse('2026-10-05T20:10:00Z') });
  const codes = n.map((x) => x.code);
  assert.ok(codes.includes('lane_unavailable'));
  assert.ok(codes.includes('lane_not_connected'));
  assert.ok(codes.includes('lane_capped'), 'single-sport scope explains the cap (ALL SPORTS shows it as "50+" on the lane chip)');
  assert.ok(codes.includes('score_source_down'));
  assert.ok(codes.includes('score_delayed'), '10-minute-old score feed is delayed');
  assert.equal(screenNotices({ desk: null, deskStatus: 401, scope: 'sports' })[0].code, 'auth_expired');
  assert.equal(screenNotices({ desk: null, deskStatus: 503, scope: 'sports' })[0].code, 'access_check');
  assert.ok(screenNotices({ desk: null, deskStatus: 200, liveStatus: 502, scope: 'nba' }).some((x) => x.code === 'score_feed_down'));
});

test('board empty: only when every lane answered; not_connected is its own state', () => {
  const fail = boardEmpty({ desk: { lanes: [{ lane: 'nba', state: 'unavailable' }] }, viewKey: 'top', events: [] });
  assert.equal(fail.code, 'upstream_error', 'failure is not "empty"');
  assert.equal(fail.failure, true);
  const single = screenNotices({ desk: { lanes: [{ lane: 'nhl', state: 'ok' }] }, deskStatus: 200, scope: 'nhl', events: [{ badge: 'SINGLE_VENUE' }], live: { items: [{ status: 'live' }, { status: 'live' }, { status: 'live' }] }, liveStatus: 200 });
  assert.match(single.find((x) => x.code === 'no_comparable').text, /^3 games are live, but no market/);
  assert.equal(boardEmpty({ desk: { lanes: [{ lane: 'golf', state: 'not_connected' }] }, viewKey: 'top', events: [] }).code, 'not_connected');
  assert.equal(boardEmpty({ desk: { lanes: [{ lane: 'nba', state: 'ok' }] }, viewKey: 'live', events: [], liveItems: [{ status: 'live' }, { status: 'live' }] }).code, 'no_live');
  assert.equal(boardEmpty({ desk: { lanes: [{ lane: 'nba', state: 'ok' }] }, viewKey: 'top', events: [] }).code, 'no_active');
});

test('default view is TOP SPREADS over active events (not LIVE NOW)', () => {
  const nba = withSport(fx('desk-nba.json'), 'nba').map((e) => normalizeEvent(e, idx));
  const top = rankEvents(nba).filter(VIEWS.top.filter);
  assert.ok(top.length > 0, 'real NBA desk yields an active board with nothing live');
  assert.ok(top.every((e) => e.active));
});
