// Live score card -> market state (2026-10-06 regression). Production showed UTA@NJD, MIN@BUF, BKN@CHA, NYI@NYR and
// STL@CHI as "NO MARKETS" while both venues listed them. The id join was correct; the rail labelled every live game
// that was not on the loaded board (desk still loading, lane timed out, lane cut at the 50-event cap, or linked but
// momentarily unpriced) as "NO MARKETS". NONE now requires a positive check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveMarketStates, matchupCandidates, matchupKey, matchupSides, teamCode, normalizeEvent, scoreIndex, LIVE_MARKET, LIVE_MARKET_CHIP } from '../core.js';
import { laneUrl, parseTargetedIds, targetedResult, TARGETED_MAX_EVENTS } from '../api/_lib/desk.js';

const real = JSON.parse(readFileSync(new URL('./fixtures/live-markets-2026-10-06.json', import.meta.url), 'utf8'));
const okLanes = (extra = {}) => [{ lane: 'nhl', state: 'ok', events: 50, capped: true, ...extra.nhl }, { lane: 'nba', state: 'ok', events: 40, capped: false, ...extra.nba }];
const norm = (events, items = real.items) => events.map((e) => normalizeEvent(e, scoreIndex(items)));
const byId = (states) => Object.fromEntries(states.map((s) => [s.source_id, s]));
const SCREENSHOT = ['2026020047', '2026020049', '401901820', '2026020048', '2026020050']; // UTA@NJD MIN@BUF BKN@CHA NYI@NYR STL@CHI

test('real 2026-10-06 slate: every live game links by id and reports its markets (screenshot games included)', () => {
  assert.equal(real.items.length, 9);
  const states = byId(liveMarketStates(real.items, { events: norm(real.events), lanes: okLanes(), rawEvents: real.events }));
  for (const id of SCREENSHOT) {
    assert.equal(states[id].state, LIVE_MARKET.MARKETS, id);
    assert.ok(states[id].market_count >= 2, id);
    assert.deepEqual(states[id].venues.sort(), ['kalshi', 'polymarket'], id);
  }
  assert.equal(Object.values(states).filter((s) => s.state !== LIVE_MARKET.MARKETS).length, 0);
  assert.equal(states['2026020047'].matchup_key, 'nhl|UTA@NJD|2026-10-06');
  assert.equal(states['401901820'].matchup_key, 'nba|BKN@CHA|2026-10-06');
});

test('the old failure modes never say NO MARKETS', () => {
  // desk still loading (live scores arrived first)
  for (const s of liveMarketStates(real.items, { events: [], lanes: null })) assert.equal(s.state, LIVE_MARKET.CHECKING);
  // lane timed out
  for (const s of liveMarketStates(real.items, { events: [], lanes: okLanes({ nhl: { state: 'unavailable', events: 0, capped: false }, nba: { state: 'unavailable', events: 0 } }) }))
    assert.equal(s.state, LIVE_MARKET.UNAVAILABLE);
  // lane ok but capped at 50 and the live game was cut: checking until the targeted read answers
  const nhl = real.items.filter((x) => x.sport === 'nhl');
  for (const s of liveMarketStates(nhl, { events: [], lanes: okLanes() })) assert.equal(s.state, LIVE_MARKET.CHECKING);
  // targeted read failed
  const failed = new Map(nhl.map((x) => [`nhl:${x.source_id}`, { state: 'unavailable' }]));
  for (const s of liveMarketStates(nhl, { events: [], lanes: okLanes(), targeted: failed })) assert.equal(s.state, LIVE_MARKET.UNAVAILABLE);
  // linked but every quote momentarily unpriced: still MARKETS (the card says the price is unavailable)
  const unpriced = real.events.filter((e) => e.canonical_event_id === '2026020047').map((e) => ({ ...e, contracts: e.contracts.map((c) => ({ ...c, venues: c.venues.map((v) => ({ ...v, mid_bp: null })) })) }));
  const st = liveMarketStates(nhl.filter((x) => x.source_id === '2026020047'), { events: norm(unpriced), lanes: okLanes() })[0];
  assert.equal(st.state, LIVE_MARKET.MARKETS);
  assert.equal(st.priced, false);
});

