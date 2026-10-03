// Model family registry: public-safe descriptions, states and known limitations. Probabilities never come from here.
export const FAMILIES = Object.freeze([
  { id: 'pbe-weather-precip', name: 'Weather · measurable rain', category: 'WEATHER', state: 'RESEARCH', versions: ['1.0.0', '1.1.0'],
    inputs: 'NWS GFS MOS + National Blend of Models 6-h PoP for the exact climate day, 1991-2020 station climatology (ACIS)',
    limitations: ['Forecasts are published only before the climate day opens (no intraday observations in v1)', 'IEM NBM archive gaps -> GFS-only fallback tier', 'Settles on The Weather Company values; verified against NWS CLI 112/112'] },
  { id: 'pbe-weather-maxtemp', name: 'Weather · daily high', category: 'WEATHER', state: 'RESEARCH', versions: ['1.0.0', '1.1.0'],
    inputs: 'National Blend of Models day max (GFS MOS fallback) + station empirical guidance-error tables',
    limitations: ['Pre-window only; no current-conditions input', 'Guidance can run cold/hot in unusual regimes (see LA diagnostic, 2026-10-04)'] },
  { id: 'pbe-rates-path', name: 'Rates · Treasury yield paths', category: 'RATES', state: 'RESEARCH', versions: ['1.0.0'],
    inputs: 'Official Daily Treasury Par Yield Curve (settlement source); EWMA volatility x bootstrapped historical daily changes',
    limitations: ['Random-walk drift assumption; no macro-release calendar effects yet', 'Contracts already decided by the published path are not forecast'] },
  { id: 'pbe-fed-decision', name: 'Fed decision', category: 'MACRO', state: 'SHADOW', versions: ['1.0.0'],
    inputs: 'H.15 6-month Treasury vs target midpoint, change since last decision, previous decision (FOMC calendar)',
    limitations: ['Holdout top-outcome accuracy below an always-hold baseline: SHADOW only, never published'] },
  { id: 'corporate-fundamentals', name: 'Corporate fundamentals (Tesla deliveries, Amazon headcount)', category: 'BUSINESS', state: 'MONITORING', versions: [],
    inputs: 'Planned: company IR / SEC filings; Amazon headcount settles on a commercial dataset (not modeled)', limitations: ['No model enabled'] },
  { id: 'space-operations', name: 'Space operations (SpaceX launch counts, Starship timing)', category: 'SPACE', state: 'MONITORING', versions: [],
    inputs: 'Planned: completed-launch history + vintage-stamped public schedules', limitations: ['No model enabled'] },
  { id: 'public-health-counts', name: 'Public health counts (measles, Florida dengue)', category: 'PUBLIC_HEALTH', state: 'MONITORING', versions: [],
    inputs: 'Planned: CDC / FDOH weekly counts with reporting-delay modelling', limitations: ['No model enabled'] },
  { id: 'energy-regulatory', name: 'Energy & regulatory (NRC new reactor license)', category: 'ENERGY', state: 'MONITORING', versions: [],
    inputs: 'Planned: NRC docket status, procedural milestones (hazard model)', limitations: ['No model enabled'] },
  { id: 'corporate-event-hazard', name: 'Corporate events (Anthropic / Brex IPO timing)', category: 'FINANCE', state: 'MONITORING', versions: [],
    inputs: 'Planned: SEC EDGAR filings, exchange notices (SHADOW first)', limitations: ['No model enabled'] },
]);

export const CATEGORY_LABEL = Object.freeze({ WEATHER: 'Weather', MACRO: 'Macro', RATES: 'Rates', FINANCE: 'Finance', BUSINESS: 'Business', SCIENCE: 'Science', SPACE: 'Space', PUBLIC_HEALTH: 'Public health', ENERGY: 'Energy', OTHER: 'Other' });
export const PUBLIC_STATES = Object.freeze(['RESEARCH', 'VALIDATED', 'OFFICIAL']);
export const MIN_RESOLVED_FOR_METRICS = 30;
