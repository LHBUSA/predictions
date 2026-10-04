// Newsroom persistence (sql/003 + sql/005) and the published read path.
// AUTOMATIC PUBLICATION (owner 2026-10-04): the 15-minute engine cron runs the newsroom after the engine cycle and
// publishes every VALIDATED FORECAST_MOVER / RESOLUTION_REPORT (autoPublish below, kill switch NEWSROOM_AUTO_PUBLISH).
// The anomaly lane and HELD stories are never published. The admin route is an emergency/manual tool only.
// Publication is deterministic (story id = hash of its trigger), append-only (DB triggers), idempotent (story_id PK,
// unique trigger_key/slug, one PUBLISHED transition per story, transition graph) and evidence-backed: a published
// story stores its trigger, cutoff and claims and is rebuilt from the immutable ledger and re-validated on every
// render (a story that no longer validates is not served). No LLM text anywhere.
import { loadEventPacket } from '../insights/packet.js';
import { buildMover, buildResolution } from './templates.js';
import { validateStory } from './engine.js';
import { NEWSROOM_RULES, MOVER } from './config.js';

const VERTICAL = { WEATHER: 'weather', RATES: 'rates', MACRO: 'economics', FINANCE: 'business', BUSINESS: 'business', SCIENCE: 'science', SPACE: 'space', PUBLIC_HEALTH: 'public-health', ENERGY: 'energy' };
const FAMILY = { FORECAST_MOVER: 'Forecast Change', RESOLUTION_REPORT: 'Resolution Report' };
export const PUBLISHABLE_CLASSES = Object.freeze(['FORECAST_MOVER', 'RESOLUTION_REPORT']);
const CHAIN = ['CANDIDATE', 'EVIDENCE_READY', 'GENERATED', 'VALIDATED', 'PUBLISHED'];
const isConflict = (e) => /duplicate|unique|23505|cannot move from|cannot be PUBLISHED/i.test(e?.message || '');

export async function storyState(store, storyIds) {
  if (!storyIds.length) return new Map();
  const rows = await store.selectIn('pred_newsroom_transitions', { select: 'story_id,state,at,reason,seq' }, 'story_id', storyIds);
  const out = new Map();
  for (const r of rows.sort((a, b) => (a.seq != null && b.seq != null ? a.seq - b.seq : a.at.localeCompare(b.at)))) {
    const cur = out.get(r.story_id) || { states: [] };
    cur.states.push(r.state); cur.latest = r.state; cur.at = r.at;
    if (r.state === 'PUBLISHED') cur.published_at = r.at;
    out.set(r.story_id, cur);
  }
  return out;
}

// The immutable story row: trigger, cutoff, claims, and everything needed to rebuild the story identically later.
function storyRow(s) {
  const t = s.trigger;
  const base = { story_id: s.story_id, story_class: s.class, slug: s.slug, event_ids: [s.packet.event.id], story_cutoff: s.def.as_of, rules_version: NEWSROOM_RULES };
  if (s.class === 'FORECAST_MOVER') {
    return { ...base, trigger_key: ['MOVER', t.market_id, t.s0, t.s1].join('|'), evidence: { trigger: t, claims: s.built.claims, snapshot_ids: [t.s0, t.s1], packet_as_of: s.packet.as_of, title_at_publication: s.built.title } };
  }
  return { ...base, trigger_key: ['RESOLUTION', s.packet.event.id, ...(s.resolution_ids || [])].join('|'),
    // family_resolved is frozen at publication so the rebuilt text never drifts as the live record grows
    evidence: { trigger: t, claims: s.built.claims, resolution_ids: s.resolution_ids || [], family_resolved: s.family_resolved ?? null, packet_as_of: s.packet.as_of, title_at_publication: s.built.title } };
}

