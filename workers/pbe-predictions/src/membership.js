// Predictions membership: the network authority decides (propbetedge-auth-magic, GET /membership?product=predictions,
// reached through the AUTH service binding). Predictions is an All-Access-only PRODUCT surface: only an active
// pbe_all_access subscription or the verified owner grants; sport-only plans never do. Fail closed everywhere: no
// cookie, a malformed answer, a wrong product, or an unreachable authority all mean FREE. The browser never decides.
export const FREE = Object.freeze({ product: 'predictions', sport: null, state: 'free', label: 'FREE', entitled: false, show_purchase_cta: true, network_url: 'https://propbetedge.ai/pro' });
const GRANTING = new Set(['all_access', 'owner']);

export function sessionCookie(req) {
  const raw = req.headers.get('cookie') || '';
  const m = raw.match(/(?:^|;\s*)pbe_session=([^;]+)/);
  return m && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(m[1]) ? m[1] : null;
}

// Returns { authenticated, membership } — membership is the browser-safe object from the authority, or FREE.
export async function predictionsMembership(req, env) {
  const token = sessionCookie(req);
  if (!token) return { authenticated: false, reason: 'no_session', membership: FREE };
  if (!env.AUTH?.fetch) return { authenticated: false, reason: 'authority_unavailable', membership: FREE };
  try {
    const res = await env.AUTH.fetch(new Request('https://auth.propbetedge.ai/membership?product=predictions', { headers: { cookie: `pbe_session=${token}`, accept: 'application/json' } }));
    if (!res.ok) return { authenticated: false, reason: `authority_${res.status}`, membership: FREE };
    const body = await res.json();
    const m = body?.membership;
    const valid = m && m.product === 'predictions' && m.sport === null && typeof m.state === 'string';
    if (!valid) return { authenticated: false, reason: 'authority_shape', membership: FREE };
    const entitled = m.entitled === true && GRANTING.has(m.state);
    const membership = entitled
      ? { product: 'predictions', sport: null, state: m.state, label: m.state === 'owner' ? 'OWNER' : 'ALL ACCESS ACTIVE', entitled: true, email: m.email ?? null, manage_url: m.manage_url ?? null, show_manage: Boolean(m.show_manage), show_purchase_cta: false, network_url: FREE.network_url }
      : { ...FREE, email: m.email ?? null };
    return { authenticated: Boolean(body.authenticated), reason: body.reason ?? null, membership };
  } catch {
    return { authenticated: false, reason: 'authority_error', membership: FREE };
  }
}

// Member/identity responses are never cacheable by any shared cache.
export const PRIVATE_HEADERS = Object.freeze({ 'cache-control': 'private, no-store, max-age=0', vary: 'Cookie', 'x-content-type-options': 'nosniff' });
