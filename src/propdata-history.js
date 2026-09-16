function requireText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function clampLimit(value, fallback = 24, max = 160) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 2) throw new TypeError('limit must be an integer >= 2');
  return Math.min(n, max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function quarterEndIso(year, quarter) {
  const q = Number(quarter);
  const y = Number(year);
  if (!Number.isInteger(y) || ![1, 2, 3, 4].includes(q)) throw new TypeError('invalid year/quarter');
  const month = q * 3;
  const date = new Date(Date.UTC(y, month, 0, 23, 59, 59, 999));
  return date.toISOString();
}

function quarterOrdinal(year, quarter) {
  return Number(year) * 4 + Number(quarter);
}

function percentChange(current, prior) {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
  return ((current / prior) - 1) * 100;
}

function sortQuarterRows(rows) {
  return [...rows].sort((a, b) => (Number(b.year) - Number(a.year)) || (Number(b.quarter) - Number(a.quarter)));
}

function summarizeQuarterly(rows, valueField) {
  const sorted = sortQuarterRows(rows);
  if (!sorted.length) return null;
  const latest = sorted[0];
  const latestValue = numberOrNull(latest[valueField]);
  const previous = sorted.find(r => quarterOrdinal(r.year, r.quarter) === quarterOrdinal(latest.year, latest.quarter) - 1) || null;
  const yearAgo = sorted.find(r => Number(r.year) === Number(latest.year) - 1 && Number(r.quarter) === Number(latest.quarter)) || null;
  const previousValue = previous ? numberOrNull(previous[valueField]) : null;
  const yearAgoValue = yearAgo ? numberOrNull(yearAgo[valueField]) : null;
  return Object.freeze({
    latest: Object.freeze({
      year: Number(latest.year),
      quarter: Number(latest.quarter),
      periodEnd: quarterEndIso(latest.year, latest.quarter),
      value: latestValue,
      fetchedAt: latest.fetched_at ?? null
    }),
    previousQuarter: previous ? Object.freeze({ year: Number(previous.year), quarter: Number(previous.quarter), value: previousValue }) : null,
    yearAgo: yearAgo ? Object.freeze({ year: Number(yearAgo.year), quarter: Number(yearAgo.quarter), value: yearAgoValue }) : null,
    qoqPct: percentChange(latestValue, previousValue),
    yoyPct: percentChange(latestValue, yearAgoValue),
    history: Object.freeze(sorted.map(row => Object.freeze({
      year: Number(row.year),
      quarter: Number(row.quarter),
      periodEnd: quarterEndIso(row.year, row.quarter),
      value: numberOrNull(row[valueField]),
      fetchedAt: row.fetched_at ?? null,
      warning: row.warning ?? null,
      standardError: numberOrNull(row.standard_error)
    })))
  });
}

function statePayload(rows) {
  if (!rows.length) return null;
  const summary = summarizeQuarterly(rows, 'index_nsa');
  const latest = sortQuarterRows(rows)[0];
  const code = String(latest.state_code || '').toUpperCase();
  return Object.freeze({
    provider: 'Federal Housing Finance Agency',
    normalizationLayer: 'PropData',
    sourceId: `fhfa-hpi:state:${code}`,
    geography: Object.freeze({ level: 'state', state: code }),
    dataset: latest.source_dataset || 'Purchase-Only State HPI',
    frequency: latest.source_frequency || 'quarterly',
    retrievedByPropDataAt: summary.latest.fetchedAt,
    availabilitySemantics: 'current_retrieval_of_historical_series',
    pointInTimeReplaySafeBeforeRetrievedAt: false,
    ...summary
  });
}

function metroPayload(rows) {
  if (!rows.length) return null;
  const summary = summarizeQuarterly(rows, 'index_value');
  const latest = sortQuarterRows(rows)[0];
  const code = String(latest.cbsa_code);
  return Object.freeze({
    provider: 'Federal Housing Finance Agency',
    normalizationLayer: 'PropData',
    sourceId: `fhfa-hpi:metro:${code}`,
    geography: Object.freeze({ level: 'metro', cbsa: code, metro: latest.metro_name || null }),
    dataset: latest.source_dataset || 'All-Transactions Metropolitan Area HPI',
    frequency: latest.source_frequency || 'quarterly',
    retrievedByPropDataAt: summary.latest.fetchedAt,
    availabilitySemantics: 'current_retrieval_of_historical_series',
    pointInTimeReplaySafeBeforeRetrievedAt: false,
    ...summary
  });
}

function groupedLatestPayloads(rows, keyField, makePayload) {
  if (!rows.length) return Object.freeze([]);
  const latestOrdinal = quarterOrdinal(rows[0].year, rows[0].quarter);
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row[keyField] || '');
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const payloads = [];
  for (const group of grouped.values()) {
    const payload = makePayload(group);
    if (!payload) continue;
    if (quarterOrdinal(payload.latest.year, payload.latest.quarter) !== latestOrdinal) continue;
    payloads.push(payload);
  }
  payloads.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return Object.freeze(payloads);
}