test('NO MARKETS still works after a positive check', () => {
  const item = { sport: 'nhl', source_id: '2026029999', title: 'SEA @ VAN', status: 'live', score: { away: { abbr: 'SEA' }, home: { abbr: 'VAN' } } };
  const viaTargeted = liveMarketStates([item], { events: [], lanes: okLanes(), targeted: new Map([['nhl:2026029999', { state: 'missing' }]]), rawEvents: real.events })[0];
  assert.equal(viaTargeted.state, LIVE_MARKET.NONE);
  assert.equal(viaTargeted.reason, 'targeted_read_empty');
  assert.equal(LIVE_MARKET_CHIP[viaTargeted.state], 'NO MARKETS');
  const nba = { ...item, sport: 'nba', source_id: '401999999', title: 'SAC @ POR', score: { away: { abbr: 'SAC' }, home: { abbr: 'POR' } } };
  const viaCompleteLane = liveMarketStates([nba], { events: [], lanes: okLanes(), rawEvents: real.events })[0];
  assert.equal(viaCompleteLane.state, LIVE_MARKET.NONE, 'uncapped ok lane = whole inventory checked');
  const notConnected = liveMarketStates([{ ...item, sport: 'wnba', source_id: '1' }], { events: [], lanes: [{ lane: 'wnba', state: 'not_connected', events: 0 }] })[0];
  assert.equal(notConnected.state, LIVE_MARKET.NONE);
});

test('same matchup under another id = market_match_failed (never NONE); aliases, swapped sides, UTC midnight', () => {
  const desk = real.events.find((e) => e.canonical_event_id === '401901820'); // BKN @ CHA, 23:00Z
  const brooklyn = { sport: 'nba', source_id: '999', title: 'BRK @ CHA', status: 'live', starts_at: '2026-10-06T23:00:00Z', score: { away: { abbr: 'BRK' }, home: { abbr: 'CHA' } } };
  const st = liveMarketStates([brooklyn], { events: [], lanes: okLanes(), targeted: new Map([['nba:999', { state: 'missing' }]]), rawEvents: [desk] })[0];
  assert.equal(st.state, LIVE_MARKET.MATCH_FAILED);
  assert.equal(st.candidates[0].canonical_event_id, '401901820');
  assert.equal(st.candidates[0].swapped, false);
  // swapped home/away formatting ("HOME vs AWAY" or a source that lists the teams the other way round)
  const swapped = { ...brooklyn, title: 'BKN vs CHA', score: { away: { abbr: 'CHA' }, home: { abbr: 'BKN' } } };
  const sw = matchupCandidates(swapped, [desk]);
  assert.equal(sw.length, 1);
  assert.equal(sw[0].swapped, true);
  // a different night's game between the same teams is not a candidate
  assert.equal(matchupCandidates({ ...brooklyn, starts_at: '2026-10-09T23:00:00Z' }, [desk]).length, 0);
  // aliases
  assert.equal(teamCode('nhl', 'NJ'), 'NJD');
  assert.equal(teamCode('nhl', 'utah'), 'UTA');
  assert.equal(teamCode('nba', 'BRK'), 'BKN');
  assert.equal(teamCode('nba', 'UTAH'), 'UTA');
  assert.deepEqual(matchupSides('nhl', { title: 'NYI @ NYR' }), { away: 'NYI', home: 'NYR' });
  assert.deepEqual(matchupSides('nhl', { title: 'NJ at TB' }), { away: 'NJD', home: 'TBL' });
  // 8:00 pm ET puck drop = 00:00Z next day: same slate key as a 7:00 pm ET game
  assert.equal(matchupKey('nhl', { away: 'STL', home: 'CHI' }, '2026-10-07T00:00:00+00:00'), 'nhl|STL@CHI|2026-10-06');
  assert.equal(matchupKey('nhl', { away: 'UTA', home: 'NJD' }, '2026-10-06T23:00:00+00:00'), 'nhl|UTA@NJD|2026-10-06');
  assert.equal(matchupKey('nba', { away: 'LAL', home: 'POR' }, '2026-10-07T05:30:00Z'), 'nba|LAL@POR|2026-10-06', '10:30 pm PT tip');
});

