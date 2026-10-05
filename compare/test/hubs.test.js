// Hubs + media: participant media resolution, date buckets, hub stats, event title fallback, UFC photo enrichment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { participantMedia, whenOf, inWhen, hubStats, normalizeEvent } from '../core.js';
import { enrichUfc, fighterPhotoFrom, espnMmaHeadshot, __mediaCache } from '../api/_lib/media.js';

const C = (label, team) => ({ label, id: `sports_winner|x:1|team:${team}` });

test('team logos come from the sources the sport feeds already use; aliases + team names map to codes', () => {
  assert.equal(participantMedia('nba', C('UTA', '26')).src, 'https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/utah.png');
  assert.equal(participantMedia('nfl', C('WSH', '28')).src, 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/wsh.png');
  assert.equal(participantMedia('nhl', C('SEA', '55')).src, 'https://assets.nhle.com/logos/nhl/svg/SEA_dark.svg');
  assert.equal(participantMedia('nhl', C('Golden Knights', '54')).src, 'https://assets.nhle.com/logos/nhl/svg/VGK_dark.svg');
  assert.equal(participantMedia('wnba', C('Las Vegas Aces', '17')).src, 'https://a.espncdn.com/i/teamlogos/wnba/500/lv.png');
  assert.equal(participantMedia('mlb', C('ATL', '144')).src, 'https://www.mlbstatic.com/team-logos/team-cap-on-dark/144.svg');
  const linked = participantMedia('nba', C('MEM', '29'), { logo: 'https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/mem.png' });
  assert.equal(linked.src, 'https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/mem.png', 'linked score feed logo wins');
});

test('player photos: tennis by canonical player uuid, UFC only from server enrichment; else initials', () => {
  const t = participantMedia('tennis', C('Rigele Te', '9378d274-e543-56f4-840a-35f156fbfb27'));
  assert.equal(t.kind, 'photo');
  assert.equal(t.src, 'https://tennis-api.propbetedge.ai/media/players/9378d274-e543-56f4-840a-35f156fbfb27/portrait.webp');
  assert.equal(participantMedia('ufc', { ...C('Otari Tanzilovi', '6b00dec0-0ee2-4602-97c1-bc3bd039aff6') }).src, null);
  assert.equal(participantMedia('ufc', { ...C('Otari Tanzilovi', 'x'), media: { photo: 'https://a.espncdn.com/i/headshots/mma/players/full/5212853.png' } }).src, 'https://a.espncdn.com/i/headshots/mma/players/full/5212853.png');
  assert.equal(participantMedia('f1', C('Red Bull', 'x')).src, null, 'F1 team marks are held');
  assert.equal(participantMedia('tennis', C('Jamey-Lyn Horth', 'not-a-uuid')).initials, 'JH');
});

test('UFC enrichment: ESPN headshot by athlete id, cached, never blocks past its budget', async () => {
  __mediaCache.clear();
  assert.equal(espnMmaHeadshot('5212853'), 'https://a.espncdn.com/i/headshots/mma/players/full/5212853.png');
  assert.equal(espnMmaHeadshot('deprecated: compatibility only; use id'), null);
  assert.equal(fighterPhotoFrom({ data: { primary_image: null, espn_athlete_id: '3074464' } }), 'https://a.espncdn.com/i/headshots/mma/players/full/3074464.png');
  let calls = 0;
  const fetchImpl = async (u) => { calls++; return new Response(JSON.stringify({ data: { espn_athlete_id: u.endsWith('aaaaaaaa-0000-0000-0000-000000000001') ? '111111' : 'deprecated' } }), { status: 200 }); };
  const events = [{ contracts: [{ canonical_contract_id: 'sports_winner|ufc:e|team:aaaaaaaa-0000-0000-0000-000000000001' }, { canonical_contract_id: 'sports_winner|ufc:e|team:aaaaaaaa-0000-0000-0000-000000000002' }] }];
  assert.equal(await enrichUfc(events, { fetchImpl }), 1);
  assert.equal(events[0].contracts[0].media.photo, 'https://a.espncdn.com/i/headshots/mma/players/full/111111.png');
  assert.equal(events[0].contracts[1].media, undefined, 'no id, no photo (initials)');
  await enrichUfc(JSON.parse(JSON.stringify(events)), { fetchImpl });
  assert.equal(calls, 2, 'cached: no second lookup');
  __mediaCache.clear();
  const slow = async () => new Promise(() => {});
  const t0 = Date.now();
  await enrichUfc([{ contracts: [{ canonical_contract_id: 'sports_winner|ufc:e|team:bbbbbbbb-0000-0000-0000-000000000001' }] }], { fetchImpl: slow, budgetMs: 50 });
  assert.ok(Date.now() - t0 < 1000, 'budget bounds the desk');
});

test('date buckets (local day): live wins; today / tomorrow / week / later', () => {
  const now = new Date(2026, 9, 5, 15, 0).getTime();
  const at = (d, h) => new Date(2026, 9, 5 + d, h, 0).toISOString();
  assert.equal(whenOf({ live: true, start_at: at(3, 19) }, now), 'live');
  assert.equal(whenOf({ start_at: at(0, 19) }, now), 'today');
  assert.equal(whenOf({ start_at: at(1, 1) }, now), 'tomorrow');
  assert.equal(whenOf({ start_at: at(5, 19) }, now), 'week');
  assert.equal(whenOf({ start_at: at(12, 19) }, now), 'later');
  assert.equal(inWhen({ start_at: at(12, 19) }, 'all', now), true);
});

test('hub stats + title fallback from participants', () => {
  const e = normalizeEvent({ canonical_event_id: 'x', sport: 'ufc', title: 'Market', contracts: [{ canonical_contract_id: 'a', label: 'Jamey-Lyn Horth', venues: [{ venue: 'polymarket', mid_bp: 5000, freshness: 'live' }] }, { canonical_contract_id: 'b', label: 'Katlyn Cerminara', venues: [{ venue: 'polymarket', mid_bp: 5000, freshness: 'live' }] }] });
  assert.equal(e.title, 'Jamey-Lyn Horth v Katlyn Cerminara');
  const s = hubStats([e, { ...e, active: true, badge: 'COMPARABLE', best_gap: 2.5 }]);
  assert.equal(s.comparable, 1);
  assert.equal(s.best.best_gap, 2.5);
});
