// Newsroom V1 persistence (sql/003): manual, admin-only publication of a VALIDATED story, and the read path that
// serves published newsroom stories. Automatic publication does not exist in V1 — nothing here runs on a cron.
// A published story stores its trigger, cutoff and claims; it is rebuilt deterministically from the immutable
// ledger on every render and re-validated (a story that no longer validates is not served).
import { loadEventPacket } from '../insights/packet.js';
import { buildMover } from './templates.js';
import { validateStory } from './engine.js';
import { NEWSROOM_RULES } from './config.js';

const VERTICAL = { WEATHER: 'weather', RATES: 'rates', MACRO: 'economics', FINANCE: 'business', BUSINESS: 'business', SCIENCE: 'science', SPACE: 'space', PUBLIC_HEALTH: 'public-health', ENERGY: 'energy' };
const FAMILY = { FORECAST_MOVER: 'Forecast Change', RESOLUTION_REPORT: 'Resolution Report' };

export async function storyState(store, storyIds) {
  if (!storyIds.length) return new Map();
  const rows = await store.selectIn('pred_newsroom_transitions', { select: 'story_id,state,at,reason' }, 'story_id', storyIds);
  const out = new Map();
  for (const r of rows.sort((a, b) => a.at.localeCompare(b.at))) {
    const cur = out.get(r.story_id) || { states: [] };
    cur.states.push(r.state); cur.latest = r.state; cur.at = r.at;
    if (r.state === 'PUBLISHED') cur.published_at = r.at;
    out.set(r.story_id, cur);
  }
  return out;
}

// Each transition is its own request (own transaction) so the sql/003 guard sees a strictly later timestamp.
export async function publishStory(store, s, { by = 'admin-manual', note = null } = {}) {
  if (s.state !== 'VALIDATED') return { ok: false, error: `story is ${s.state}${s.reason ? ` (${s.reason})` : ''}, not VALIDATED` };
  if (s.class !== 'FORECAST_MOVER') return { ok: false, error: `manual publication in V1 is limited to FORECAST_MOVER (got ${s.class})` };
  const existing = (await storyState(store, [s.story_id])).get(s.story_id);
  if (existing?.published_at) return { ok: false, error: 'already_published', published_at: existing.published_at };
  if (existing) return { ok: false, error: `story already persisted in state ${existing.latest}; resolve manually` };
  const t = s.trigger;
  await store.write('pred_newsroom_stories', {
    story_id: s.story_id, story_class: s.class, trigger_key: ['MOVER', t.market_id, t.s0, t.s1].join('|'), slug: s.slug,
    event_ids: [s.packet.event.id], story_cutoff: s.def.as_of, rules_version: NEWSROOM_RULES,
    evidence: { trigger: t, claims: s.built.claims, snapshot_ids: [t.s0, t.s1], packet_as_of: s.packet.as_of, title_at_publication: s.built.title },
  });
  const steps = [['CANDIDATE', null], ['EVIDENCE_READY', null], ['GENERATED', null], ['VALIDATED', { problems: [] }], ['PUBLISHED', { by, note }]];
  for (const [state, detail] of steps) {
    await store.write('pred_newsroom_transitions', { story_id: s.story_id, state, detail: detail || {} });
    await new Promise((r) => setTimeout(r, 5));
  }
  const after = (await storyState(store, [s.story_id])).get(s.story_id);
  return { ok: Boolean(after?.published_at), story_id: s.story_id, slug: s.slug, states: after?.states ?? [], published_at: after?.published_at ?? null };
}

let cache = { at: 0, items: [] };
const TTL = 5 * 60 * 1000;

// Published newsroom stories as { story, built } items, compatible with the flagship story renderer.
export async function publishedNewsroomStories(store, { fresh = false } = {}) {
  if (!fresh && Date.now() - cache.at < TTL) return cache.items;
  let pubs;
  try { pubs = await store.select('pred_newsroom_transitions', { select: 'story_id,at', state: 'eq.PUBLISHED' }); } catch (e) { console.log(JSON.stringify({ newsroom: 'read_failed', error: e.message })); return cache.items; }
  const stories = pubs.length ? await store.selectIn('pred_newsroom_stories', { select: '*' }, 'story_id', pubs.map((p) => p.story_id)) : [];
  const items = [];
  for (const row of stories) {
    const pub = pubs.find((p) => p.story_id === row.story_id);
    try {
      if (row.story_class !== 'FORECAST_MOVER') continue;
      const t = row.evidence.trigger;
      const packet = await loadEventPacket(store, t.event_slug, row.story_cutoff);
      const o = packet?.outcomes.find((x) => x.market_id === t.market_id);
      const ids = (o?.snapshots || []).filter((x) => [t.s0, t.s1].includes(x.id)).map((x) => x.feature_snapshot_id).filter(Boolean);
      const feats = ids.length ? await store.selectIn('pred_feature_snapshots', { select: 'snapshot_id,features' }, 'snapshot_id', ids) : [];
      const built = packet ? buildMover({ packet, marketId: t.market_id, s0Id: t.s0, s1Id: t.s1, features: new Map(feats.map((f) => [f.snapshot_id, f.features])) }) : { ok: false, reason: 'packet' };
      const problems = built.ok ? validateStory(built, packet, row.story_cutoff) : [built.reason];
      if (problems.length) { console.log(JSON.stringify({ newsroom: 'published_story_failed_revalidation', story_id: row.story_id, problems })); continue; }
      items.push({
        story: { slug: row.slug, story_id: row.story_id, family: row.story_class, family_label: FAMILY[row.story_class], vertical: VERTICAL[packet.event.category] || 'weather', events: [packet.event.slug], primary: packet.event.slug, as_of: row.story_cutoff, published_at: new Date(pub.at).toISOString(), link_title: built.title, automated: true },
        built, words: null,
      });
    } catch (e) { console.log(JSON.stringify({ newsroom: 'published_story_error', story_id: row.story_id, error: e.message })); }
  }
  cache = { at: Date.now(), items };
  return items;
}
