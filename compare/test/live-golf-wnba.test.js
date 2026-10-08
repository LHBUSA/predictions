// LIVE NOW rail regressions (2026-10-07 production screenshot): live Golf was SCORE-ONLY with no board and the UFC
// "BOUT MARKETS IN UFC HUB" chip; WNBA Liberty @ Dream had no team marks and no market. Fixtures are the real payloads
// captured that night: golf /api/v1/live?top=100 (Baycurrent Classic only), propsports-markets golf desk for the
// edition UUID (71 field_winner contracts, Kalshi exact + Polymarket RULE_MISMATCH), WNBA schedule 2026-10-07.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBoard } from '../api/_lib/scores/adapters.js';
import {
  normalizeEvent, scoreIndex, joinScore, liveMarketStates, liveMarketChip, LIVE_MARKET, scoreKey, golfBoardRows, golfToPar, golfThru,
  participantMedia, ID_JOIN_SPORTS
} from '../core.js';
import { TARGETED_SPORTS } from '../api/_lib/desk.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const GOLF_LIVE = fx('golf-live-baycurrent-2026-10-07.json');
const GOLF_DESK = fx('desk-golf-baycurrent-2026-10-07.json');
const WNBA = fx('wnba-schedule-2026-10-07.json');
const EDITION = '47367161-7c6e-5ca5-a1fa-ffd8213868cb';
const SLUG = 'baycurrent-classic-q60987711-2026';

async function board(sports, bodies) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('golf.propbetedge.ai') ? bodies.golf : u.includes('wnba-api') ? bodies.wnba : null;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{}', { status: 404 });
  };
  try { return await loadBoard(sports); } finally { globalThis.fetch = real; }
}

test('golf adapter keeps the edition UUID (market_id), slug routes and Golf\'s own ordered board', async () => {
  const b = await board('golf', { golf: GOLF_LIVE });
  const g = b.items.find((x) => x.sport === 'golf');
  assert.equal(g.source_id, SLUG, 'source_id stays the slug (golf routes)');
  assert.equal(g.market_id, EDITION, 'market_id = edition.id (the desk key)');
  assert.match(g.href, new RegExp(`/tournament/${SLUG}$`));
  const src = GOLF_LIVE.events[0].leaderboard;
  assert.deepEqual(g.meta.golf.leaderboard.map((r) => [r.name, r.position, r.total_to_par, r.thru]), src.slice(0, 5).map((r) => [r.name, r.position, r.total_to_par, r.thru]), 'rows exactly as Golf publishes them, in Golf\'s order');
  assert.deepEqual([g.meta.golf.edition_id, g.meta.golf.edition_slug, g.meta.golf.course, g.meta.golf.field_size], [EDITION, SLUG, 'Yokohama Country Club', src.length]);
  assert.ok(g.meta.golf.leaders.length >= 1);
  // board rows for the card: tied leaders first, 3..5 rows, Golf's position strings
  const rows = golfBoardRows(g.meta.golf);
  const lead = src[0].position;
  assert.equal(rows.length, Math.min(5, Math.max(3, src.filter((r) => r.position === lead).length)));
  assert.equal(rows[0].position, lead);
  assert.deepEqual([golfToPar(-6), golfToPar(0), golfToPar(2), golfToPar(null)], ['-6', 'E', '+2', '—']);
  assert.deepEqual([golfThru({ thru: 14, status: 'active' }), golfThru({ thru: 18, status: 'active' }), golfThru({ thru: null }), golfThru({ thru: 9, status: 'cut' })], ['THRU 14', 'F', '', 'CUT']);
  assert.deepEqual(golfBoardRows({ leaderboard: [] }), [], 'no leaderboard yet -> no rows (no fake empty board)');
});

