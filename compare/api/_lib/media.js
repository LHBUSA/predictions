// Participant photos that need a lookup (UFC). Team logos and tennis portraits are deterministic URLs built in
// the browser (core.js participantMedia); UFC fighters need their ESPN athlete id from ufc-api first.
// Approved source: ESPN headshots (owner standing approval); exact subject only, by id, never by name.
// Never blocks the desk: uncached lookups get a short time budget; misses fill on the next poll.
const UFC_FIGHTER = 'https://ufc-api.propbetedge.ai/v1/ufc/fighters/';
const TTL_MS = 12 * 3600e3, MISS_TTL_MS = 30 * 60e3, BUDGET_MS = 1500, CONCURRENCY = 6;
const cache = new Map(); // fighter uuid -> { at, url|null }

export function espnMmaHeadshot(espnId) {
  return /^\d{4,10}$/.test(String(espnId || '')) ? `https://a.espncdn.com/i/headshots/mma/players/full/${espnId}.png` : null;
}

export function fighterPhotoFrom(body) {
  const f = body?.data || {};
  const primary = typeof f.primary_image === 'string' ? f.primary_image : f.primary_image?.url;
  if (primary && /^https:\/\//.test(primary)) return primary;
  return espnMmaHeadshot(f.espn_athlete_id);
}

async function lookup(id, fetchImpl) {
  try {
    const r = await fetchImpl(UFC_FIGHTER + encodeURIComponent(id), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    const url = r.ok ? fighterPhotoFrom(await r.json()) : null;
    cache.set(id, { at: Date.now(), url });
  } catch { cache.set(id, { at: Date.now() - (TTL_MS - MISS_TTL_MS), url: null }); }
}

const fighterIdOf = (contractId) => (String(contractId || '').match(/\|team:([0-9a-f-]{36})$/) || [])[1] || null;

// Adds contract.media = { photo } to UFC contracts in place. Returns the number attached.
export async function enrichUfc(events, { fetchImpl = fetch, now = Date.now(), budgetMs = BUDGET_MS } = {}) {
  const ids = [...new Set(events.flatMap((e) => (e.contracts || []).map((c) => fighterIdOf(c.canonical_contract_id))).filter(Boolean))];
  const stale = ids.filter((id) => { const h = cache.get(id); return !h || now - h.at > TTL_MS; });
  if (stale.length) {
    const queue = [...stale];
    const work = Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => { while (queue.length) await lookup(queue.shift(), fetchImpl); }));
    await Promise.race([work, new Promise((r) => setTimeout(r, budgetMs))]);
  }
  let n = 0;
  for (const e of events) for (const c of e.contracts || []) {
    const url = cache.get(fighterIdOf(c.canonical_contract_id))?.url;
    if (url) { c.media = { photo: url }; n++; }
  }
  return n;
}
export const __mediaCache = cache;
