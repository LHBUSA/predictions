// Automated Newsroom V1 engine: detect → evidence → generate → validate. Dry-run only until the newsroom tables
// (sql/003) are applied and publication is explicitly enabled; nothing here writes.
//   CANDIDATE → EVIDENCE_READY → GENERATED → VALIDATED → (PUBLISHED, not in V1 dry-run)   or   HELD(reason)
import { PUBLIC_STATES, FAMILIES, CATEGORY_LABEL } from '../../../../src/engine/registry.js';
import { loadEventPacket } from '../insights/packet.js';
import { buildMover, buildResolution } from './templates.js';
import { MOVER, RESOLUTION, ANOMALY, NEWSROOM_RULES } from './config.js';

const ms = (iso) => Date.parse(iso);
const ago = (now, h) => new Date(ms(now) - h * 3600000).toISOString();
const pct = (p) => (p === null || p === undefined ? null : Math.round(Number(p) * 100));
const VERTICAL = { WEATHER: 'weather', RATES: 'rates', MACRO: 'economics', FINANCE: 'business', BUSINESS: 'business', SCIENCE: 'science', SPACE: 'space', PUBLIC_HEALTH: 'public-health', ENERGY: 'energy' };
const semver = (v) => String(v).split('.').map(Number);
const older = (a, b) => { const x = semver(a); const y = semver(b); for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };

export async function storyId(parts) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Every displayed probability must resolve to a public snapshot inside the as-of packet with the same value.
export function validateStory(built, packet, cutoff) {
  const problems = [];
  const snaps = new Map(packet.outcomes.flatMap((o) => o.snapshots.map((s) => [s.id, s])));
  for (const s of snaps.values()) {
    if (!PUBLIC_STATES.includes(s.state)) problems.push(`non-public snapshot in packet: ${s.id} (${s.state})`);
    if (ms(s.t) > ms(cutoff)) problems.push(`snapshot after story cutoff: ${s.id} ${s.t} > ${cutoff}`);
  }
  for (const o of packet.outcomes) for (const m of o.market_path) if (ms(m.t) > ms(cutoff)) problems.push(`market observation after cutoff: ${o.market_id} ${m.t}`);
  if (!built.claims?.length) problems.push('no claims recorded');
  for (const c of built.claims || []) {
    const s = snaps.get(c.snapshot_id);
    if (!s) { problems.push(`claim references unknown snapshot ${c.snapshot_id}`); continue; }
    if (c.kind === 'pbe' && s.pbe !== c.value) problems.push(`PBE claim ${c.value}% != snapshot ${s.pbe}%`);
    if (c.kind === 'market_at_snapshot' && s.market !== c.value) problems.push(`market claim ${c.value}% != snapshot market ${s.market}%`);
  }
  for (const k of ['title', 'dek', 'sections', 'card']) if (!built[k]) problems.push(`missing ${k}`);
  return problems;
}

function storyDef({ id, cls, slug, packet, asOf, title }) {
  const fam = cls === 'RESOLUTION_REPORT' ? 'Resolution Report' : 'Forecast Change';
  return { slug, story_id: id, family: cls, family_label: fam, vertical: VERTICAL[packet.event.category] || 'weather', events: [packet.event.slug], primary: packet.event.slug, as_of: asOf, published_at: asOf, link_title: title, automated: true };
}

async function featuresFor(store, ids) {
  const rows = ids.length ? await store.selectIn('pred_feature_snapshots', { select: 'snapshot_id,features' }, 'snapshot_id', [...new Set(ids)], { chunkSize: 40 }) : [];
  return new Map(rows.map((r) => [r.snapshot_id, r.features]));
}

