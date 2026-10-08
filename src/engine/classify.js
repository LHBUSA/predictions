// Domain classifier for venue contracts. Classification only routes a contract; it never produces a
// probability. Order matters: the most specific rule wins.
//
// Two levels:
//   domain   — coarse ledger domain (DB CHECK: WEATHER, MACRO, HOUSING, ENERGY, GEO_NATURAL, SPORTS, ELECTION_CIVIC, OTHER)
//   category — product/display category (WEATHER, MACRO, RATES, FINANCE, BUSINESS, SCIENCE, SPACE, PUBLIC_HEALTH, ENERGY, ...)

export const DOMAINS = Object.freeze(['WEATHER', 'MACRO', 'HOUSING', 'ENERGY', 'GEO_NATURAL', 'SPORTS', 'ELECTION_CIVIC', 'OTHER']);
export const CATEGORIES = Object.freeze(['WEATHER', 'MACRO', 'RATES', 'FINANCE', 'BUSINESS', 'SCIENCE', 'SPACE', 'PUBLIC_HEALTH', 'ENERGY', 'HOUSING', 'GEO_NATURAL', 'SPORTS', 'ELECTION_CIVIC', 'OTHER']);
const CATEGORY_DOMAIN = Object.freeze({ RATES: 'MACRO', FINANCE: 'MACRO', BUSINESS: 'OTHER', SCIENCE: 'OTHER', SPACE: 'OTHER', PUBLIC_HEALTH: 'OTHER' });

const RULES = [
  ['GEO_NATURAL', /\b(hurricane|tropical storm|named storm|earthquake|magnitude|volcan\w*|wildfire|tornado|tsunami|landfall)\b/i],
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

// Explicit series-family categories for the non-sports research lanes (series ticker prefix -> category).
const SERIES_CATEGORY = [
  [/^KX(RAIN|HIGH|LOW|SNOW)/, 'WEATHER'],
  [/^KX(5|7|10|30)YR|^KXNOTE|^KXTNOTE|^KX10Y|^KX30YUST/, 'RATES'],
  [/^KXFED/, 'MACRO'],
  [/^KXCPI/, 'MACRO'],
  [/^KXIPO/, 'FINANCE'],
  [/^KXTESLA|^KXAMZN|^KXMETAHEADCOUNT/, 'BUSINESS'],
  [/^KXSPACEX|^KXSTARSHIP|^KXLAUNCH/, 'SPACE'],
  [/^KXMEASLES|^KXFLDENGUE/, 'PUBLIC_HEALTH'],
  [/^KXREACTOR/, 'ENERGY'],
];

// Settlement datasets that are commercial/proprietary: never modeled without proven access rights.
export const COMMERCIAL_SETTLEMENT = /(fiscal\.ai|carbon arc|openrouter|ornn|vercel ai gateway|sensor tower|similarweb|apptopia|mediaradar|lmarena|leaderboard)/i;

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

export function categorizeContract(ctx = {}) {
  const ticker = String(ctx.series?.ticker || ctx.event?.series_ticker || ctx.market?.event_ticker || ctx.market?.ticker || '');
  for (const [re, cat] of SERIES_CATEGORY) {
    if (re.test(ticker)) return { category: cat, domain: CATEGORY_DOMAIN[cat] || cat };
  }
  const domain = classifyContract(ctx);
  if (domain === 'OTHER' && /science|technology/i.test(String(ctx.series?.category || ''))) return { category: 'SCIENCE', domain: 'OTHER' };
  if (domain === 'OTHER' && /compan|business/i.test(String(ctx.series?.category || ''))) return { category: 'BUSINESS', domain: 'OTHER' };
  return { category: domain, domain };
}

export function commercialSettlementSource(series = {}) {
  const names = (series?.settlement_sources || []).map((s) => `${s.name || ''} ${s.url || ''}`).join(' ; ');
  const m = COMMERCIAL_SETTLEMENT.exec(names);
  return m ? m[0] : null;
}
