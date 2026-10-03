// NWS Daily Climate Report (CLI) values — the independent verification source for weather contracts.
// Read through the IEM CLI archive (parsed NWS CDUS4x text products, each row carries the NWS product id).
// Trace is reported as 'T' (= 0 for contract purposes); 'M' is missing.

export const IEM_CLI_JSON = 'https://mesonet.agron.iastate.edu/json/cli.py';

export function parseCliNumber(v) {
  if (v === 'T') return Object.freeze({ kind: 'trace', value: 0 });
  if (v === null || v === undefined || v === 'M' || v === '') return Object.freeze({ kind: 'missing', value: null });
  const n = Number(v);
  return Number.isFinite(n) ? Object.freeze({ kind: 'value', value: n }) : Object.freeze({ kind: 'missing', value: null });
}

export function cliDay(rows, date) {
  const r = rows.find((x) => x.valid === date);
  if (!r) return null;
  return Object.freeze({
    date,
    station: r.station,
    product_id: r.product,
    product_url: r.product ? `https://mesonet.agron.iastate.edu/p.php?pid=${r.product}` : null,
    high: parseCliNumber(r.high),
    low: parseCliNumber(r.low),
    precip: parseCliNumber(r.precip),
  });
}

// Official outcome of a normalized weather contract from a CLI day. Null when the value is not yet reported.
export function officialOutcome(contract, day) {
  if (!day) return null;
  if (contract.event_type === 'PRECIP_ANY') {
    // contract: trace and missing count as 0 -> NO
    const yes = day.precip.kind === 'value' && day.precip.value > 0;
    return { outcome: yes ? 'YES' : 'NO', value: day.precip.kind === 'value' ? day.precip.value : 0, units: 'in', basis: day.precip.kind };
  }
  if (contract.event_type === 'MAX_TEMP_BUCKET') {
    if (day.high.kind !== 'value') return null;
    const t = day.high.value;
    const lo = contract.threshold_low === null ? null : Number(contract.threshold_low);
    const hi = contract.threshold_high === null ? null : Number(contract.threshold_high);
    const yes = contract.comparator === 'less' ? t < hi : contract.comparator === 'greater' ? t > lo : t >= lo && t <= hi;
    return { outcome: yes ? 'YES' : 'NO', value: t, units: 'degF', basis: 'value' };
  }
  return null;
}

export async function fetchCliYear({ icao, year }, { fetchImpl = globalThis.fetch, userAgent }) {
  const url = `${IEM_CLI_JSON}?station=${encodeURIComponent(icao)}&year=${year}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': userAgent } });
  if (!res.ok) throw new Error(`IEM CLI ${icao} ${res.status}`);
  const body = await res.json();
  return { url, rows: body.results || [] };
}