// ---------------------------------------------------------------- movers + anomaly lane
export async function detectMovers(store, { now }) {
  const out = { candidates: [], anomalies: [] };
  const rows = (await store.select('pred_forecasts', { select: 'forecast_id,contract_id,model_id,model_version,model_state,probability,captured_at,data_cutoff_at,feature_snapshot_id', captured_at: `gte.${ago(now, MOVER.lookback_hours)}` }))
    .filter((f) => PUBLIC_STATES.includes(f.model_state));
  if (!rows.length) return out;
  const contracts = await store.selectIn('pred_contracts', { select: 'contract_id,event_id,market_id,outcome_label,observation_start,event_type' }, 'contract_id', [...new Set(rows.map((r) => r.contract_id))]);
  const cById = new Map(contracts.map((c) => [c.contract_id, c]));
  const events = await store.selectIn('pred_events', { select: 'event_id,slug,canonical_question,category' }, 'event_id', [...new Set(contracts.map((c) => c.event_id))]);
  const eById = new Map(events.map((e) => [e.event_id, e]));
  const groups = new Map();
  for (const f of rows) {
    const c = cById.get(f.contract_id); if (!c) continue;
    const k = `${c.market_id}|${f.model_id}`;
    if (!groups.has(k)) groups.set(k, { c, e: eById.get(c.event_id), list: [] });
    groups.get(k).list.push({ ...f, pbe: pct(f.probability) });
  }
  for (const { c, e, list } of groups.values()) {
    list.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const base = { event_slug: e?.slug, event_title: e?.canonical_question, category: e?.category, market_id: c.market_id, outcome: c.outcome_label };
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1]; const b = list[i];
      if (a.data_cutoff_at === b.data_cutoff_at && a.model_version !== b.model_version) out.anomalies.push({ ...base, flag: 'SAME_CUTOFF_VERSION_CHANGE', detail: ANOMALY.SAME_CUTOFF_VERSION_CHANGE, from: `${a.model_id}@${a.model_version} ${a.pbe}% (${a.forecast_id})`, to: `${b.model_id}@${b.model_version} ${b.pbe}% (${b.forecast_id})`, at: b.captured_at, cutoff: b.data_cutoff_at });
      if (older(b.model_version, a.model_version)) out.anomalies.push({ ...base, flag: 'VERSION_REGRESSION', detail: ANOMALY.VERSION_REGRESSION, from: `${a.model_version} (${a.forecast_id})`, to: `${b.model_version} (${b.forecast_id})`, at: b.captured_at });
    }
    for (let j = 1; j < list.length; j += 1) {
      const s1 = list[j];
      const s0 = list.slice(0, j).reverse().find((x) => x.model_version === s1.model_version && (!MOVER.require_new_cutoff || ms(x.data_cutoff_at) < ms(s1.data_cutoff_at)) && ms(s1.captured_at) - ms(x.captured_at) >= MOVER.min_elapsed_hours * 3600000);
      if (!s0) continue;
      const delta = s1.pbe - s0.pbe;
      if (Math.abs(delta) < MOVER.min_abs_pts) continue;
      if (c.observation_start && ms(s1.captured_at) >= ms(c.observation_start) && !/^YIELD_PATH_/.test(c.event_type || '')) continue;
      out.candidates.push({ ...base, model: `${s1.model_id}@${s1.model_version}`, s0: s0.forecast_id, s1: s1.forecast_id, from: s0.pbe, to: s1.pbe, delta, t0: s0.captured_at, t1: s1.captured_at, cutoff0: s0.data_cutoff_at, cutoff1: s1.data_cutoff_at });
    }
  }
  return out;
}

// ---------------------------------------------------------------- resolution reports
export async function detectResolutions(store, { now }) {
  const res = await store.select('pred_resolutions', { select: 'resolution_id,contract_id,event_id,resolved_at,venue_result,official_outcome,sources_agree', resolved_at: `gte.${ago(now, RESOLUTION.lookback_days * 24)}` });
  const byEvent = new Map();
  for (const r of res) { if (!r.contract_id) continue; if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []); byEvent.get(r.event_id).push(r); }
  const events = byEvent.size ? await store.selectIn('pred_events', { select: 'event_id,slug,canonical_question,category' }, 'event_id', [...byEvent.keys()]) : [];
  return events.map((e) => ({ event_id: e.event_id, event_slug: e.slug, event_title: e.canonical_question, category: e.category, resolutions: byEvent.get(e.event_id) }));
}

