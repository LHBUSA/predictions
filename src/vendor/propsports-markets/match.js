// Fail-closed matching of Kalshi head-to-head events to canonical PBE events.
// Shared by every team sport (and soccer's three-way market). Never fuzzy: identities come
// only from an explicit crosswalk, and Kalshi's ticker code, display name AND stable strike
// UUID must all agree with one crosswalk row.
//
// cfg = {
//   series:     'KXNFLGAME',
//   teams:      Map(kalshiCode -> { kalshi, name, uuid, teamId, abbr }),
//   strikeKey:  'football_team' | 'hockey_team' | 'baseball_team' | 'basketball_team' | 'soccer_team',
//   order:      'away_home' (US leagues) | 'home_away' (soccer) — the ticker suffix order,
//   draw:       { code: 'TIE', name: 'Tie', uuid } for three-way markets, else undefined,
// }
// canonicalGames: [{ id, date /* ET YYYY-MM-DD */, homeId, awayId, startAt?, state? }]

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// KXNBAGAME-26OCT03MIATOR        -> { date: '2026-10-03', time: null,   suffix: 'MIATOR' }
// KXMLBGAME-26OCT031300CWSCLE    -> { date: '2026-10-03', time: '1300', suffix: 'CWSCLE' }  (ET start; doubleheaders)
export function parseEventTicker(eventTicker, seriesTicker) {
  const prefix = `${seriesTicker}-`;
  if (!eventTicker || !eventTicker.startsWith(prefix)) return null;
  // Suffix = team codes: starts with a letter, may contain digits (Mainz 05 = 'M05').
  const m = /^(\d{2})([A-Z]{3})(\d{2})(\d{4})?([A-Z][A-Z0-9]*)$/.exec(eventTicker.slice(prefix.length));
  if (!m) return null;
  const month = MONTHS[m[2]];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return null;
  if (m[4] && (Number(m[4].slice(0, 2)) > 23 || Number(m[4].slice(2)) > 59)) return null;
  return { date: `20${m[1]}-${String(month).padStart(2, '0')}-${m[3]}`, time: m[4] || null, suffix: m[5] };
}

// America/New_York wall-clock HHMM of an instant.
export function etHHMM(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return `${p.find((x) => x.type === 'hour').value}${p.find((x) => x.type === 'minute').value}`;
}

export function matchHeadToHead(event, canonicalGames, cfg) {
  const parsed = parseEventTicker(event.event_ticker, cfg.series);
  if (!parsed) return { status: 'unmatched', reason: 'unparseable_event_ticker' };
  const markets = event.markets || [];
  const expected = cfg.draw ? 3 : 2;
  if (markets.length !== expected) return { status: 'held', reason: `expected_${expected}_markets_got_${markets.length}` };

  const sides = [];
  let drawMarket = null;
  for (const mk of markets) {
    if (mk.event_ticker !== event.event_ticker) return { status: 'held', reason: 'market_event_mismatch' };
    const code = String(mk.ticker || '').slice(event.event_ticker.length + 1);
    const uuid = mk.custom_strike?.[cfg.strikeKey];
    if (cfg.draw && code === cfg.draw.code) {
      if (mk.yes_sub_title !== cfg.draw.name || uuid !== cfg.draw.uuid) return { status: 'held', reason: 'draw_market_disagrees' };
      drawMarket = mk;
      continue;
    }
    const team = cfg.teams.get(code);
    if (!team) return { status: 'held', reason: `unknown_team_code_${code || 'blank'}` };
    if (mk.yes_sub_title !== team.name) return { status: 'held', reason: `team_name_disagrees_${code}` };
    if (uuid !== team.uuid) return { status: 'held', reason: `team_uuid_disagrees_${code}` };
    sides.push({ code, team, market_ticker: mk.ticker });
  }
  if (sides.length !== 2) return { status: 'held', reason: 'expected_2_team_markets' };
  if (cfg.draw && !drawMarket) return { status: 'held', reason: 'draw_market_missing' };
  if (sides[0].team.teamId === sides[1].team.teamId) return { status: 'held', reason: 'same_team_both_sides' };

  const first = sides.find((s) => parsed.suffix.startsWith(s.code));
  const second = sides.find((s) => s !== first && parsed.suffix === `${first?.code}${s.code}`);
  if (!first || !second) return { status: 'held', reason: 'suffix_does_not_compose_from_markets' };
  const [away, home] = cfg.order === 'home_away' ? [second, first] : [first, second];

  const pair = new Set([away.team.teamId, home.team.teamId]);
  let candidates = canonicalGames.filter(
    (g) => g.date === parsed.date && pair.has(String(g.homeId)) && pair.has(String(g.awayId)) && String(g.homeId) !== String(g.awayId),
  );
  if (candidates.length === 0) {
    const sameTeams = canonicalGames.some((g) => pair.has(String(g.homeId)) && pair.has(String(g.awayId)));
    return { status: 'unmatched', reason: sameTeams ? 'teams_found_on_other_date' : 'no_canonical_game' };
  }
  // Doubleheaders: the ticker's ET start time is the only tie-breaker we accept.
  if (candidates.length > 1 && parsed.time) candidates = candidates.filter((g) => etHHMM(g.startAt) === parsed.time);
  if (candidates.length !== 1) return { status: 'held', reason: candidates.length ? 'ambiguous_multiple_canonical_games' : 'doubleheader_time_unmatched' };
  const game = candidates[0];
  if (String(game.homeId) !== home.team.teamId || String(game.awayId) !== away.team.teamId) {
    return { status: 'held', reason: 'home_away_disagrees' };
  }
  const outcomes = [
    { role: 'away', market_ticker: away.market_ticker, team_id: away.team.teamId, abbr: away.team.abbr, kalshi_name: away.team.name },
    { role: 'home', market_ticker: home.market_ticker, team_id: home.team.teamId, abbr: home.team.abbr, kalshi_name: home.team.name },
  ];
  if (drawMarket) outcomes.push({ role: 'draw', market_ticker: drawMarket.ticker, team_id: null, abbr: 'Draw', kalshi_name: cfg.draw.name });
  return { status: 'matched', canonical_event_id: String(game.id), date: parsed.date, outcomes };
}