test('venue mixes: Kalshi-only, Polymarket-only, both, rules differ, comparable all count as markets', () => {
  const base = real.events.find((e) => e.canonical_event_id === '2026020049');
  const item = real.items.find((x) => x.source_id === '2026020049');
  const only = (venue) => ({ ...base, contracts: base.contracts.map((c) => ({ ...c, comparison: null, venues: c.venues.filter((v) => v.venue === venue) })) });
  const run = (ev) => liveMarketStates([item], { events: norm([ev]), lanes: okLanes() })[0];
  assert.deepEqual(run(only('kalshi')).venues, ['kalshi']);
  assert.deepEqual(run(only('polymarket')).venues, ['polymarket']);
  const both = run(base);
  assert.deepEqual(both.venues.sort(), ['kalshi', 'polymarket']);
  assert.equal(both.event.badge, 'COMPARABLE');
  const mismatch = { ...base, contracts: base.contracts.map((c) => ({ ...c, comparison: null, venues: c.venues.filter((v) => v.venue === 'kalshi'), related: c.venues.filter((v) => v.venue === 'polymarket').map((v) => ({ ...v, match: 'RULE_MISMATCH' })) })) };
  const rd = run(mismatch);
  assert.equal(rd.state, LIVE_MARKET.MARKETS);
  assert.deepEqual(rd.venues.sort(), ['kalshi', 'polymarket']);
  assert.equal(rd.event.badge, 'RULE_MISMATCH');
  assert.equal(rd.event.best_gap, null, 'rules differ never shows a gap');
});

test('UFC: live card vs bout markets is not id-linkable; never NO MARKETS while the lane lists bouts', () => {
  const card = { sport: 'ufc', source_id: 'ufc-card-1', title: 'UFC Fight Night', status: 'live' };
  assert.equal(liveMarketStates([card], { lanes: [{ lane: 'ufc', state: 'ok', events: 29, capped: false }] })[0].state, LIVE_MARKET.NOT_LINKED);
  assert.equal(liveMarketStates([card], { lanes: [{ lane: 'ufc', state: 'ok', events: 0, capped: false }] })[0].state, LIVE_MARKET.NONE);
  assert.equal(liveMarketStates([card], { lanes: [{ lane: 'ufc', state: 'unavailable', events: 0 }] })[0].state, LIVE_MARKET.UNAVAILABLE);
});

test('server: targeted desk read by id; 200-without-id = missing, failure = unavailable (never missing)', () => {
  assert.match(laneUrl('nhl', { events: ['2026020047', '2026020049'] }), /sport=nhl&events=2026020047%2C2026020049$/);
  assert.deepEqual(parseTargetedIds('2026020047, 2026020047,401901820'), ['2026020047', '401901820']);
  assert.equal(parseTargetedIds(''), null);
  assert.equal(parseTargetedIds('a b'), null);
  assert.equal(parseTargetedIds(Array.from({ length: TARGETED_MAX_EVENTS + 1 }, (_, i) => `id${i}`).join(',')), null);
  const nhl = real.events.filter((e) => e.sport === 'nhl');
  const ok = targetedResult('nhl', ['2026020047', '2026020999'], { ok: true, status: 200, body: { events: nhl }, ms: 40 });
  assert.equal(ok.state, 'ok');
  assert.deepEqual(ok.found, ['2026020047']);
  assert.deepEqual(ok.missing, ['2026020999']);
  assert.equal(ok.events.length, 1, 'only requested ids come back');
  const down = targetedResult('nhl', ['2026020047'], { ok: false, status: 0, body: null, error: 'timeout', ms: 8000 });
  assert.equal(down.state, 'unavailable');
  assert.deepEqual(down.missing, []);
  assert.deepEqual(down.unavailable, ['2026020047']);
});
