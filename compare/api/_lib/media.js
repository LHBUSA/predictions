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

// Soccer club crests (2026-10-05): the same soccer-api crest assets the Soccer site and Members render, by OUR
// canonical match id (never by name). One small match read per event, 12 h cache, same time budget as UFC.
const SOCCER_MATCH = 'https://soccer-api.sales-fd3.workers.dev/v1/matches/';
const CREST_HOST = 'https://soccer.propbetedge.ai';
const crestCache = new Map(); // match id -> { at, home, away }
export const crestUrl = (u) => (typeof u === 'string' && /^\/api\/soccer\/media\/[0-9a-f]{16,128}$/.test(u) ? CREST_HOST + u : null);
async function crestLookup(id, fetchImpl) {
  try {
    const r = await fetchImpl(SOCCER_MATCH + encodeURIComponent(id), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    const d = r.ok ? (await r.json())?.data : null;
    crestCache.set(id, { at: Date.now(), home: d ? { id: d.home?.id, logo: crestUrl(d.home?.crest?.url) } : null, away: d ? { id: d.away?.id, logo: crestUrl(d.away?.crest?.url) } : null });
  } catch { crestCache.set(id, { at: Date.now() - (TTL_MS - MISS_TTL_MS), home: null, away: null }); }
}
// Adds contract.media = { logo } to soccer home/away contracts in place (only when the crest's team id equals
// the contract's team id). The draw never gets an image.
export async function enrichSoccer(events, { fetchImpl = fetch, now = Date.now(), budgetMs = BUDGET_MS } = {}) {
  const ids = [...new Set(events.map((e) => String(e.canonical_event_id)))];
  const stale = ids.filter((id) => { const h = crestCache.get(id); return !h || now - h.at > TTL_MS; });
  if (stale.length) {
    const queue = [...stale];
    const work = Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => { while (queue.length) await crestLookup(queue.shift(), fetchImpl); }));
    await Promise.race([work, new Promise((r) => setTimeout(r, budgetMs))]);
  }
  let n = 0;
  for (const e of events) {
    const h = crestCache.get(String(e.canonical_event_id));
    if (!h) continue;
    for (const c of e.contracts || []) {
      const side = c.role === 'home' ? h.home : c.role === 'away' ? h.away : null;
      const team = (String(c.canonical_contract_id || '').match(/\|team:([0-9a-f-]{36})$/) || [])[1];
      if (side?.logo && team && side.id === team) { c.media = { logo: side.logo }; n++; }
    }
  }
  return n;
}
export const __crestCache = crestCache;
