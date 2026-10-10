// Indicative SPOT reference prices for gold, silver and platinum from Gold-API.com (issue #78, owner direction 2026-10-10).
// Pure helpers + a bounded collector. Rights: Gold-API.com Terms of Service (effective 2026-09-10) §9 "Commercial use of the
// API is always permitted, including use in web applications, mobile apps, and third-party websites" — public and member
// display. §4 bans abusive request rates: we call each symbol at most once per collection tick (every 5 min) from the
// server, never per visitor. §5 no accuracy guarantee and the provider does not disclose its upstream (it fails over
// between data providers), so every display says INDICATIVE and never implies the LBMA benchmark/fixing.
// Verified 2026-10-10: XAU/XAG/XPT respond from Cloudflare's edge (HTTP 200, ~60-160 ms); updatedAt is the provider's
// refresh time (it advances even when spot markets are closed), so it is labelled as such, never as a trade time.
import { SPOT } from './metals.js';

export const GOLDAPI = Object.freeze({
  id: 'gold-api', name: 'Gold-API.com', url: 'https://gold-api.com/', terms: 'https://gold-api.com/terms', terms_effective: '2026-09-10',
  rights: Object.freeze({ public: true, paid: true }),
  rights_note: 'Gold-API.com Terms of Service §9 (effective 2026-09-10): commercial use permitted, including websites.',
  basis: 'INDICATIVE_SPOT_REFERENCE', upstream: 'undisclosed by the provider (fails over between data providers)',
  endpoint: (code) => `https://api.gold-api.com/price/${code}`,
});
export const COLLECT_EVERY_MIN = 5;
export const HEARTBEAT_MIN = 60;      // write an unchanged price at most hourly (bounds weekend rows)
export const MAX_JUMP = 0.20;         // a >20% move vs our last stored value is held, never stored
export const STALE_MIN = 15;          // market open and no fresh capture for 15 min -> STALE
export const UNAVAILABLE_H = 6;       // market open and nothing for 6 h -> no value shown

// OTC spot metals trade Sunday 18:00 ET -> Friday 17:00 ET with a daily 17:00-18:00 ET break (Mon-Thu).
export function spotMarketOpen(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const m = Number(p.hour) * 60 + Number(p.minute); const wd = p.weekday;
  if (wd === 'Sat') return false;
  if (wd === 'Sun') return m >= 18 * 60;
  if (wd === 'Fri') return m < 17 * 60;
  return !(m >= 17 * 60 && m < 18 * 60);
}
export const spotDue = (iso) => new Date(iso).getUTCMinutes() % COLLECT_EVERY_MIN === 2;

// Validate one provider response for instrument `inst` (from SPOT). Returns { ok, quote } or { ok:false, why }.
export function parseGoldApi(inst, json, nowIso) {
  if (!json || typeof json !== 'object') return { ok: false, why: 'not_json' };
  if (json.symbol !== inst.code) return { ok: false, why: `symbol_mismatch:${json.symbol}` };
  if (json.currency !== 'USD') return { ok: false, why: `currency:${json.currency}` };
  const price = Number(json.price);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, why: 'bad_price' };
  const t = Date.parse(json.updatedAt);
  if (!Number.isFinite(t)) return { ok: false, why: 'bad_timestamp' };
  if (t - Date.parse(nowIso) > 5 * 60000) return { ok: false, why: 'timestamp_in_future' };
  return { ok: true, quote: { code: inst.code, price, provider_updated_at: new Date(t).toISOString(), name: json.name || inst.label } };
}

export function observationRow(inst, q, capturedIso) {
  return {
    observation_key: `goldapi:${inst.code}:${capturedIso.slice(0, 16)}`,
    provider: GOLDAPI.id, source_id: `goldapi:${inst.code}`, source_class: 'licensed',
    observed_at: q.provider_updated_at, available_at: capturedIso, captured_at: capturedIso,
    value: q.price, units: 'USD/ozt',
    data: { code: inst.code, name: q.name, provider_updated_at: q.provider_updated_at, basis: GOLDAPI.basis, note: 'Indicative spot reference; not the LBMA benchmark.' },
    provenance: { url: GOLDAPI.endpoint(inst.code), terms: GOLDAPI.terms, terms_effective: GOLDAPI.terms_effective, upstream: GOLDAPI.upstream },
  };
}

