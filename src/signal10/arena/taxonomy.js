// Signal 10 Strategy Arena — PBE SIC sector taxonomy (pbe-sic-sectors/1.0.0). Pure, Worker-safe.
// Source of every classification: the SEC EDGAR company record (Standard Industrial Classification code assigned by the
// SEC to the registrant; data.sec.gov/submissions). U.S. government data, no licence fee, no redistribution limit.
// Rules are ORDERED: the first matching range wins. Frozen with the challenger preregistration; any change = new version.
// This is NOT GICS: e.g. Alphabet/Meta (SIC 7370) are TECHNOLOGY here, Visa/Mastercard (SIC 7389) are INDUSTRIALS,
// Amazon (SIC 5961) is CONSUMER_DISCRETIONARY. The Arena methodology page discloses this.
export const TAXONOMY_VERSION = 'pbe-sic-sectors/1.0.0';

// Technology / AI / chips / software / cloud / infrastructure (SIC). Used for BOTH the Tech universe and the
// Diversified TECHNOLOGY sector bucket.
export const TECH_SIC_RANGES = Object.freeze([
  [3570, 3579, 'Computer & office equipment (computers, storage, peripherals)'],
  [3559, 3559, 'Special industry machinery (semiconductor equipment)'],
  [3661, 3669, 'Communications equipment'],
  [3670, 3679, 'Electronic components & semiconductors'],
  [3825, 3825, 'Instruments for measuring and testing electricity (semiconductor test)'],
  [3827, 3827, 'Optical instruments & lenses (semiconductor inspection)'],
  [5045, 5045, 'Wholesale: computers, peripherals & software'],
  [7370, 7379, 'Computer programming, software, data processing, cloud & IT services'],
]);