// Persist + publish one VALIDATED story. Each transition is its own request so the DB guards see a strictly later
// state. Idempotent and resumable: an already-published story is a no-op; a partially persisted chain (crash or a
// concurrent cycle) resumes from its latest state; a concurrent insert that loses the race reports a conflict.
export async function publishStory(store, s, { by = 'admin-manual', note = null, detail = {} } = {}) {
  if (s.state !== 'VALIDATED') return { ok: false, error: `story is ${s.state}${s.reason ? ` (${s.reason})` : ''}, not VALIDATED` };
  if (!PUBLISHABLE_CLASSES.includes(s.class)) return { ok: false, error: `class ${s.class} is never published` };
  const existing = (await storyState(store, [s.story_id])).get(s.story_id);
  if (existing?.published_at) return { ok: false, error: 'already_published', published_at: existing.published_at };
  if (existing && !CHAIN.includes(existing.latest)) return { ok: false, error: `story persisted in state ${existing.latest}; not resumable` };
  if (!existing) {
    try { await store.write('pred_newsroom_stories', storyRow(s)); } catch (e) { if (!isConflict(e)) throw e; return { ok: false, error: 'already_persisted_concurrently' }; }
  }
  const start = existing ? CHAIN.indexOf(existing.latest) + 1 : 0;
  for (const state of CHAIN.slice(start)) {
    const d = state === 'VALIDATED' ? { problems: [] } : state === 'PUBLISHED' ? { by, note, ...detail } : {};
    try { await store.write('pred_newsroom_transitions', { story_id: s.story_id, state, detail: d }); } catch (e) { if (!isConflict(e)) throw e; return { ok: false, error: `concurrent_transition_at_${state}` }; }
    await new Promise((r) => setTimeout(r, 5));
  }
  const after = (await storyState(store, [s.story_id])).get(s.story_id);
  return { ok: Boolean(after?.published_at), story_id: s.story_id, slug: s.slug, class: s.class, states: after?.states ?? [], published_at: after?.published_at ?? null };
}

// AUTO-PUBLICATION over one newsroom report (runNewsroom output). Publishes VALIDATED movers and resolution reports;
// never HELD, never the anomaly lane, never anything with incomplete evidence (only VALIDATED reaches here). The
// existing duplicate / cooldown / desk-cap rules are applied by runNewsroom; the desk cap is re-checked here against
// movers already PUBLISHED on the same UTC day as defense in depth (never a looser rule).
export async function autoPublish(store, report, { cycleAt, engineCompletedAt = null } = {}) {
  const out = { considered: 0, published: [], skipped: [] };
  const publishedToday = new Map();
  const pubRows = await store.select('pred_newsroom_stories', { select: 'story_id,story_class,story_cutoff', story_class: 'eq.FORECAST_MOVER' }).catch(() => []);
  const pubState = await storyState(store, pubRows.map((r) => r.story_id));
  for (const r of pubRows) if (pubState.get(r.story_id)?.published_at) { const day = r.story_cutoff.slice(0, 10); publishedToday.set(day, (publishedToday.get(day) || 0) + 1); }
  for (const s of report.stories) {
    if (s.state !== 'VALIDATED' || !PUBLISHABLE_CLASSES.includes(s.class)) continue;
    out.considered += 1;
    if (s.class === 'FORECAST_MOVER') {
      const day = s.trigger.t1.slice(0, 10);
      if ((publishedToday.get(day) || 0) >= MOVER.desk_cap_per_day) { out.skipped.push({ story_id: s.story_id, reason: `DESK_CAP ${day}` }); continue; }
    }
    const r = await publishStory(store, s, { by: 'auto-cron', detail: { cycle_at: cycleAt, engine_completed_at: engineCompletedAt, rules: NEWSROOM_RULES } });
    if (r.ok) {
      out.published.push({ story_id: s.story_id, class: s.class, slug: s.slug, url: `https://predictions.propbetedge.ai/insights/${s.slug}`, published_at: r.published_at });
      if (s.class === 'FORECAST_MOVER') { const day = s.trigger.t1.slice(0, 10); publishedToday.set(day, (publishedToday.get(day) || 0) + 1); }
    } else out.skipped.push({ story_id: s.story_id, reason: r.error });
  }
  if (out.published.length) await publishedNewsroomStories(store, { fresh: true });
  return out;
}

let cache = { at: 0, items: [] };
const TTL = 5 * 60 * 1000;