// One bounded collection tick: 3 sequential provider calls, validation, sanity vs our last value, write on change or hourly.
export async function collectSpot({ store, nowIso, fetchImpl = fetch }) {
  const out = {};
  const last = await latestRows(store, nowIso, 2);
  const rows = [];
  for (const inst of SPOT) {
    let parsed;
    try {
      const r = await fetchImpl(GOLDAPI.endpoint(inst.code), { headers: { accept: 'application/json', 'user-agent': 'PropBetEdge-Predictions/1.0 (+https://predictions.propbetedge.ai/markets/metals/)' } });
      parsed = r.ok ? parseGoldApi(inst, await r.json(), nowIso) : { ok: false, why: `http_${r.status}` };
    } catch (e) { parsed = { ok: false, why: `fetch:${String(e?.message || e).slice(0, 80)}` }; }
    if (!parsed.ok) { out[inst.code] = { skipped: parsed.why }; continue; }
    const prev = last[inst.code]?.[0];
    if (prev && Math.abs(parsed.quote.price / Number(prev.value) - 1) > MAX_JUMP) { out[inst.code] = { held: 'jump_over_20pct', price: parsed.quote.price, last: Number(prev.value) }; continue; }
    const ageMin = prev ? (Date.parse(nowIso) - Date.parse(prev.captured_at)) / 60000 : Infinity;
    if (prev && Number(prev.value) === parsed.quote.price && ageMin < HEARTBEAT_MIN) { out[inst.code] = { unchanged: true }; continue; }
    rows.push(observationRow(inst, parsed.quote, nowIso)); out[inst.code] = { written: parsed.quote.price };
  }
  if (rows.length) await store.write('pred_source_observations', rows, { conflictColumn: 'observation_key' });
  return out;
}

// Latest `n` stored rows per code within the last 48 h (newest first).
export async function latestRows(store, nowIso, n = 1) {
  const since = new Date(Date.parse(nowIso) - 48 * 3600000).toISOString();
  const rows = await store.select('pred_source_observations', { select: 'source_id,observed_at,captured_at,value,data', provider: `eq.${GOLDAPI.id}`, captured_at: `gte.${since}` }, { order: 'captured_at.desc', limit: 2000 });
  const by = {};
  for (const r of rows) { const code = r.source_id.split(':')[1]; (by[code] ||= []).push(r); }
  for (const k of Object.keys(by)) by[k] = by[k].slice(0, Math.max(n, by[k].length));
  return by;
}

// Display state for one metal from its stored rows (newest first). Never invents a value.
export function spotView(rows, nowIso, { on = true } = {}) {
  if (!on) return { state: 'OFF', value: null, label: 'PRICE UNAVAILABLE' };
  const cur = rows?.[0];
  if (!cur) return { state: 'AWAITING_FIRST_OBSERVATION', value: null, label: 'AWAITING FIRST OBSERVATION' };
  const open = spotMarketOpen(nowIso);
  const ageMin = (Date.parse(nowIso) - Date.parse(cur.captured_at)) / 60000;
  if (open && ageMin > UNAVAILABLE_H * 60) return { state: 'UNAVAILABLE', value: null, label: 'PRICE UNAVAILABLE', last_captured_at: cur.captured_at };
  const target = Date.parse(nowIso) - 24 * 3600000;
  const ref = rows.find((r) => Math.abs(Date.parse(r.captured_at) - target) <= 2 * 3600000) || null;
  const value = Number(cur.value);
  return {
    state: !open ? 'MARKET_CLOSED' : ageMin > STALE_MIN ? 'STALE' : 'INDICATIVE',
    label: !open ? 'SPOT MARKET CLOSED · LAST INDICATIVE PRICE' : ageMin > STALE_MIN ? 'STALE · LAST INDICATIVE PRICE' : 'INDICATIVE SPOT REFERENCE',
    value, captured_at: cur.captured_at, provider_updated_at: cur.observed_at,
    change_24h: ref ? value / Number(ref.value) - 1 : null, ref_captured_at: ref?.captured_at ?? null,
  };
}
