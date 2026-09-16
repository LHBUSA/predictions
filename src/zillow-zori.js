const ZORI_URLS = Object.freeze({
  state: 'https://files.zillowstatic.com/research/public_csvs/zori/State_zori_uc_sfrcondomfr_sm_month.csv',
  metro: 'https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv'
});

const STATE_NAMES = Object.freeze({
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'
});

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function dateColumns(headers) {
  return headers.filter((header) => /^\d{4}-\d{2}-\d{2}$/.test(header)).sort();
}

function periodFor(column) {
  return column.slice(0, 7);
}

function priorMonth(period) {
  const [year, month] = period.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

function priorYear(period) {
  const [year, month] = period.split('-').map(Number);
  return `${year - 1}-${String(month).padStart(2, '0')}`;
}

function pct(current, prior) {
  return Number.isFinite(current) && Number.isFinite(prior) && prior !== 0
    ? ((current / prior) - 1) * 100
    : null;
}

function periodEndIso(period) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
}

function normalize(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function rowObject(headers, values) {
  const obj = {};
  headers.forEach((header, index) => { obj[header] = values[index] ?? ''; });
  return obj;
}

function matchesGeography(scope, row, geography) {
  if (scope === 'state') {
    const state = String(geography.state || '').trim().toUpperCase();
    const expected = STATE_NAMES[state];
    if (!expected) throw new TypeError('state must be a supported 2-letter code');
    return normalize(row.RegionName) === normalize(expected) || normalize(row.StateName) === normalize(expected);
  }
  if (scope === 'metro') {
    if (geography.regionId && String(row.RegionID) === String(geography.regionId)) return true;
    const metro = String(geography.metro || '').trim();
    if (!metro) throw new TypeError('metro or regionId is required');
    return normalize(row.RegionName) === normalize(metro);
  }
  return false;
}

function summarizeRow(row, dates) {
  const values = new Map();
  for (const column of dates) {
    const value = numberOrNull(row[column]);
    if (value !== null) values.set(periodFor(column), value);
  }
  if (!values.size) return null;
  const periods = [...values.keys()].sort();
  const latestPeriod = periods.at(-1);
  const current = values.get(latestPeriod);
  const priorMonthPeriod = priorMonth(latestPeriod);
  const priorYearPeriod = priorYear(latestPeriod);
  const previous = values.get(priorMonthPeriod) ?? null;
  const yearAgo = values.get(priorYearPeriod) ?? null;
  return Object.freeze({
    period: latestPeriod,
    periodEnd: periodEndIso(latestPeriod),
    value: current,
    priorMonth: previous,
    priorMonthPeriod,
    yearAgo,
    yearAgoPeriod: priorYearPeriod,
    momPct: pct(current, previous),
    yoyPct: pct(current, yearAgo)
  });
}

export class ZillowZoriAdapter {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async fetchTable(scope) {
    const url = ZORI_URLS[scope];
    if (!url) throw new TypeError(`unsupported ZORI scope ${scope}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'text/csv' },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Zillow ZORI request failed: ${response.status}`);
    const rows = parseCsv(await response.text());
    if (rows.length < 2) throw new Error('Zillow ZORI CSV returned no data rows');
    const headers = rows[0];
    for (const required of ['RegionID', 'RegionName']) {
      if (!headers.includes(required)) throw new Error(`Zillow ZORI schema missing ${required}`);
    }
    const dates = dateColumns(headers);
    if (!dates.length) throw new Error('Zillow ZORI schema has no monthly date columns');
    return Object.freeze({
      url,
      dates: Object.freeze(dates),
      rows: Object.freeze(rows.slice(1).map((values) => Object.freeze(rowObject(headers, values)))),
      fetchedAt: new Date().toISOString()
    });
  }

  payloadFor(scope, geography, found, table) {
    const summary = summarizeRow(found, table.dates);
    if (!summary) return null;
    return Object.freeze({
      provider: 'Zillow Research',
      sourceId: `zori:${scope}:${found.RegionID || found.RegionName}`,
      sourceUrl: table.url,
      scope,
      geography: Object.freeze({
        level: scope,
        state: scope === 'state' ? String(geography.state).toUpperCase() : (found.StateName || null),
        metro: scope === 'metro' ? found.RegionName : null,
        regionId: found.RegionID || null
      }),
      dataset: 'Zillow Observed Rent Index (ZORI), all homes plus multifamily, smoothed, not seasonally adjusted',
      frequency: 'monthly',
      fetchedAt: table.fetchedAt,
      ...summary
    });
  }

  async fetchScope(scope, geography) {
    const table = await this.fetchTable(scope);
    const found = table.rows.find((row) => matchesGeography(scope, row, geography)) || null;
    return found ? this.payloadFor(scope, geography, found, table) : null;
  }

  async states(states = Object.keys(STATE_NAMES)) {
    const requested = [...new Set(states.map((state) => String(state).trim().toUpperCase()).filter(Boolean))];
    for (const state of requested) {
      if (!STATE_NAMES[state]) throw new TypeError(`unsupported state ${state}`);
    }
    const table = await this.fetchTable('state');
    const byName = new Map();
    for (const row of table.rows) {
      if (row.RegionName) byName.set(normalize(row.RegionName), row);
      if (row.StateName) byName.set(normalize(row.StateName), row);
    }
    return Object.freeze(requested.map((state) => {
      const row = byName.get(normalize(STATE_NAMES[state]));
      return row ? this.payloadFor('state', { state }, row, table) : null;
    }).filter(Boolean));
  }

  async metros() {
    const table = await this.fetchTable('metro');
    return Object.freeze(table.rows.map((row) => {
      if (!row.RegionName && !row.RegionID) return null;
      return this.payloadFor('metro', {
        metro: row.RegionName || null,
        regionId: row.RegionID || null
      }, row, table);
    }).filter(Boolean));
  }

  state(state) {
    return this.fetchScope('state', { state });
  }

  metro(metro, regionId = null) {
    return this.fetchScope('metro', { metro, regionId });
  }
}

export { ZORI_URLS, STATE_NAMES, parseCsv as parseZoriCsv, summarizeRow as summarizeZoriRow };
