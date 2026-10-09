// Same-security symbol changes (public exchange/issuer record). The historical membership file uses the symbol in
// force on each date; the price source keeps the full history under the CURRENT symbol. Only true renames of the same
// listed security are mapped. Mergers into a different security, spin-offs and share-class collapses are NOT aliased
// (they stay uncovered and count against coverage). A reused symbol (e.g. FB is now an unrelated 2025 ETF) must be
// aliased, never fetched under the old symbol.
export const SYMBOL_ALIASES = Object.freeze({
  FB: 'META',      // Meta Platforms, 2022-06-09
  ABC: 'COR',      // Cencora (AmerisourceBergen), 2023-08-30
  ANTM: 'ELV',     // Elevance Health (Anthem), 2022-06-28
  BK: 'BNY',       // BNY (Bank of New York Mellon) symbol change
  BLL: 'BALL',     // Ball Corp, 2022-05-17
  HFC: 'DINO',     // HF Sinclair (HollyFrontier), 2022-03-14
  HRS: 'LHX',      // L3Harris (Harris), 2019-07-01
  JEC: 'J',        // Jacobs, 2019-12-10
  MMC: 'MRSH',     // Marsh McLennan symbol change
  FI: 'FISV',      // Fiserv symbol change back to FISV
  FBHS: 'FBIN',    // Fortune Brands Innovations, 2022-12-15
  FLT: 'CPAY',     // Corpay (FleetCor), 2024-03-25
  HCP: 'DOC',      // HCP -> PEAK 2019-11 -> DOC 2024-03 (Healthpeak)
  PEAK: 'DOC',
  PKI: 'RVTY',     // Revvity (PerkinElmer), 2023-05-16
  RE: 'EG',        // Everest Group, 2023-07-10
  WLTW: 'WTW',     // Willis Towers Watson, 2022-01-10
  ARNC: 'HWM',     // Arconic Inc. renamed Howmet Aerospace, 2020-04-01
  BHGE: 'BKR',     // Baker Hughes, 2019-10-18
  TMK: 'GL',       // Globe Life (Torchmark), 2019-08-08
  GPS: 'GAP',      // Gap Inc, 2024-08-22
  ADS: 'BFH',      // Bread Financial (Alliance Data), 2022-03-23
  SYMC: 'GEN',     // Symantec -> NortonLifeLock (NLOK) 2019-11 -> Gen Digital (GEN) 2022-11
  NLOK: 'GEN',
  UTX: 'RTX',      // United Technologies renamed Raytheon Technologies (surviving issuer), 2020-04-03
  DWDP: 'DD',      // DowDuPont renamed DuPont de Nemours, 2019-06-03
  CTL: 'LUMN',     // CenturyLink renamed Lumen, 2020-09-18
  MYL: 'VTRS',     // Mylan -> Viatris (price source carries the continuous history), 2020-11-16
  BBT: 'TFC',      // BB&T (legal acquirer) renamed Truist Financial, 2019-12-09 (BBT now = an unrelated bank's history)
  KORS: 'CPRI',    // Capri Holdings (Michael Kors), 2018-12-31
  LB: 'BBWI'       // L Brands renamed Bath & Body Works, 2021-08-03 (LB is now an unrelated 2024 listing)
});

// Date-ranged identity: the symbol meant a different security before `before`.
export const DATED_ALIASES = Object.freeze([
  { ticker: 'IR', before: '2020-03-02', target: 'TT' } // Ingersoll-Rand plc renamed Trane Technologies; "IR" then = Gardner Denver
]);

// Price-source identity mismatches found in the 2026-10-09 audit: the source's history under this symbol belongs to a
// DIFFERENT issuer than the index member. Member-days are treated as UNCOVERED (never priced with the wrong company).
//   PARA: source = Banzai International (Paramount/ViacomCBS/CBS history is not available under any symbol).
export const BLOCKED_SYMBOLS = Object.freeze(new Set(['PARA', 'CBS', 'VIAC']));

export function resolveSymbol(t, d) {
  if (BLOCKED_SYMBOLS.has(t)) return null;
  for (const a of DATED_ALIASES) if (a.ticker === t && d && d < a.before) return a.target;
  return SYMBOL_ALIASES[t] || t;
}
