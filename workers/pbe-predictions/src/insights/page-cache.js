// Read-through memo for PUBLIC Insights desk HTML only (not member pages, APIs,
// article live updates, RSS or admin). Pages are identical for all visitors.
// Unlike Cache API, this works on our workers.dev origin and collapses concurrent
// misses within an isolate. The existing 120 s browser cache remains unchanged.
const snapshots = new Map();
const pending = new Map();
const TTL_MS = 90_000;
const MAX_KEYS = 20;

export async function cachedInsightsDesk(key, build, { now = Date.now, ttlMs = TTL_MS } = {}) {
  const current = snapshots.get(key);
  if (current && now() - current.at < ttlMs) return current.response.clone();

  if (pending.has(key)) return (await pending.get(key)).clone();

  const task = Promise.resolve().then(build).then((response) => {
    // Strictly cache public successful HTML. Never memo an outage, 404,
    // auth-dependent payload, or a response with cookies.
    const cc = response?.headers?.get('cache-control') || '';
    const ct = response?.headers?.get('content-type') || '';
    if (response?.status === 200 && /(?:^|,)\s*public\b/i.test(cc)
      && /^text\/html(?:;|$)/i.test(ct) && !response.headers.has('set-cookie')) {
      snapshots.delete(key);
      snapshots.set(key, { at: now(), response: response.clone() });
      if (snapshots.size > MAX_KEYS) snapshots.delete(snapshots.keys().next().value);
    }
    return response;
  }).finally(() => pending.delete(key));

  pending.set(key, task);
  return (await task).clone();
}
