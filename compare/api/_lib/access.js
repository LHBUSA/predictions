// Compare's ONE entitlement decision per request. Authority: pbe-predictions /v1/membership (which asks
// auth.propbetedge.ai for the predictions product verdict). Fail closed; never infer paid status.
//   anonymous                     -> 401 (no session)
//   signed in, not entitled       -> 403
//   authority unreachable/invalid -> 503 + Retry-After (never shown as unsubscribed)
export const MEMBERSHIP_URL = 'https://pbe-predictions.sales-fd3.workers.dev/v1/membership';
export const MARKET_DESK_URL = 'https://propsports-markets.sales-fd3.workers.dev/v1/market-desk';
export const MARKET_INTEL_URL = 'https://propsports-markets.sales-fd3.workers.dev/v1/market-intelligence';

const PRIVATE = {
  'cache-control': 'private, no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'vary': 'Cookie'
};

export function send(res, status, body, extra = {}) {
  for (const [k, v] of Object.entries({ ...PRIVATE, ...extra })) res.setHeader(k, v);
  res.status(status).send(JSON.stringify(body));
}

const UNVERIFIED = { authenticated: false, reason: 'membership_unavailable', membership: { state: 'unverified', entitled: false, label: 'Access Check' } };

// Only the session cookie travels to the authority (never analytics/consent cookies).
export function sessionCookie(header = '') {
  const m = String(header).match(/(?:^|;\s*)pbe_session=([^;]+)/);
  return m ? `pbe_session=${m[1]}` : '';
}

export async function membership(req, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const cookie = sessionCookie(req.headers?.cookie || '');
  try {
    const r = await fetchImpl(MEMBERSHIP_URL, {
      headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body?.membership?.state) return { status: 503, body: UNVERIFIED };
    return { status: 200, body };
  } catch {
    return { status: 503, body: UNVERIFIED };
  }
}

// Pure verdict -> HTTP status for protected routes.
export function verdict(m) {
  if (m.status !== 200) return { status: 503, body: m.body };
  const mm = m.body.membership || {};
  if (mm.entitled === true && (mm.state === 'all_access' || mm.state === 'owner')) return { status: 200, body: m.body };
  if (mm.state === 'unverified') return { status: 503, body: m.body };
  if (mm.state === 'anonymous' || m.body.authenticated === false) return { status: 401, body: { error: 'sign_in_required', membership: mm } };
  return { status: 403, body: { error: 'all_access_required', membership: mm } };
}

export async function requireAllAccess(req, res, opts) {
  const v = verdict(await membership(req, opts));
  if (v.status === 200) return v.body;
  send(res, v.status, v.body, v.status === 503 ? { 'retry-after': '30' } : {});
  return null;
}

// Upstream JSON read with a hard timeout; never throws.
export async function upstreamJson(url, { fetchImpl = fetch, timeoutMs = 8000, headers = {} } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.json().catch(() => null);
    return { ok: r.ok && body != null, status: r.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, body: null, ms: Date.now() - t0, error: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