// ---------------------------------------------------------------- run (dry-run report)
export async function runNewsroom(store, { now = new Date().toISOString(), familyResolved = {} } = {}) {
  const report = { rules: NEWSROOM_RULES, now, mode: 'DRY_RUN', thresholds: { mover: MOVER, resolution: RESOLUTION }, counts: {}, stories: [], anomalies: [], skipped_cycles: { status: 'not persisted yet — requires sql/003 pred_cycle_diagnostics; current cycle skips are logged by the Worker' } };
  const stories = [];
  const hold = (s, reason) => { s.state = 'HELD'; s.reason = reason; };

  // movers
  const mv = await detectMovers(store, { now });
  const groups = new Map();
  for (const a of mv.anomalies) {
    const k = `${a.event_slug}|${a.flag}|${a.at.slice(0, 16)}`;
    const g = groups.get(k) || { event_slug: a.event_slug, category: a.category, flag: a.flag, detail: a.detail, at: a.at, cutoff: a.cutoff ?? null, contracts: 0, examples: [], state: 'HELD', reason: 'ANOMALY_LANE: held until evidence proves the cause (never auto-published)' };
    g.contracts += 1; if (g.examples.length < 2) g.examples.push({ outcome: a.outcome, from: a.from, to: a.to });
    groups.set(k, g);
  }
  report.anomalies = [...groups.values()].sort((x, y) => x.at.localeCompare(y.at));
  report.anomaly_contract_flags = mv.anomalies.length;
  const byEventDay = new Map();
  const sorted = [...mv.candidates].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  for (const c of sorted) {
    const id = await storyId(['MOVER', c.market_id, c.s0, c.s1]);
    const s = { story_id: id, class: 'FORECAST_MOVER', state: 'CANDIDATE', trigger: c, event_slug: c.event_slug };
    stories.push(s);
    if (stories.some((x) => x !== s && x.story_id === id)) { hold(s, 'DUPLICATE_SUPPRESSED'); continue; }
    const kept = (byEventDay.get(c.event_slug) || []);
    if (kept.some((k) => Math.abs(ms(k.t1) - ms(c.t1)) < MOVER.cooldown_hours * 3600000)) { hold(s, `COOLDOWN: event already has a mover within ${MOVER.cooldown_hours} h`); continue; }
    const today = stories.filter((x) => x.class === 'FORECAST_MOVER' && x.state === 'VALIDATED' && x.trigger.t1.slice(0, 10) === c.t1.slice(0, 10)).length;
    if (today >= MOVER.desk_cap_per_day) { hold(s, `DESK_CAP: ${MOVER.desk_cap_per_day} movers already on ${c.t1.slice(0, 10)}`); continue; }
    const packet = await loadEventPacket(store, c.event_slug, c.t1);
    if (!packet) { hold(s, 'MISSING_EVIDENCE: event packet'); continue; }
    s.state = 'EVIDENCE_READY';
    const o = packet.outcomes.find((x) => x.market_id === c.market_id);
    const features = await featuresFor(store, (o?.snapshots || []).filter((x) => [c.s0, c.s1].includes(x.id)).map((x) => x.feature_snapshot_id).filter(Boolean));
    const built = buildMover({ packet, marketId: c.market_id, s0Id: c.s0, s1Id: c.s1, features });
    if (!built.ok) { hold(s, /LARGE_JUMP|NO_INPUT/.test(built.reason) ? `ANOMALY_HOLD: ${built.reason} — ${ANOMALY[built.reason] || ''}` : `MISSING_EVIDENCE: ${built.reason}`); continue; }
    s.state = 'GENERATED';
    const problems = validateStory(built, packet, c.t1);
    if (problems.length) { hold(s, `VALIDATION_FAILED: ${problems.join('; ')}`); continue; }
    s.state = 'VALIDATED';
    s.slug = `${c.event_slug}-pbe-move-${c.t1.slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2')}`;
    s.def = storyDef({ id, cls: 'FORECAST_MOVER', slug: s.slug, packet, asOf: c.t1, title: built.title });
    s.built = built; s.packet = packet;
    byEventDay.set(c.event_slug, [...kept, c]);
  }

  // resolution reports
  for (const r of await detectResolutions(store, { now })) {
    const id = await storyId(['RESOLUTION', r.event_id, ...r.resolutions.map((x) => x.resolution_id).sort()]);
    const s = { story_id: id, class: 'RESOLUTION_REPORT', state: 'CANDIDATE', trigger: { event_slug: r.event_slug, event_title: r.event_title, resolutions: r.resolutions.length }, event_slug: r.event_slug };
    stories.push(s);
    const asOf = r.resolutions.map((x) => x.resolved_at).sort().at(-1);
    const packet = await loadEventPacket(store, r.event_slug, new Date(ms(asOf) + 1000).toISOString());
    if (!packet) { hold(s, 'MISSING_EVIDENCE: event packet'); continue; }
    const ambiguous = packet.outcomes.filter((o) => o.contract.normalization_status === 'HOLD_RESOLUTION_AMBIGUOUS');
    if (ambiguous.length) { hold(s, `RESOLUTION_AMBIGUOUS: ${ambiguous.length} contract(s) HOLD_RESOLUTION_AMBIGUOUS`); continue; }
    const modeled = packet.outcomes.filter((o) => o.snapshots.length);
    if (!modeled.length) { hold(s, 'NOT_MODELED: no public PBE forecast for this event (market monitoring)'); continue; }
    const waiting = modeled.filter((o) => !o.resolution);
    if (waiting.length) { s.reason = `WAITING: ${waiting.length} of ${modeled.length} modeled contracts not yet resolved`; continue; }
    s.state = 'EVIDENCE_READY';
    const fam = FAMILIES.find((f) => modeled[0].snapshots[0].model_id === f.id);
    const built = buildResolution({ packet, familyResolved: fam ? familyResolved[fam.id] ?? null : null });
    if (!built.ok) { hold(s, /scored|designation/.test(built.reason) ? `WAITING: ${built.reason}` : `RESOLUTION_PROVENANCE: ${built.reason}`); continue; }
    s.state = 'GENERATED';
    const problems = validateStory(built, packet, packet.as_of);
    if (problems.length) { hold(s, `VALIDATION_FAILED: ${problems.join('; ')}`); continue; }
    s.state = 'VALIDATED';
    s.slug = `${r.event_slug}-resolution-report`;
    s.def = storyDef({ id, cls: 'RESOLUTION_REPORT', slug: s.slug, packet, asOf: packet.as_of, title: built.title });
    s.built = built; s.packet = packet;
  }

  for (const s of stories) {
    const k = `${s.class}:${s.state}`;
    report.counts[k] = (report.counts[k] || 0) + 1;
  }
  report.stories = stories;
  return report;
}

