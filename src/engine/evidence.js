// EVIDENCE PACKET (pbe-evidence/1). The frozen, factual basis of one published PBE forecast, assembled ONLY from
// stored append-only rows: the forecast (pred_forecasts), its feature snapshot (pred_feature_snapshots) and the
// normalized contract (pred_contracts). Nothing here is generated after the fact: every number in a driver is the
// stored feature value, every source is the stored provenance entry, and the packet hash is over canonical
// (sorted-key) JSON so the same rows always give the same packet. Market / venue data never enters a packet —
// venues are attached later, beside it, as benchmarks.
import { findMarketKeys } from './leakage.js';

export const EVIDENCE_SCHEMA = 'pbe-evidence/1';

const pctOf = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
const num = (v, d = 2) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : +Number(v).toFixed(d));

// 'temp-nbm-v1.1:CLIPHL:le30h:station:n=1820' -> 'lead <=30 h · this station · 1,820 past days' (display only)
function guidanceTable(v) {
  const [, , bucket, source, n] = String(v).split(':');
  const lead = /^le(\d+)h$/.exec(bucket || '')?.[1];
  const count = Number(String(n || '').replace('n=', ''));
  return [[lead ? `lead ≤${lead} h` : bucket, source === 'station' ? 'this station' : source ? `${source} table` : null, Number.isFinite(count) && count ? `${count.toLocaleString('en-US')} past days` : null].filter(Boolean).join(' · '), ''];
}

// Material factual drivers per model family: stored feature name -> public label + display. Order = materiality.
// Only MODEL INPUTS appear here (context-only evidence such as the NWS gridpoint forecast is listed separately).
export const DRIVER_SPECS = Object.freeze({
  'pbe-weather-precip': [
    { feature: 'nbm_pop_union', label: 'National Blend of Models: chance of rain in the climate day', show: (v) => [pctOf(v), '%'], source: /National Blend/ },
    { feature: 'mos_pop_union', label: 'GFS MOS: chance of rain in the climate day', show: (v) => [pctOf(v), '%'], source: /GFS MOS/ },
    { feature: 'climatology_rate_1991_2020', label: '30-year station climatology (1991-2020)', show: (v) => [pctOf(v), '%'], source: /climatology/i },
    { feature: 'run_lead_hours', label: 'Guidance lead time to the climate day', show: (v) => [num(v, 0), ' h'], source: /GFS MOS/ },
  ],
  'pbe-weather-maxtemp': [
    { feature: 'nbm_max_temp_guidance_f', label: 'National Blend of Models high', show: (v) => [v, '°F'], source: /National Blend/ },
    { feature: 'mos_max_temp_guidance_f', label: 'GFS MOS guidance high', show: (v) => [v, '°F'], source: /GFS MOS/ },
    { feature: 'nbm_max_temp_spread_f', label: 'Blend spread (uncertainty in the guidance)', show: (v) => [v, '°F'], source: /National Blend/ },
    { feature: 'guidance_error_table', label: 'Station guidance-error history (reported minus guidance)', show: guidanceTable, source: /GFS MOS/ },
    { feature: 'run_lead_hours', label: 'Guidance lead time to the climate day', show: (v) => [num(v, 0), ' h'], source: /GFS MOS/ },
  ],
  'pbe-rates-path': [
    { feature: 'last_published_yield', label: 'Latest official par yield', show: (v) => [num(v, 2), '%'], source: /Treasury/ },
    { feature: 'period_running_extreme', label: 'Period extreme so far', show: (v) => [v === null ? null : num(v, 2), '%'], source: /Treasury/ },
    { feature: 'remaining_business_days', label: 'Business days left in the period', show: (v) => [v, ''], source: /Treasury/ },
    { feature: 'ewma_daily_sigma', label: 'Daily yield volatility (EWMA)', show: (v) => [num(Number(v) * 100, 1), ' bp'], source: /Treasury/ },
    { feature: 'last_published_date', label: 'Latest published value date', show: (v) => [v, ''], source: /Treasury/ },
  ],
  'pbe-fed-decision': [
    { feature: 'cmt6m_minus_target_mid', label: '6-month Treasury minus target-range midpoint', show: (v) => [num(v, 2), ' pp'], source: /DGS6MO|FRED/ },
    { feature: 'cmt6m_change_since_last_decision', label: '6-month Treasury change since last decision', show: (v) => [num(v, 2), ' pp'], source: /DGS6MO|FRED/ },
    { feature: 'previous_decision_direction', label: 'Previous FOMC decision', show: (v) => [v, ''], source: /FOMC/ },
    { feature: 'horizon_days', label: 'Days to the meeting', show: (v) => [v, ''], source: /FOMC/ },
  ],
});

// Canonical JSON: object keys sorted at every depth (jsonb reorders keys, so byte order of stored rows is not stable).
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isInput = (p) => /model input/i.test(p?.role || '');
const availableAt = (p) => p?.available_at || null;

export function driversFor(modelId, features, provenance = []) {
  const spec = DRIVER_SPECS[modelId] || [];
  const out = [];
  for (const s of spec) {
    if (!(s.feature in features)) continue;
    const v = features[s.feature];
    if (v === null || v === undefined) continue;
    const [display, unit] = s.show(v);
    if (display === null || display === undefined) continue;
    const src = provenance.find((p) => isInput(p) && s.source.test(`${p.source} ${p.provider}`)) || null;
    out.push({ feature: s.feature, label: s.label, value: v, display: String(display), unit, source: src ? { name: src.source, provider: src.provider, available_at: availableAt(src), run: src.run ?? null, url: src.url ?? null } : null });
    if (out.length === 5) break;
  }
  return out;
}

