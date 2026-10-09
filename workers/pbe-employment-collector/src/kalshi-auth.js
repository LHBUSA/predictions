// Vendored unchanged from LHBUSA/propbetedge-workers workers/propsports-markets/src/kalshi-auth.js @ 6ca6c0e (the proven
// signed path from Cloudflare egress). Only kalshiSigner is used here.
// Kalshi authenticated reads (docs.kalshi.com quick_start_authenticated_requests + api_keys,
// read 2026-10-03). Authentication changes identity only; the gentle collector's cadence,
// bulk reads and 429 fail-fast are unchanged.
//
//   KALSHI-ACCESS-KEY        key id
//   KALSHI-ACCESS-TIMESTAMP  milliseconds since epoch
//   KALSHI-ACCESS-SIGNATURE  base64( Ed25519.sign( `${ts}${METHOD}${path}` ) )
// path = URL pathname INCLUDING /trade-api/v2, EXCLUDING the query string.
// Key: Ed25519, PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----"), Workers WebCrypto only.
//
// Secrets KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY are never logged, serialised or echoed.
// Fail closed: one secret without the other, or a key that does not import, throws
// KalshiAuthError (generic message, no key material) and NO request is sent.

export class KalshiAuthError extends Error {
  constructor(code) {
    super(`kalshi_auth_${code}`);
    this.code = code;
  }
}

// Only a boolean ever leaves this module about configuration.
export function authConfigured(env) {
  return Boolean(env?.KALSHI_API_KEY_ID && env?.KALSHI_PRIVATE_KEY);
}

function pemToBytes(pem) {
  const text = String(pem).replace(/\\n/g, '\n');
  if (!/-----BEGIN PRIVATE KEY-----/.test(text)) throw new KalshiAuthError('key_not_pkcs8_pem');
  const b64 = text.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  let bin;
  try { bin = atob(b64); } catch { throw new KalshiAuthError('key_not_base64'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

let cache = null; // { id, key } — CryptoKey is non-extractable

async function importEd25519(pem) {
  try {
    return await crypto.subtle.importKey('pkcs8', pemToBytes(pem), { name: 'Ed25519' }, false, ['sign']);
  } catch (e) {
    if (e instanceof KalshiAuthError) throw e;
    throw new KalshiAuthError('key_import_failed'); // never forward the runtime's message
  }
}

// Returns null when no Kalshi auth is configured (public reads), else an async
// (method, url, nowMs?) -> headers function. Throws KalshiAuthError on partial/invalid config.
export async function kalshiSigner(env) {
  const hasId = Boolean(env?.KALSHI_API_KEY_ID);
  const hasKey = Boolean(env?.KALSHI_PRIVATE_KEY);
  if (!hasId && !hasKey) return null;
  if (!hasId || !hasKey) throw new KalshiAuthError(hasId ? 'private_key_missing' : 'key_id_missing');
  if (!cache || cache.id !== env.KALSHI_API_KEY_ID) {
    cache = { id: env.KALSHI_API_KEY_ID, key: await importEd25519(env.KALSHI_PRIVATE_KEY) };
  }
  const { id, key } = cache;
  return async (method, url, nowMs = Date.now()) => {
    const ts = String(Math.trunc(nowMs));
    const path = new URL(url).pathname;
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(`${ts}${String(method).toUpperCase()}${path}`));
    return { 'KALSHI-ACCESS-KEY': id, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': bytesToB64(sig) };
  };
}

// Wraps fetch: Kalshi API URLs (by base prefix) get signature headers; everything else
// (ESPN, Supabase) passes through untouched.
export function signedFetch(fetchImpl, signer, kalshiBases) {
  return async (url, init = {}) => {
    const u = String(url);
    if (!signer || !kalshiBases.some((b) => u.startsWith(b))) return fetchImpl(url, init);
    const auth = await signer(init.method || 'GET', u);
    return fetchImpl(url, { ...init, headers: { ...(init.headers || {}), ...auth } });
  };
}

export function __resetKalshiAuthCache() { cache = null; }