// JSON view of a story's exact evidence packet (what the owner reviews before publication is enabled).
export function evidenceView(s) {
  const p = s.packet;
  return {
    story_id: s.story_id, class: s.class, state: s.state, reason: s.reason ?? null, slug: s.slug ?? null, trigger: s.trigger,
    story_cutoff: s.def?.as_of ?? null, title: s.built?.title ?? null,
    claims: s.built?.claims ?? [],
    packet: p ? {
      as_of: p.as_of, event: p.event,
      outcomes: p.outcomes.filter((o) => o.snapshots.length || o.resolution).map((o) => ({
        market_id: o.market_id, label: o.label, contract_id: o.contract.contract_id, normalization: o.contract.normalization_status,
        snapshots: o.snapshots.map((x) => ({ id: x.id, captured_at: x.t, model: x.model, state: x.state, pbe: x.pbe, market_at_capture: x.market, cutoff: x.cutoff, roles: x.roles, features_sha256: x.sha })),
        market_observations: o.market_path.length, last_market: o.market_path.at(-1) ?? null,
        resolution: o.resolution ? { resolution_id: o.resolution.resolution_id, venue_result: o.resolution.venue_result, official_outcome: o.resolution.official_outcome, official_value: o.resolution.official_value, sources_agree: o.resolution.sources_agree, resolved_at: o.resolution.resolved_at, official_source: o.resolution.official_source } : null,
        scores: o.scores.map((x) => ({ designation: x.designation, method: x.scoring_method, pbe: Number(x.score), market: x.benchmark_score === null ? null : Number(x.benchmark_score) })),
      })),
    } : null,
  };
}

export { CATEGORY_LABEL };
