// Predictions membership: the network authority decides (propbetedge-auth-magic, GET /membership?product=predictions,
// reached through the AUTH service binding). Predictions is a premium product included with PropBetEdge All Access
// ($29/month): only an active pbe_all_access subscription or the verified owner grants; sport-only plans never do.
// There is no free Predictions tier. The browser never decides.
//
// States (owner contract 2026-10-05):
//   anonymous  — no valid session                         header "Sign in" + "Get All Access"
//   signed_in  — valid session, no All Access              header "Upgrade"
//   all_access — active All Access                        header "ALL ACCESS ACTIVE"
//   owner      — verified owner                            header "OWNER"
//   unverified — a session exists but entitlement could not be verified (authority/ledger down, bad answer)
//                                                          header "Access Check" — never shown as unsubscribed
// Every non-entitled state is fail-closed: no premium data.
const NETWORK_URL = 'https://propbetedge.ai/pro';
const base = { product: 'predictions', sport: null, entitled: false, network_url: NETWORK_URL };
export const ANONYMOUS = Object.freeze({ ...base, state: 'anonymous', label: 'Sign in', show_purchase_cta: true });
export const SIGNED_IN = Object.freeze({ ...base, state: 'signed_in', label: 'Upgrade', show_purchase_cta: true });
export const UNVERIFIED = Object.freeze({ ...base, state: 'unverified', label: 'Access Check', show_purchase_cta: false, degraded: true });
const GRANTING = new Set(['all_access', 'owner']);

export function sessionCookie(req) {
  const raw = req.headers.get('cookie') || '';
  const m = raw.match(/(?:^|;\s*)pbe_session=([^;]+)/);
  return m && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(m[1]) ? m[1] : null;
}

const unverified = (reason) => ({ authenticated: false, reason, membership: UNVERIFIED });

// Returns { authenticated, reason, membership } — membership is browser-safe.
export async function predictionsMembership(req, env) {
  const token = sessionCookie(req);
  if (!token) return { authenticated: false, reason: 'no_session', membership: ANONYMOUS };
  if (!env.AUTH?.fetch) return unverified('authority_unavailable');
  try {
    const res = await env.AUTH.fetch(new Request('https://auth.propbetedge.ai/membership?product=predictions', { headers: { cookie: `pbe_session=${token}`, accept: 'application/json' } }));
    if (!res.ok) return unverified(`authority_${res.status}`);
    const body = await res.json();
    const m = body?.membership;
    const valid = m && m.product === 'predictions' && m.sport === null && typeof m.state === 'string';
    if (!valid) return unverified('authority_shape');
    if (m.entitled === true && GRANTING.has(m.state)) {
      return { authenticated: true, reason: body.reason ?? null, membership: { product: 'predictions', sport: null, state: m.state, label: m.state === 'owner' ? 'OWNER' : 'ALL ACCESS ACTIVE', entitled: true, email: m.email ?? null, manage_url: m.manage_url ?? null, show_manage: Boolean(m.show_manage), show_purchase_cta: false, network_url: NETWORK_URL } };
    }
    // the session is valid but the All Access ledger could not be read: never present the reader as unsubscribed
    if (body.authenticated && body.reason === 'entitlement_unavailable') return { authenticated: true, reason: body.reason, membership: { ...UNVERIFIED, email: m.email ?? null } };
    if (body.authenticated) return { authenticated: true, reason: body.reason ?? null, membership: { ...SIGNED_IN, email: m.email ?? null } };
    return { authenticated: false, reason: body.reason ?? null, membership: ANONYMOUS };
  } catch {
    return unverified('authority_error');
  }
}

// Member/identity responses are never cacheable by any shared cache.
export const PRIVATE_HEADERS = Object.freeze({ 'cache-control': 'private, no-store, max-age=0', vary: 'Cookie', 'x-content-type-options': 'nosniff' });