// [from, to, sector] — ordered, first match wins.
export const SECTOR_RULES = Object.freeze([
  ...TECH_SIC_RANGES.map(([a, b]) => [a, b, 'TECHNOLOGY']),
  // consumer staples overrides inside broader manufacturing / retail ranges
  [2840, 2844, 'CONSUMER_STAPLES'],  // soaps, detergents, cosmetics
  [5140, 5149, 'CONSUMER_STAPLES'],  // grocery wholesale
  [5331, 5331, 'CONSUMER_STAPLES'],  // variety stores (warehouse clubs, discount)
  [5400, 5499, 'CONSUMER_STAPLES'],  // food stores
  [5912, 5912, 'CONSUMER_STAPLES'],  // drug stores
  // health overrides
  [2830, 2836, 'HEALTH_CARE'],       // pharmaceuticals, biologicals
  [3840, 3851, 'HEALTH_CARE'],       // medical instruments & supplies
  [5047, 5047, 'HEALTH_CARE'],       // medical wholesale
  [5122, 5122, 'HEALTH_CARE'],       // drug wholesale
  [6324, 6324, 'HEALTH_CARE'],       // hospital & medical service plans
  [8000, 8099, 'HEALTH_CARE'],       // health services
  [8731, 8731, 'HEALTH_CARE'],       // commercial physical & biological research
  // energy, utilities, industrial services overrides
  [4922, 4923, 'ENERGY'],            // natural gas transmission
  [4610, 4619, 'ENERGY'],            // pipelines
  [4950, 4959, 'INDUSTRIALS'],       // sanitary / waste services
  [1520, 1531, 'CONSUMER_DISCRETIONARY'], // homebuilders
  [3630, 3639, 'CONSUMER_DISCRETIONARY'], // household appliances
  [3710, 3716, 'CONSUMER_DISCRETIONARY'], // motor vehicles & parts
  [3751, 3751, 'CONSUMER_DISCRETIONARY'], // motorcycles
  [6500, 6553, 'REAL_ESTATE'],
  [6798, 6798, 'REAL_ESTATE'],       // REITs
  [6770, 6770, 'UNCLASSIFIED'],      // blank checks
  // broad divisions
  [100, 999, 'MATERIALS'],          // agricultural production & services (seeds, crop science)
  [1000, 1299, 'MATERIALS'], [1300, 1399, 'ENERGY'], [1400, 1499, 'MATERIALS'],
  [1500, 1799, 'INDUSTRIALS'],
  [2000, 2199, 'CONSUMER_STAPLES'],  // food, beverages, tobacco
  [2200, 2399, 'CONSUMER_DISCRETIONARY'], // textiles, apparel
  [2400, 2499, 'MATERIALS'],         // lumber & wood
  [2500, 2599, 'CONSUMER_DISCRETIONARY'], // furniture
  [2600, 2699, 'MATERIALS'],         // paper & packaging
  [2700, 2799, 'COMMUNICATION'],     // publishing & printing
  [2800, 2899, 'MATERIALS'],         // chemicals
  [2900, 2999, 'ENERGY'],            // petroleum refining
  [3000, 3099, 'MATERIALS'],         // rubber & plastics
  [3100, 3199, 'CONSUMER_DISCRETIONARY'], // leather & footwear
  [3200, 3399, 'MATERIALS'],         // stone/glass, primary metals
  [3400, 3699, 'INDUSTRIALS'],       // fabricated metal, machinery, electrical equipment (tech ranges matched above)
  [3700, 3799, 'INDUSTRIALS'],       // aerospace, rail, ships (autos matched above)
  [3800, 3899, 'INDUSTRIALS'],       // instruments (medical / tech matched above)
  [3900, 3999, 'CONSUMER_DISCRETIONARY'], // jewelry, toys, sporting goods
  [4000, 4799, 'INDUSTRIALS'],       // transportation & logistics
  [4800, 4899, 'COMMUNICATION'],     // telecom, broadcasting, cable
  [4900, 4999, 'UTILITIES'],
  [5000, 5199, 'INDUSTRIALS'],       // wholesale (tech / health / staples matched above)
  [5200, 5999, 'CONSUMER_DISCRETIONARY'], // retail, restaurants (staples matched above)
  [6000, 6799, 'FINANCIALS'],
  [7000, 7099, 'CONSUMER_DISCRETIONARY'], // hotels
  [7200, 7299, 'CONSUMER_DISCRETIONARY'], // personal services
  [7300, 7399, 'INDUSTRIALS'],       // business services (computer services matched above)
  [7500, 7599, 'CONSUMER_DISCRETIONARY'], // auto services & rental
  [7800, 7899, 'COMMUNICATION'],     // motion pictures & streaming
  [7900, 7999, 'CONSUMER_DISCRETIONARY'], // amusement & recreation
  [8200, 8299, 'CONSUMER_DISCRETIONARY'], // education
  [8700, 8799, 'INDUSTRIALS'],       // engineering, accounting, management services
]);

export const SECTORS = Object.freeze(['TECHNOLOGY', 'COMMUNICATION', 'CONSUMER_DISCRETIONARY', 'CONSUMER_STAPLES', 'ENERGY', 'FINANCIALS',
  'HEALTH_CARE', 'INDUSTRIALS', 'MATERIALS', 'REAL_ESTATE', 'UTILITIES']);
export const SECTOR_LABEL = Object.freeze({ TECHNOLOGY: 'Technology', COMMUNICATION: 'Communication', CONSUMER_DISCRETIONARY: 'Consumer discretionary',
  CONSUMER_STAPLES: 'Consumer staples', ENERGY: 'Energy', FINANCIALS: 'Financials', HEALTH_CARE: 'Health care', INDUSTRIALS: 'Industrials',
  MATERIALS: 'Materials', REAL_ESTATE: 'Real estate', UTILITIES: 'Utilities', PRECIOUS_METALS: 'Precious metals (ETF)', UNCLASSIFIED: 'Unclassified' });

export function sectorOfSic(sic) {
  const n = Number.parseInt(sic, 10);
  if (!Number.isFinite(n)) return 'UNCLASSIFIED';
  for (const [a, b, s] of SECTOR_RULES) if (n >= a && n <= b) return s;
  return 'UNCLASSIFIED';
}
export const isTechSic = (sic) => { const n = Number.parseInt(sic, 10); return Number.isFinite(n) && TECH_SIC_RANGES.some(([a, b]) => n >= a && n <= b); };