export class PropDataHousingHistoryAdapter {
  constructor({ url, serviceKey, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    if (!url) throw new TypeError('PropData Supabase url is required');
    if (!serviceKey) throw new TypeError('PropData Supabase serviceKey is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.url = String(url).replace(/\/$/, '');
    this.serviceKey = serviceKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async query(table, params) {
    const url = new URL(`${this.url}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          apikey: this.serviceKey,
          authorization: `Bearer ${this.serviceKey}`,
          accept: 'application/json'
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`PropData history query failed: ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async stateHpi(state, { limit = 24 } = {}) {
    const code = requireText(state, 'state').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) throw new TypeError('state must be a 2-letter code');
    const rows = await this.query('propdata_hpi_state_quarterly', {
      state_code: `eq.${code}`,
      select: 'state_code,year,quarter,index_nsa,index_sa,warning,source_name,source_dataset,source_url,source_frequency,fetched_at',
      order: 'year.desc,quarter.desc',
      limit: clampLimit(limit)
    });
    return statePayload(rows);
  }

  async metroHpi(cbsa, { limit = 24 } = {}) {
    const code = requireText(cbsa, 'cbsa');
    if (!/^\d{5}$/.test(code)) throw new TypeError('cbsa must be a 5-digit code');
    const rows = await this.query('propdata_hpi_metro_quarterly', {
      cbsa_code: `eq.${code}`,
      select: 'metro_name,cbsa_code,year,quarter,index_value,standard_error,source_name,source_dataset,source_url,source_frequency,fetched_at',
      order: 'year.desc,quarter.desc',
      limit: clampLimit(limit)
    });
    return metroPayload(rows);
  }

  async stateSnapshots({ quarters = 5 } = {}) {
    if (!Number.isInteger(quarters) || quarters < 2 || quarters > 12) throw new TypeError('quarters must be an integer from 2 to 12');
    const rowLimit = Math.min(1000, 60 * quarters);
    const rows = await this.query('propdata_hpi_state_quarterly', {
      select: 'state_code,year,quarter,index_nsa,index_sa,warning,source_name,source_dataset,source_url,source_frequency,fetched_at',
      order: 'year.desc,quarter.desc,state_code.asc',
      limit: rowLimit
    });
    if (!rows.length) return Object.freeze([]);
    const latestOrdinal = quarterOrdinal(rows[0].year, rows[0].quarter);
    const minimumOrdinal = latestOrdinal - (quarters - 1);
    return groupedLatestPayloads(
      rows.filter((row) => quarterOrdinal(row.year, row.quarter) >= minimumOrdinal),
      'state_code',
      statePayload
    );
  }

  async metroSnapshots({ quarters = 5, pageSize = 1000, maxPages = 6 } = {}) {
    if (!Number.isInteger(quarters) || quarters < 2 || quarters > 12) throw new TypeError('quarters must be an integer from 2 to 12');
    const rows = [];
    let latestOrdinal = null;
    let stop = false;
    for (let page = 0; page < maxPages && !stop; page += 1) {
      const batch = await this.query('propdata_hpi_metro_quarterly', {
        select: 'metro_name,cbsa_code,year,quarter,index_value,standard_error,source_name,source_dataset,source_url,source_frequency,fetched_at',
        order: 'year.desc,quarter.desc,cbsa_code.asc',
        limit: pageSize,
        offset: page * pageSize
      });
      if (!batch.length) break;
      if (latestOrdinal === null) latestOrdinal = quarterOrdinal(batch[0].year, batch[0].quarter);
      const minimumOrdinal = latestOrdinal - (quarters - 1);
      for (const row of batch) {
        if (quarterOrdinal(row.year, row.quarter) < minimumOrdinal) {
          stop = true;
          break;
        }
        rows.push(row);
      }
      if (batch.length < pageSize) break;
    }
    return groupedLatestPayloads(rows, 'cbsa_code', metroPayload);
  }
}

export {
  summarizeQuarterly as summarizeHousingHistory,
  statePayload as summarizeStateHousingHistory,
  metroPayload as summarizeMetroHousingHistory
};