async function rebuild(store, row, loadPacket = loadEventPacket) {
  const t = row.evidence.trigger;
  if (row.story_class === 'FORECAST_MOVER') {
    const packet = await loadPacket(store, t.event_slug, row.story_cutoff);
    const o = packet?.outcomes.find((x) => x.market_id === t.market_id);
    const ids = (o?.snapshots || []).filter((x) => [t.s0, t.s1].includes(x.id)).map((x) => x.feature_snapshot_id).filter(Boolean);
    const feats = ids.length ? await store.selectIn('pred_feature_snapshots', { select: 'snapshot_id,features' }, 'snapshot_id', ids) : [];
    const built = packet ? buildMover({ packet, marketId: t.market_id, s0Id: t.s0, s1Id: t.s1, features: new Map(feats.map((f) => [f.snapshot_id, f.features])) }) : { ok: false, reason: 'packet' };
    return { packet, built };
  }
  if (row.story_class === 'RESOLUTION_REPORT') {
    const packet = await loadPacket(store, t.event_slug, row.story_cutoff);
    const built = packet ? buildResolution({ packet, familyResolved: row.evidence.family_resolved ?? null }) : { ok: false, reason: 'packet' };
    return { packet, built };
  }
  return { packet: null, built: { ok: false, reason: `unpublishable class ${row.story_class}` } };
}

// Image subject + evidence geometry for the image resolver (insights/images.js), derived from the story's own packet:
// mover = the moved contract's station and its from -> to path; resolution = the station (single-station events) and
// the final PBE distribution with the winning outcome. Render-side only.
export function imageSubject(row, packet) {
  const t = row.evidence?.trigger || {};
  if (row.story_class === 'FORECAST_MOVER') {
    const o = packet.outcomes.find((x) => x.market_id === t.market_id);
    return { subject: { station: o?.contract?.station_id || null }, overlay: { kind: 'mover', label: o?.label ?? t.outcome ?? '', from: t.from, to: t.to } };
  }
  const stations = [...new Set(packet.outcomes.map((o) => o.contract?.station_id).filter(Boolean))];
  const modeled = packet.outcomes.filter((o) => o.snapshots.length);
  const finalOf = (o) => (o.snapshots.find((x) => (x.roles || []).includes('FINAL_PRE_RESOLUTION')) || o.snapshots.at(-1))?.pbe ?? 0;
  const winner = modeled.findIndex((o) => String(o.resolution?.venue_result || '').toLowerCase() === 'yes');
  return { subject: { station: stations.length === 1 ? stations[0] : null }, overlay: { kind: 'resolution', values: modeled.slice(0, 24).map(finalOf), winner } };
}

// Published newsroom stories as { story, built } items, compatible with the flagship story renderer.
export async function publishedNewsroomStories(store, { fresh = false, loadPacket = loadEventPacket } = {}) {
  if (!fresh && Date.now() - cache.at < TTL) return cache.items;
  let pubs;
  try { pubs = await store.select('pred_newsroom_transitions', { select: 'story_id,at', state: 'eq.PUBLISHED' }); } catch (e) { console.log(JSON.stringify({ newsroom: 'read_failed', error: e.message })); return cache.items; }
  const stories = pubs.length ? await store.selectIn('pred_newsroom_stories', { select: '*' }, 'story_id', pubs.map((p) => p.story_id)) : [];
  const items = [];
  for (const row of stories) {
    const pub = pubs.find((p) => p.story_id === row.story_id);
    try {
      if (!PUBLISHABLE_CLASSES.includes(row.story_class)) continue;
      const { packet, built } = await rebuild(store, row, loadPacket);
      const problems = built.ok ? validateStory(built, packet, row.story_cutoff) : [built.reason];
      if (problems.length) { console.log(JSON.stringify({ newsroom: 'published_story_failed_revalidation', story_id: row.story_id, problems })); continue; }
      items.push({
        story: { slug: row.slug, story_id: row.story_id, family: row.story_class, family_label: FAMILY[row.story_class], vertical: VERTICAL[packet.event.category] || 'weather', events: [packet.event.slug], primary: packet.event.slug, as_of: row.story_cutoff, published_at: new Date(pub.at).toISOString(), link_title: built.title, automated: true, ...imageSubject(row, packet) },
        built, words: null,
      });
    } catch (e) { console.log(JSON.stringify({ newsroom: 'published_story_error', story_id: row.story_id, error: e.message })); }
  }
  cache = { at: Date.now(), items };
  return items;
}