test('golf joins its outright market by edition UUID and becomes a LIVE MARKET (never by title or names)', async () => {
  const b = await board('golf', { golf: GOLF_LIVE });
  const idx = scoreIndex(b.items);
  const raw = { ...GOLF_DESK.events[0], sport: 'golf', lane: 'golf' };
  assert.ok(ID_JOIN_SPORTS.has('golf') && TARGETED_SPORTS.has('golf'));
  const j = joinScore(raw, idx);
  assert.equal(j.state, 'LINKED');
  assert.equal(j.score.market_id, EDITION);
  // a title-only twin never joins
  assert.equal(joinScore({ ...raw, canonical_event_id: 'not-the-uuid' }, idx).state, 'NO_SCORE');
  const e = normalizeEvent(raw, idx);
  assert.equal(e.live, true);
  assert.deepEqual([e.field.n, e.field.noun], [71, 'golfers']);
  assert.equal(e.badge, 'RULE_MISMATCH');
  assert.equal(e.best_gap, null, 'rules differ: no mid gap is ever computed');
  assert.ok(e.contracts.every((c) => c.gap_pts == null));
  // the rail's top 5 are market favourites by venue price (desc), a different concept from Golf's leaderboard
  const top5 = e.contracts.filter((c) => c.priced).slice(0, 5);
  const px = (c) => Math.max(c.kalshi?.mid_bp ?? -1, (c.polymarket || c.related.find((r) => r.venue === 'polymarket'))?.mid_bp ?? -1);
  assert.deepEqual(top5.map(px), [...top5.map(px)].sort((a, b) => b - a));
  assert.ok(top5.some((c) => c.kalshi?.mid_bp != null), 'Kalshi prices');
  // 2026-10-08 00:14Z the desk carried the Polymarket outright as RULE_MISMATCH related quotes with mid null
  // (freshness "delayed"): nothing is fabricated, the Poly price is simply absent.
  assert.ok(top5.every((c) => !c.related.some((r) => r.venue === 'polymarket' && r.mid_bp != null)));
  // the same payload once Polymarket prices land: they flow through on the related quote, still no gap
  const priced = { ...raw, contracts: raw.contracts.map((c, i) => ({ ...c, related: c.related.map((r) => (r.venue === 'polymarket' ? { ...r, mid_bp: 900 - i * 10, bid_bp: 880 - i * 10, ask_bp: 920 - i * 10, freshness: 'live' } : r)) })) };
  const ep = normalizeEvent(priced, idx);
  assert.ok(ep.contracts.filter((c) => c.priced).slice(0, 5).some((c) => c.related.some((r) => r.venue === 'polymarket' && r.mid_bp != null)), 'Polymarket (rules differ) prices');
  assert.equal(ep.best_gap, null, 'rules differ: never a mid gap, even with both venues priced');
  const st = liveMarketStates(b.items.filter((x) => x.status === 'live'), { events: [e], lanes: [{ lane: 'golf', state: 'ok', events: 1 }] });
  assert.equal(st[0].state, LIVE_MARKET.MARKETS);
  assert.equal(st[0].key, `golf:${EDITION}`);
  assert.equal(scoreKey(b.items[0]), `golf:${EDITION}`);
  assert.equal(st[0].source_id, EDITION, 'a targeted check asks the desk for the UUID');
});

test('the UFC bout copy is UFC-only; every other unlinked sport gets a truthful generic chip', () => {
  assert.equal(liveMarketChip({ state: LIVE_MARKET.NOT_LINKED, sport: 'ufc' }), 'BOUT MARKETS IN UFC HUB');
  for (const sport of ['golf', 'f1', 'wnba', 'nhl']) assert.equal(liveMarketChip({ state: LIVE_MARKET.NOT_LINKED, sport }), 'MARKET LINK NOT AVAILABLE');
  assert.equal(liveMarketChip({ state: LIVE_MARKET.NONE, sport: 'golf' }), 'NO MARKETS');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /BOUT MARKETS IN UFC HUB/, 'the app never hard-codes the UFC copy');
  assert.doesNotMatch(app, /LIVE_MARKET_CHIP\[/, 'chips go through liveMarketChip()');
});

test('WNBA Liberty @ Dream: verified WNBA product team marks, and the market joins by ESPN game id', async () => {
  const b = await board('wnba', { wnba: WNBA });
  const g = b.items.find((x) => x.source_id === '401918297');
  assert.equal(g.title, 'NY @ ATL');
  assert.deepEqual([g.score.away.id, g.score.away.name, g.score.away.logo], ['9', 'New York Liberty', 'https://wnba.propbetedge.ai/media/teams/9/128.webp']);
  assert.deepEqual([g.score.home.id, g.score.home.name, g.score.home.logo], ['20', 'Atlanta Dream', 'https://wnba.propbetedge.ai/media/teams/20/128.webp']);
  assert.ok(b.items.every((x) => !x.score?.away?.logo || x.score.away.logo.startsWith('https://wnba.propbetedge.ai/media/teams/')), 'no other logo source');
  const desk = { canonical_event_id: '401918297', sport: 'wnba', title: 'NY @ ATL', contracts: [
    { canonical_contract_id: 'sports_winner|wnba:401918297|team:9', label: 'NY', role: 'away', venues: [{ venue: 'kalshi', match: 'EXACT_MATCH', mid_bp: 4250, bid_bp: 4200, ask_bp: 4300, freshness: 'live' }], related: [], listed: [] },
    { canonical_contract_id: 'sports_winner|wnba:401918297|team:20', label: 'ATL', role: 'home', venues: [{ venue: 'kalshi', match: 'EXACT_MATCH', mid_bp: 5750, bid_bp: 5700, ask_bp: 5800, freshness: 'live' }], related: [], listed: [] }] };
  const e = normalizeEvent(desk, scoreIndex(b.items));
  assert.equal(e.join.state, 'LINKED');
  // market-linked card: the linked score-side mark wins over a recreated one
  assert.equal(participantMedia('wnba', e.contracts[0], g.score.away).src, 'https://wnba.propbetedge.ai/media/teams/9/128.webp');
  // an unapproved / missing team id never gets a guessed WNBA mark
  const unknown = await board('wnba', { wnba: { data: { games: [{ game_id: 'x1', away: { team_id: '999', abbr: 'XX' }, home: { abbr: 'YY' }, status: { state: 'pre' } }] } } });
  assert.deepEqual([unknown.items[0].score.away.logo, unknown.items[0].score.home.logo], [null, null]);
});
