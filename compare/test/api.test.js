// Compare server routes: one entitlement decision (401/403/503), desk lane states, cap, event composition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verdict, sessionCookie, membership } from '../api/_lib/access.js';
import { laneResult, laneUrl, parseScope, DESK_PAGE_LIMIT, SPORT_LANES, mapLimit } from '../api/_lib/desk.js';
import { composeEvent } from '../api/_lib/event.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('verdict: anonymous 401, signed-in non-member 403, unverified 503, members 200', () => {
  assert.equal(verdict({ status: 200, body: { authenticated: false, membership: { state: 'anonymous', entitled: false } } }).status, 401);
  assert.equal(verdict({ status: 200, body: { authenticated: true, membership: { state: 'signed_in', entitled: false } } }).status, 403);
  assert.equal(verdict({ status: 503, body: {} }).status, 503);
  assert.equal(verdict({ status: 200, body: { authenticated: true, membership: { state: 'unverified', entitled: false } } }).status, 503);
  assert.equal(verdict({ status: 200, body: { authenticated: true, membership: { state: 'all_access', entitled: true } } }).status, 200);
  assert.equal(verdict({ status: 200, body: { authenticated: true, membership: { state: 'owner', entitled: true } } }).status, 200);
  assert.equal(verdict({ status: 200, body: { authenticated: true, membership: { state: 'all_access', entitled: false } } }).status, 403, 'entitled flag must be true');
});

test('membership: forwards only pbe_session; authority down = 503 unverified', async () => {
  assert.equal(sessionCookie('_ga=1; pbe_session=abc.def; pbe_privacy_v1=x'), 'pbe_session=abc.def');
  assert.equal(sessionCookie('_ga=1'), '');
  let sent;
  const ok = await membership({ headers: { cookie: '_ga=1; pbe_session=tok' } }, { fetchImpl: async (u, o) => { sent = o.headers; return new Response(JSON.stringify({ authenticated: true, membership: { state: 'all_access', entitled: true } }), { status: 200 }); } });
  assert.equal(sent.cookie, 'pbe_session=tok');
  assert.equal(ok.status, 200);
  const down = await membership({ headers: {} }, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(down.status, 503);
  assert.equal(down.body.membership.state, 'unverified');
  const bad = await membership({ headers: {} }, { fetchImpl: async () => new Response('oops', { status: 500 }) });
  assert.equal(bad.status, 503);
});

test('desk lanes: 404 = not_connected, 5xx/timeout = unavailable, 200 = ok (even empty)', () => {
  assert.equal(laneResult('soccer', { ok: false, status: 404, body: { error: 'unknown_sport' } }).lane.state, 'not_connected');
  assert.equal(laneResult('nba', { ok: false, status: 502, body: null }).lane.state, 'unavailable');
  assert.equal(laneResult('nba', { ok: false, status: 0, body: null, error: 'timeout' }).lane.error, 'timeout');
  const empty = laneResult('nfl', { ok: true, status: 200, body: { events: [] } });
  assert.equal(empty.lane.state, 'ok');
  assert.equal(empty.lane.events, 0);
});

test('desk: asks for exactly the upstream cap (50), flags capped lanes, never 200', () => {
  const u = new URL(laneUrl('nhl'));
  assert.equal(u.searchParams.get('limit'), '50');
  assert.equal(DESK_PAGE_LIMIT, 50);
  const capped = laneResult('nhl', { ok: true, status: 200, body: { events: Array.from({ length: 50 }, (_, i) => ({ canonical_event_id: String(i), contracts: [] })) } });
  assert.equal(capped.lane.capped, true);
  const one = new URL(laneUrl('nba', { event: '401898388' }));
  assert.equal(one.searchParams.get('event'), '401898388');
  assert.equal(one.searchParams.get('limit'), null);
  assert.equal(new URL(laneUrl('nonsports')).searchParams.get('domain'), 'nonsports');
});

test('scope parsing: default = all sports (not prediction markets)', () => {
  assert.equal(parseScope({}).scope, 'sports');
  assert.deepEqual(parseScope({}).lanes, SPORT_LANES);
  assert.equal(parseScope({ scope: 'nonsports' }).scope, 'nonsports');
  assert.equal(parseScope({ sport: 'nhl' }).scope, 'nhl');
  assert.equal(parseScope({ scope: 'cricket' }), null);
});

test('event composition: real NBA game — Kalshi book/volume/change rows + Polymarket stored points per contract', () => {
  const intel = fx('intel-nba-401898388.json');
  const desk = fx('desk-nba-401898388.json');
  const ev = composeEvent('nba', '401898388', { ok: true, status: 200, body: intel }, { ok: true, status: 200, body: desk });
  assert.equal(ev.sources.kalshi.state, 'ok');
  assert.equal(ev.sources.polymarket.state, 'ok');
  const atl = ev.contracts.find((c) => c.canonical_contract_id === 'sports_winner|nba:401898388|team:1');
  assert.ok(atl, 'contract ids match the desk (canonical, deterministic)');
  assert.ok(atl.kalshi.points.length >= 2);
  assert.ok(atl.kalshi.volume_24h != null);
  assert.ok(atl.kalshi.no_ask_bp != null);
  assert.ok(atl.polymarket.points.length >= 2);
  for (const p of [...atl.kalshi.points, ...atl.polymarket.points]) assert.ok(Number.isFinite(p.v) && p.t, 'stored points only, no nulls');
  const down = composeEvent('nba', '401898388', { ok: false, status: 502, body: null }, { ok: false, status: 0, body: null });
  assert.equal(down.sources.kalshi.state, 'unavailable');
  assert.equal(down.contracts.length, 0);
});


test('desk fanout: bounded concurrency preserves lane order', async () => {
  let active = 0, max = 0;
  const seen = [];
  const out = await mapLimit(['nfl','nba','nhl','mlb','wnba','tennis'], 2, async (lane, i) => {
    active += 1; max = Math.max(max, active); seen.push(['start', lane, active]);
    await new Promise((resolve) => setTimeout(resolve, 4 + (5 - i)));
    active -= 1; seen.push(['end', lane, active]);
    return lane.toUpperCase();
  });
  assert.ok(max <= 2, `fanout exceeded bound: ${max}`);
  assert.deepEqual(out, ['NFL','NBA','NHL','MLB','WNBA','TENNIS']);
  assert.equal(seen.filter((x) => x[0] === 'start').length, 6);
});
