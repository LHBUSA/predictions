const CENSUS_BPS_BASE = 'https://api.census.gov/data/timeseries/bps';

const STATE_FIPS = Object.freeze({
  AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',DC:'11',FL:'12',GA:'13',HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',MD:'24',MA:'25',MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',NJ:'34',NM:'35',NY:'36',NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',SC:'45',SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56'
});

function requireText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(from, months) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
}

function periodEndIso(period) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
}

function previousYear(period) {
  const [year, month] = period.split('-').map(Number);
  return `${year - 1}-${String(month).padStart(2, '0')}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function percentChange(current, prior) {
  return Number.isFinite(current) && Number.isFinite(prior) && prior !== 0
    ? ((current / prior) - 1) * 100
    : null;
}

function rowsToObjects(payload) {
  if (!Array.isArray(payload) || payload.length < 2 || !Array.isArray(payload[0])) return [];
  const headers = payload[0];
  return payload.slice(1).map((values) => {
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? null; });
    return row;
  });
}

export class CensusBpsAdapter {
  constructor({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 10000, now = () => new Date() } = {}) {
    if (!apiKey) throw new TypeError('Census BPS apiKey is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  async query({ period, geography }) {
    const url = new URL(CENSUS_BPS_BASE);
    url.searchParams.set('get', 'NAME,PERMIT,GEO_ID');
    url.searchParams.set('time', period);
    url.searchParams.set('key', this.apiKey);
    if (geography.state) {
      const state = requireText(geography.state, 'state').toUpperCase();
      const fips = STATE_FIPS[state];
      if (!fips) throw new TypeError('state must be a supported 2-letter code');
      url.searchParams.set('for', `state:${fips}`);
    } else if (geography.cbsa) {
      const cbsa = requireText(geography.cbsa, 'cbsa');
      if (!/^\d{5}$/.test(cbsa)) throw new TypeError('cbsa must be a 5-digit code');
      url.searchParams.set('for', `metropolitan statistical area/micropolitan statistical area:${cbsa}`);
    } else {
      throw new TypeError('geography must include state or cbsa');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) {
      const text = typeof response.text === 'function' ? await response.text() : '';
      if (/no content|unknown predicate|not found/i.test(text)) return null;
      throw new Error(`Census BPS request failed: ${response.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
    }
    const rows = rowsToObjects(await response.json());
    if (!rows.length) return null;
    const row = rows[0];
    const value = numberOrNull(row.PERMIT);
    if (value === null) return null;
    return Object.freeze({ name: row.NAME || null, geoId: row.GEO_ID || null, value, period });
  }

  async latest(geography, { maxProbeMonths = 5 } = {}) {
    const now = this.now();
    let current = null;
    for (let monthsBack = 1; monthsBack <= maxProbeMonths; monthsBack += 1) {
      const period = monthKey(shiftMonth(now, -monthsBack));
      current = await this.query({ period, geography });
      if (current) break;
    }
    if (!current) return null;
    const yearAgoPeriod = previousYear(current.period);
    const yearAgo = await this.query({ period: yearAgoPeriod, geography });
    const fetchedAt = new Date().toISOString();
    const level = geography.state ? 'state' : 'metro';
    const key = geography.state ? String(geography.state).toUpperCase() : String(geography.cbsa);
    return Object.freeze({
      provider: 'U.S. Census Bureau',
      sourceId: `census-bps:${level}:${key}`,
      sourceUrl: 'https://www.census.gov/construction/bps/',
      geography: Object.freeze({
        level,
        state: geography.state ? String(geography.state).toUpperCase() : null,
        cbsa: geography.cbsa ? String(geography.cbsa) : null,
        name: current.name
      }),
      dataset: 'Building Permits Survey (BPS)',
      frequency: 'monthly revised',
      metric: 'PERMIT',
      fetchedAt,
      period: current.period,
      periodEnd: periodEndIso(current.period),
      value: current.value,
      yearAgoPeriod,
      yearAgo: yearAgo?.value ?? null,
      yoyPct: percentChange(current.value, yearAgo?.value ?? null),
      geoId: current.geoId,
      availabilitySemantics: 'capture-time-of-published-revised-month'
    });
  }
}

export { CENSUS_BPS_BASE, STATE_FIPS, periodEndIso as bpsPeriodEndIso, rowsToObjects as bpsRowsToObjects };
