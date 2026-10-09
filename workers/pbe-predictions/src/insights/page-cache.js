// Read-through memo for PUBLIC Insights desk HTML only (not member pages, APIs,
// article live updates, RSS or admin). Pages are identical for all visitors.
// Workers rule: a Response (or its body stream) created while handling one request
// must never be used by another request ("Cannot perform I/O on behalf of a
// different request" / "ReadableStream is currently locked"), and a promise created
// by one request must not be awaited by another. So the memo stores PLAIN DATA
// (status, headers, HTML text) and every request gets a brand-new Response; there is
// no cross-request coalescing. The existing 120 s browser cache remains unchanged.
const snapshots = new Map();
const TTL_MS = 90_000;
const MAX_KEYS = 20;

const respond = (s) => new Response(s.body, { status: s.status, headers: s.headers });

export async function cachedInsightsDesk(key, build, { now = Date.now, ttlMs = TTL_MS } = {}) {
  const current = snapshots.get(key);
  if (current && now() - current.at < ttlMs) return respond(current);

  const response = await build();
  // Strictly cache public successful HTML. Never memo an outage, 404,
  // auth-dependent payload, or a response with cookies.
  const cc = response?.headers?.get('cache-control') || '';
  const ct = response?.headers?.get('content-type') || '';
  if (!(response?.status === 200 && /(?:^|,)\s*public\b/i.test(cc)
    && /^text\/html(?:;|$)/i.test(ct) && !response.headers.has('set-cookie'))) return response;
  const snap = { at: now(), status: response.status, headers: [...response.headers.entries()], body: await response.text() };
  snapshots.delete(key);
  snapshots.set(key, snap);
  if (snapshots.size > MAX_KEYS) snapshots.delete(snapshots.keys().next().value);
  return respond(snap);
}
