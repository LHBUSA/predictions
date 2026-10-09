// Kalshi signed GET reads for the Employment collector. Derived from LHBUSA/propbetedge-workers
// workers/propsports-markets/src/kalshi-auth.js @ 6ca6c0e (the proven signed path from Cloudflare egress: same headers,
// same pre-sign text, same fail-closed contract), extended to BOTH key types Kalshi supports (docs.kalshi.com
// getting_started/api_keys, read 2026-10-09):
//   Ed25519 (recommended)  PKCS#8 "BEGIN PRIVATE KEY"                          -> Ed25519 (RFC 8032), 64-byte signature
//   RSA 2048+              PKCS#1 "BEGIN RSA PRIVATE KEY" or PKCS#8 "BEGIN PRIVATE KEY" -> RSA-PSS, SHA-256, MGF1-SHA256,
//                          salt length = digest length (32)
// The key type is decided from the PARSED key (the PKCS#8 AlgorithmIdentifier OID), never from the PEM header: a PKCS#8
// RSA key also begins "BEGIN PRIVATE KEY".
//
//   KALSHI-ACCESS-KEY        key id
//   KALSHI-ACCESS-TIMESTAMP  milliseconds since epoch
//   KALSHI-ACCESS-SIGNATURE  base64( sign( `${ts}${METHOD}${path}` ) )   path = pathname incl. /trade-api/v2, no query
//
// GET-only: the signer refuses any other method, so this Worker cannot place, amend or cancel orders even with a
// full-access key. Secrets KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY are never logged, serialised or echoed. Fail closed:
// one secret without the other, an unparseable key, an unsupported key type or an RSA key under 2048 bits throws
// KalshiAuthError (generic code, no key material) and NO request is sent.

export class KalshiAuthError extends Error {
  constructor(code) {
    super(`kalshi_auth_${code}`);
    this.code = code;
  }
}

export function authConfigured(env) {
  return Boolean(env?.KALSHI_API_KEY_ID && env?.KALSHI_PRIVATE_KEY);
}

const OID_ED25519 = '2b6570'; // 1.3.101.112
const OID_RSA = '2a864886f70d010101'; // 1.2.840.113549.1.1.1 rsaEncryption
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function pemBody(text, label) {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(text);
  if (!m) return null;
  let bin;
  try { bin = atob(m[1].replace(/\s+/g, '')); } catch { throw new KalshiAuthError('key_not_base64'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Minimal DER reader: one TLV at offset -> { tag, start (of value), end }
function tlv(der, off) {
  if (off + 2 > der.length) throw new KalshiAuthError('key_malformed');
  const tag = der[off]; let len = der[off + 1]; let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || p + n > der.length) throw new KalshiAuthError('key_malformed');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[p + i];
    p += n;
  }
  if (p + len > der.length) throw new KalshiAuthError('key_malformed');
  return { tag, start: p, end: p + len };
}

// PKCS#8 PrivateKeyInfo ::= SEQUENCE { version INTEGER, algorithm AlgorithmIdentifier { OID, params }, privateKey OCTET STRING }
export function pkcs8KeyType(der) {
  const top = tlv(der, 0); if (top.tag !== 0x30) throw new KalshiAuthError('key_malformed');
  const ver = tlv(der, top.start); if (ver.tag !== 0x02) throw new KalshiAuthError('key_malformed');
  const alg = tlv(der, ver.end); if (alg.tag !== 0x30) throw new KalshiAuthError('key_malformed');
  const oid = tlv(der, alg.start); if (oid.tag !== 0x06) throw new KalshiAuthError('key_malformed');
  const o = hex(der.subarray(oid.start, oid.end));
  return o === OID_ED25519 ? 'ed25519' : o === OID_RSA ? 'rsa' : 'unsupported';
}

function derLen(n) {
  if (n < 0x80) return [n];
  const b = []; while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return [0x80 | b.length, ...b];
}
const derTlv = (tag, body) => Uint8Array.from([tag, ...derLen(body.length), ...body]);

// PKCS#1 RSAPrivateKey -> PKCS#8 PrivateKeyInfo (WebCrypto imports PKCS#8 only)
export function pkcs1ToPkcs8(pkcs1) {
  const algId = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return derTlv(0x30, [0x02, 0x01, 0x00, ...algId, ...derTlv(0x04, pkcs1)]);
}

// PEM -> { type, der } decided from the parsed structure
export function parseKalshiKey(pem) {
  const text = String(pem).replace(/\\n/g, '\n');
  const p1 = pemBody(text, 'RSA PRIVATE KEY');
  if (p1) {
    if (tlv(p1, 0).tag !== 0x30) throw new KalshiAuthError('key_malformed');
    return { type: 'rsa', der: pkcs1ToPkcs8(p1) };
  }
  const p8 = pemBody(text, 'PRIVATE KEY');
  if (!p8) throw new KalshiAuthError('key_not_pem');
  const type = pkcs8KeyType(p8);
  if (type === 'unsupported') throw new KalshiAuthError('key_type_unsupported');
  return { type, der: p8 };
}

function bytesToB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

let cache = null; // { id, pemHash, type, key } — CryptoKey is non-extractable

async function importKey(pem) {
  const { type, der } = parseKalshiKey(pem);
  try {
    if (type === 'ed25519') return { type, key: await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']) };
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
    if (!(key.algorithm?.modulusLength >= 2048)) throw new KalshiAuthError('rsa_key_too_small');
    return { type, key };
  } catch (e) {
    if (e instanceof KalshiAuthError) throw e;
    throw new KalshiAuthError('key_import_failed'); // never forward the runtime's message
  }
}

// Returns null when no Kalshi auth is configured, else an async (method, url, nowMs?) -> headers function (GET only).
export async function kalshiSigner(env) {
  const hasId = Boolean(env?.KALSHI_API_KEY_ID);
  const hasKey = Boolean(env?.KALSHI_PRIVATE_KEY);
  if (!hasId && !hasKey) return null;
  if (!hasId || !hasKey) throw new KalshiAuthError(hasId ? 'private_key_missing' : 'key_id_missing');
  if (!cache || cache.id !== env.KALSHI_API_KEY_ID || cache.pem !== env.KALSHI_PRIVATE_KEY) {
    cache = { id: env.KALSHI_API_KEY_ID, pem: env.KALSHI_PRIVATE_KEY, ...(await importKey(env.KALSHI_PRIVATE_KEY)) };
  }
  const { id, key, type } = cache;
  const signer = async (method, url, nowMs = Date.now()) => {
    if (String(method).toUpperCase() !== 'GET') throw new KalshiAuthError('method_not_allowed'); // research collector: reads only
    const ts = String(Math.trunc(nowMs));
    const msg = new TextEncoder().encode(`${ts}GET${new URL(url).pathname}`);
    const sig = type === 'ed25519'
      ? await crypto.subtle.sign({ name: 'Ed25519' }, key, msg)
      : await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, key, msg);
    return { 'KALSHI-ACCESS-KEY': id, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': bytesToB64(sig) };
  };
  signer.keyType = type; // 'ed25519' | 'rsa' — safe to record (no key material)
  return signer;
}

export function __resetKalshiAuthCache() { cache = null; }
