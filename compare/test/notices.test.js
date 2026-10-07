// Compare alert relevance (2026-10-06). Backend truth is unchanged; these pin what reaches the customer.
// Reference production state: NHL/NBA/Soccer live with priced cards, all ten desk lanes timing out, Tennis idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenNotices, carryDesk, sourceDiagnostics, relevance, boardEmpty, MARKET_STALE_MS, DESK_CARRY_MS } from '../core.js';

const NOW = Date.parse('2026-10-06T23:30:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const TEN = ['nfl', 'nba', 'nhl', 'mlb', 'wnba', 'tennis', 'ufc', 'soccer', 'golf', 'f1'];
const lane = (l, state = 'ok', extra = {}) => ({ lane: l, state, ...(state === 'unavailable' ? { error: 'timeout' } : { events: 3 }), ...extra });
const card = (sport, extra = {}) => ({ key: `${sport}:${sport}-1`, sport, lane: sport, live: true, active: true, badge: 'SINGLE_VENUE', start_at: iso(3600e3), contracts: [{ priced: true }], ...extra });
const liveItem = (sport, status = 'live', starts = iso(3600e3)) => ({ sport, source_id: `${sport}-1`, status, starts_at: starts });
const okSrc = (key) => ({ key, state: 'ok', fetched_at: iso(10e3) });
const codes = (n) => n.map((x) => x.code);
const allText = (n) => n.map((x) => x.text).join(' | ');

test('1. inactive sport source down -> no alert', () => {
  const desk = { lanes: [lane('nhl'), lane('mlb', 'unavailable')], events: [] };
  const n = screenNotices({ desk, deskStatus: 200, scope: 'sports', events: [card('nhl')], live: { items: [liveItem('nhl')], sources: [okSrc('nhl'), { key: 'mlb', state: 'unavailable', error: 'timeout' }] }, liveStatus: 200, now: NOW });
  assert.ok(!/MLB/.test(allText(n)), allText(n));
  assert.ok(!codes(n).some((c) => /lane_unavailable|lanes_unavailable|score_source_down/.test(c)));
});

test('2. live sport source down with no cached data -> warning for that sport only', () => {
  const desk = { lanes: [lane('nba'), lane('nhl', 'unavailable'), lane('mlb', 'unavailable')], events: [] };
  const n = screenNotices({ desk, deskStatus: 200, scope: 'sports', events: [card('nba')], live: { items: [liveItem('nba'), liveItem('nhl')], sources: [okSrc('nba'), okSrc('nhl')] }, liveStatus: 200, now: NOW });
  const w = n.filter((x) => x.code === 'lane_unavailable');
  assert.equal(w.length, 1);
  assert.equal(w[0].lane, 'nhl');
  assert.equal(w[0].level, 'warn');
  assert.match(w[0].text, /^NHL markets can't be loaded/);
  assert.ok(!/MLB/.test(allText(n)));
});

test('3. live sport refresh fails but cached card exists -> keep card, quiet stale state only', () => {
  const prev = { lanes: [lane('nhl')], events: [{ canonical_event_id: '1', sport: 'nhl', lane: 'nhl', contracts: [] }] };
  const prevAt = NOW - 60e3;
  const next = carryDesk(prev, prevAt, { lanes: [lane('nhl', 'unavailable')], events: [] }, NOW);
  assert.equal(next.events.length, 1, 'card kept');
  assert.equal(next.lanes[0].state, 'unavailable', 'lane truth unchanged');
  assert.equal(next.lanes[0].cached_at, new Date(prevAt).toISOString());
  const live = { items: [liveItem('nhl')], sources: [okSrc('nhl')] };
  // one missed poll: no customer notice at all
  const fresh = screenNotices({ desk: next, deskStatus: 200, scope: 'sports', events: [card('nhl')], live, liveStatus: 200, now: NOW });
  assert.deepEqual(codes(fresh).filter((c) => c !== 'no_comparable'), []);
  // materially stale: one quiet status with age, no lane/incident banner
  const later = NOW + MARKET_STALE_MS;
  const stale = screenNotices({ desk: next, deskStatus: 200, scope: 'sports', events: [card('nhl')], live, liveStatus: 200, now: later });
  const q = stale.filter((x) => x.code === 'market_refresh_delayed');
  assert.equal(q.length, 1);
  assert.equal(q[0].level, 'quiet');
  assert.match(q[0].text, /^Market refresh delayed · showing prices from \d+m ago$/);
  assert.ok(!stale.some((x) => x.level === 'error' || x.level === 'warn'));
  // a whole-desk network failure with cards on screen is also just a refresh delay
  const net = screenNotices({ desk: next, deskStatus: 0, deskAt: NOW - 200e3, scope: 'sports', events: [card('nhl')], live, liveStatus: 200, now: NOW });
  assert.deepEqual(codes(net).filter((c) => c !== 'no_comparable'), ['market_refresh_delayed']);
  // cached lanes count as answered for the empty-state check
  assert.equal(boardEmpty({ desk: next, viewKey: 'top', events: [] }).failure, undefined);
});

test('carryDesk: never carries past DESK_CARRY_MS, never invents data, chains cached_at', () => {
  const prev = { lanes: [lane('nhl')], events: [{ canonical_event_id: '1', sport: 'nhl', contracts: [] }] };
  assert.equal(carryDesk(prev, NOW - DESK_CARRY_MS - 1, { lanes: [lane('nhl', 'unavailable')], events: [] }, NOW).events.length, 0);
  assert.equal(carryDesk({ lanes: [lane('nhl')], events: [] }, NOW, { lanes: [lane('nhl', 'unavailable')], events: [] }, NOW).lanes[0].cached_at, undefined);
  const once = carryDesk(prev, NOW - 60e3, { lanes: [lane('nhl', 'unavailable')], events: [] }, NOW);
  const twice = carryDesk(once, NOW, { lanes: [lane('nhl', 'unavailable')], events: [] }, NOW + 60e3);
  assert.equal(twice.lanes[0].cached_at, once.lanes[0].cached_at, 'age keeps counting from the last good read');
  const recovered = carryDesk(twice, NOW + 60e3, { lanes: [lane('nhl')], events: [] }, NOW + 120e3);
  assert.equal(recovered.lanes[0].cached_at, undefined, 'a good read replaces the carry');
});

test('4. ten backend lanes down but only NHL active -> never enumerate ten sports', () => {
  const desk = { lanes: TEN.map((l) => lane(l, 'unavailable')), events: [] };
  const live = { items: [liveItem('nhl')], sources: TEN.map(okSrc) };
  // NHL cards on screen (carried / targeted reads): nothing escalates
  const withCards = screenNotices({ desk, deskStatus: 200, scope: 'sports', events: [card('nhl')], live, liveStatus: 200, now: NOW });
  assert.ok(!/market lanes are delayed|NFL|WNBA|TENNIS|GOLF|F1/.test(allText(withCards)), allText(withCards));
  assert.ok(!withCards.some((x) => x.level === 'error'));
  // nothing usable anywhere: ONE critical notice, still no list of sports
  const none = screenNotices({ desk, deskStatus: 200, scope: 'sports', events: [], live, liveStatus: 200, now: NOW });
  assert.deepEqual(codes(none), ['no_market_data']);
  assert.equal(none[0].text, 'Market data is unavailable right now. Retrying automatically.');
});

test('reference production state: NHL/NBA/Soccer live with prices, ten lanes timing out, Tennis idle', () => {
  const desk = { lanes: TEN.map((l) => lane(l, 'unavailable')), events: [] };
  const live = { items: [liveItem('nhl'), liveItem('nba'), liveItem('soccer')], sources: [...TEN.filter((x) => x !== 'tennis').map(okSrc), { key: 'tennis', state: 'unavailable', error: 'timeout' }] };
  const events = [card('nhl'), card('nba'), card('soccer')];
  const n = screenNotices({ desk, deskStatus: 200, scope: 'sports', events, live, liveStatus: 200, now: NOW });
  assert.ok(!codes(n).includes('lanes_unavailable'));
  assert.ok(!/TENNIS/.test(allText(n)));
  assert.ok(!n.some((x) => x.level === 'error' || x.level === 'warn'), allText(n));
  // diagnostics still carry the whole truth for us
  const d = sourceDiagnostics({ desk, live, liveStatus: 200, now: NOW });
  assert.equal(d.filter((x) => x.startsWith('market:')).length, 10);
  assert.ok(d.includes('score:tennis=unavailable timeout'));
});

test('5. Tennis source down with no live tennis -> no Tennis banner on ALL SPORTS', () => {
  const live = { items: [liveItem('nba'), liveItem('tennis', 'scheduled', new Date(NOW + 9 * 3600e3).toISOString())], sources: [okSrc('nba'), { key: 'tennis', state: 'unavailable', error: 'HTTP_503' }] };
  const n = screenNotices({ desk: { lanes: [lane('nba'), lane('tennis')] }, deskStatus: 200, scope: 'sports', events: [card('nba')], live, liveStatus: 200, now: NOW });
  assert.ok(!/TENNIS/.test(allText(n)), allText(n));
  // the same outage IS a warning once a tennis match is live
  const liveTennis = { ...live, items: [liveItem('nba'), liveItem('tennis')] };
  const w = screenNotices({ desk: { lanes: [lane('nba'), lane('tennis')] }, deskStatus: 200, scope: 'sports', events: [card('nba')], live: liveTennis, liveStatus: 200, now: NOW });
  assert.equal(w.find((x) => x.code === 'score_source_down')?.sport, 'tennis');
  assert.equal(w.find((x) => x.code === 'score_source_down')?.level, 'warn');
});

test('6. explicit Tennis scope with outage -> inline Tennis notice (muted when idle, warning when live)', () => {
  const src = [{ key: 'tennis', state: 'unavailable', error: 'HTTP_503' }];
  const idle = screenNotices({ desk: { lanes: [lane('tennis')] }, deskStatus: 200, scope: 'tennis', events: [card('tennis', { live: false, start_at: new Date(NOW + 20 * 3600e3).toISOString() })], live: { items: [], sources: src }, liveStatus: 200, now: NOW });
  const t = idle.find((x) => x.code === 'score_source_down');
  assert.equal(t.sport, 'tennis');
  assert.equal(t.level, 'quiet');
  assert.match(t.text, /^TENNIS game state unavailable/);
  const live = screenNotices({ desk: { lanes: [lane('tennis')] }, deskStatus: 200, scope: 'tennis', events: [card('tennis')], live: { items: [liveItem('tennis')], sources: src }, liveStatus: 200, now: NOW });
  assert.equal(live.find((x) => x.code === 'score_source_down').level, 'warn');
  // explicit hub whose lane is down with nothing on screen: critical, named for that sport
  const down = screenNotices({ desk: { lanes: [lane('tennis', 'unavailable')] }, deskStatus: 200, scope: 'tennis', events: [], live: { items: [], sources: [okSrc('tennis')] }, liveStatus: 200, now: NOW });
  assert.equal(down[0].code, 'no_market_data');
  assert.match(down[0].text, /^TENNIS market data is unavailable/);
});

test('relevance: game starting within two hours counts, one starting tomorrow does not', () => {
  const r = relevance({ scope: 'sports', live: { items: [liveItem('mlb', 'scheduled', new Date(NOW + 90 * 60e3).toISOString()), liveItem('nfl', 'scheduled', new Date(NOW + 20 * 3600e3).toISOString())] }, events: [], now: NOW });
  assert.ok(r.relevant('mlb'));
  assert.ok(!r.relevant('nfl'));
});

test('ordering: critical first, quiet after warnings', () => {
  const desk = { lanes: [lane('nba'), lane('nhl', 'unavailable')], events: [] };
  const n = screenNotices({ desk, deskStatus: 200, scope: 'sports', events: [card('nba')], live: { items: [liveItem('nhl'), liveItem('nba')], sources: [okSrc('nhl'), { key: 'nba', state: 'ok', fetched_at: iso(10 * 60e3) }] }, liveStatus: 200, now: NOW });
  const levels = n.map((x) => x.level);
  assert.ok(levels.indexOf('warn') < levels.indexOf('quiet'), levels.join(','));
});