// Integrity rules (all must hold for a packet to back a decision):
//  - every MODEL INPUT with a stated availability time was available at or before data_cutoff_at;
//  - data_cutoff_at <= forecast captured_at (no fact from the future of the publication);
//  - the stored feature vector carries no venue-derived key (same denylist as the model guard + DB CHECK);
//  - the feature snapshot is the one the forecast names, and its cutoff equals the forecast data cutoff.
export function checkIntegrity({ forecast, snapshot }) {
  const violations = [];
  const cutoff = Date.parse(forecast.data_cutoff_at);
  const captured = Date.parse(forecast.captured_at);
  if (Number.isNaN(cutoff)) violations.push({ rule: 'data_cutoff_missing' });
  if (!Number.isNaN(cutoff) && cutoff > captured) violations.push({ rule: 'cutoff_after_publication', data_cutoff_at: forecast.data_cutoff_at, captured_at: forecast.captured_at });
  for (const p of forecast.provenance || []) {
    const a = availableAt(p);
    if (isInput(p) && a && Date.parse(a) > cutoff) violations.push({ rule: 'source_after_cutoff', source: p.source, available_at: a, data_cutoff_at: forecast.data_cutoff_at });
    // context-only evidence still may not post-date the publication
    const issued = p.updated_at || a;
    if (issued && Date.parse(issued) > captured) violations.push({ rule: 'evidence_after_publication', source: p.source, at: issued });
  }
  if (!snapshot) violations.push({ rule: 'feature_snapshot_missing', feature_snapshot_id: forecast.feature_snapshot_id });
  else {
    if (snapshot.snapshot_id && forecast.feature_snapshot_id && snapshot.snapshot_id !== forecast.feature_snapshot_id) violations.push({ rule: 'feature_snapshot_mismatch' });
    if (snapshot.cutoff_at && !Number.isNaN(cutoff) && Date.parse(snapshot.cutoff_at) !== cutoff) violations.push({ rule: 'snapshot_cutoff_mismatch', snapshot_cutoff_at: snapshot.cutoff_at, data_cutoff_at: forecast.data_cutoff_at });
    const leaks = findMarketKeys(snapshot.features || {});
    if (leaks.length) violations.push({ rule: 'market_key_in_features', paths: leaks.slice(0, 5) });
  }
  return { ok: violations.length === 0, violations };
}

// Build the packet for one forecast. `limitations` = the model family's public known limitations.
export async function buildEvidencePacket({ event, contract, forecast, snapshot, limitations = [] }) {
  const features = snapshot?.features || {};
  const provenance = forecast.provenance || [];
  const integrity = checkIntegrity({ forecast, snapshot });
  const packet = {
    schema: EVIDENCE_SCHEMA,
    forecast_id: forecast.forecast_id,
    canonical_event_id: event?.event_id ?? forecast.event_id ?? null,
    canonical_contract_id: contract?.contract_id ?? forecast.contract_id,
    venue_market_id: contract?.market_id ?? forecast.market_id ?? null,
    question: event?.canonical_question ?? null,
    outcome_label: contract?.outcome_label ?? null,
    yes_condition: contract?.yes_condition ?? null,
    resolution: contract ? { authority: contract.resolution_authority ?? null, dataset: contract.resolution_dataset ?? null, verification: contract.verification_dataset ?? null, window: contract.observation_start ? { start: contract.observation_start, end: contract.observation_end, timezone: contract.timezone ?? null } : null, rules_sha256: contract.rules_sha256 ?? null, normalizer: contract.normalizer_version ?? null } : null,
    model: { family: forecast.model_id, version: forecast.model_version, state: forecast.model_state, tier: forecast.explanation?.model_tier ?? null },
    data_cutoff_at: forecast.data_cutoff_at,
    published_at: forecast.captured_at,
    feature_snapshot_id: forecast.feature_snapshot_id,
    features_sha256: forecast.features_sha256,
    features,
    sources: provenance.map((p) => ({ name: p.source, provider: p.provider ?? null, role: p.role ?? null, available_at: availableAt(p), run: p.run ?? null, latest_value_date: p.latest_value_date ?? null, issued_at: p.updated_at ?? null, station: p.station ?? null, url: p.url ?? null })),
    source_observation_keys: snapshot?.source_observation_keys ?? [],
    probability: Number(forecast.probability),
    confidence: forecast.confidence ?? null,
    drivers: driversFor(forecast.model_id, features, provenance),
    context: (forecast.explanation?.evidence ?? []).map((x) => ({ label: x.label, value: x.value, unit: x.unit, detail: x.detail ?? null })),
    limitations,
    integrity,
  };
  return { packet, sha256: await sha256(canonicalJson(factualCore(packet))) };
}

// The evidence hash covers FACTS only (stored values, sources, times, ids, integrity), never presentation: driver labels
// and display strings are excluded so wording fixes can never change a stored evidence hash (pred_decisions).
export function factualCore(packet) {
  return { ...packet, drivers: packet.drivers.map((d) => ({ feature: d.feature, value: d.value, source: d.source })) };
}

// Deterministic one-line summary built ONLY from packet drivers (no free text, no LLM).
export function driverSentence(packet) {
  const d = packet.drivers.slice(0, 3).map((x) => `${x.label} ${x.display}${x.unit}`);
  const cut = packet.data_cutoff_at ? `${new Date(packet.data_cutoff_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : null;
  return d.length ? `${d.join('; ')}.${cut ? ` Data cutoff ${cut}.` : ''}` : null;
}
