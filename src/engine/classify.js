// Domain classifier for venue contracts. Classification only routes a contract; it never produces a
// probability. Order matters: the most specific rule wins.

export const DOMAINS = Object.freeze(['WEATHER', 'MACRO', 'HOUSING', 'ENERGY', 'GEO_NATURAL', 'SPORTS', 'ELECTION_CIVIC', 'OTHER']);

const RULES = [
  ['GEO_NATURAL', /\b(hurricane|tropical storm|named storm|earthquake|magnitude|volcanw*|wildfire|tornado|tsunami|landfall)\b/i],
  ['HOUSING', /\b(home prices?|house prices?|housing|case-shiller|mortgage|rent(s|al)?\b|existing home|new home|housing starts|building permits|zillow)\b/i],
  ['ENERGY', /\b(gas prices?|gasoline|crude|oil prices?|wti|brent|natural gas|electricity|opec|barrels?)\b/i],
  ['MACRO', /\b(fed(eral reserve)?|fomc|interest rate|rate (cut|hike)|cpi|inflation|pce|unemployment|jobless|payrolls?|jobs report|gdp|recession|retail sales|treasury|yield|jolts)\b/i],
  ['ELECTION_CIVIC', /\b(election|elected|president(ial)?|senate|house seat|governor|mayor|primary|nominee|ballot|vote|congress|supreme court|impeach|cabinet|approval rating|polling)\b/i],
];

const CATEGORY = [
  [/climate|weather/i, 'WEATHER'],
  [/sports/i, 'SPORTS'],
  [/politic|election/i, 'ELECTION_CIVIC'],
  [/econom|financ/i, 'MACRO'],
];

export function classifyContract({ series = {}, event = {}, market = {} } = {}) {
  const text = [series.title, event.title, market.title, market.rules_primary].filter(Boolean).join(' \n ');
  const category = String(series.category || event.category || '');
  for (const [domain, re] of RULES) {
    if (re.test(text)) {
      // weather-category storms are natural events; macro words inside sports props stay sports
      if (domain !== 'GEO_NATURAL' && /sports/i.test(category)) return 'SPORTS';
      return domain;
    }
  }
  for (const [re, domain] of CATEGORY) if (re.test(category)) return domain;
  return 'OTHER';
}
