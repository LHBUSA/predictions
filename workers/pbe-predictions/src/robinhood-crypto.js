// Robinhood Crypto Trading API — READ-ONLY market-data client for Predictions.
//
// Secrets:
//   ROBINHOOD_CRYPTO_API_KEY
//   ROBINHOOD_CRYPTO_PRIVATE_KEY_B64  (32-byte Ed25519 seed, base64)
//
// Security boundary: this module intentionally exposes NO account, holdings, order,
// preview, cancel, or trading methods. It is market-data only.

const BASE = 'https://trading.robinhood.com';
const enc = new TextEncoder();

function b64ToBytes(s) {
  const raw = atob(String(s || '').trim());
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function pkcs8FromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Robinhood private key must be a 32-byte Ed25519 seed');
  // RFC 8410 PKCS#8 wrapper for an Ed25519 seed:
  // SEQUENCE( version=0, alg=1.3.101.112, OCTET STRING( OCTET STRING(seed) ) )
  const prefix = Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  const out = new Uint8Array(prefix.length + seed.length);
  out.set(prefix, 0); out.set(seed, prefix.length);
  return out;
}

async function signingKey(privateKeyB64) {
  const seed = b64ToBytes(privateKeyB64);
  return crypto.subtle.importKey('pkcs8', pkcs8FromSeed(seed), { name: 'Ed25519' }, false, ['sign']);
}

export function robinhoodConfigured(env) {
  return !!(env?.ROBINHOOD_CRYPTO_API_KEY && env?.ROBINHOOD_CRYPTO_PRIVATE_KEY_B64);
}

function b64urlToBytes(value) {
  const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return b64ToBytes(s + '='.repeat((4 - (s.length % 4)) % 4));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Safe diagnostic only: fingerprint the PUBLIC key derived from the private seed.
// It never returns the private key, signature material, account data or prices.
export async function robinhoodCredentialFingerprint(env) {
  const seed = b64ToBytes(env.ROBINHOOD_CRYPTO_PRIVATE_KEY_B64);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8FromSeed(seed), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (!jwk?.x) throw new Error('Robinhood public-key derivation failed');
  const digest = await crypto.subtle.digest('SHA-256', b64urlToBytes(jwk.x));
  return {
    api_key_suffix: String(env.ROBINHOOD_CRYPTO_API_KEY || '').trim().slice(-4),
    public_key_sha256: hex(digest),
  };
}

export class RobinhoodCryptoMarketData {
  constructor({ apiKey, privateKeyB64, fetchImpl = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
    if (!apiKey) throw new TypeError('Robinhood API key is required');
    if (!privateKeyB64) throw new TypeError('Robinhood private key is required');
    this.apiKey = String(apiKey).trim();
    this.privateKeyB64 = String(privateKeyB64);
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.now = now;
    this._key = null;
  }

  async headers(method, path, body = '') {
    const ts = this.now();
    const key = this._key || (this._key = await signingKey(this.privateKeyB64));
    const message = `${this.apiKey}${ts}${path}${method}${body}`;
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, enc.encode(message)));
    return {
      'x-api-key': this.apiKey,
      'x-signature': bytesToB64(sig),
      'x-timestamp': String(ts),
      accept: 'application/json',
    };
  }

  async get(path) {
    if (!path.startsWith('/api/v2/crypto/')) throw new Error('Robinhood path outside read-only crypto surface');
    const headers = await this.headers('GET', path);
    const res = await this.fetchImpl(BASE + path, { method: 'GET', headers, cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error(`Robinhood read failed: ${res.status}`);
      e.status = res.status;
      e.detail = data;
      throw e;
    }
    return data;
  }

  tradingPairs(symbols = []) {
    const q = (Array.isArray(symbols) ? symbols : [symbols]).filter(Boolean).map((s) => `symbol=${encodeURIComponent(String(s).toUpperCase())}`).join('&');
    return this.get(`/api/v2/crypto/trading/trading_pairs/${q ? `?${q}` : ''}`);
  }

  bestBidAsk(symbols) {
    const list = (Array.isArray(symbols) ? symbols : [symbols]).filter(Boolean);
    if (!list.length) throw new TypeError('at least one symbol is required');
    const q = list.map((s) => `symbol=${encodeURIComponent(String(s).toUpperCase())}`).join('&');
    return this.get(`/api/v2/crypto/marketdata/best_bid_ask/?${q}`);
  }

  estimatedPrice(symbol, { side = 'both', quantity = '0.01' } = {}) {
    const sym = String(symbol || '').toUpperCase();
    if (!/^[A-Z0-9]+-USD$/.test(sym)) throw new TypeError('symbol must be a USD trading pair');
    if (!['bid','ask','both'].includes(side)) throw new TypeError('side must be bid, ask, or both');
    const q = new URLSearchParams({ symbol: sym, side, quantity: String(quantity) }).toString();
    return this.get(`/api/v2/crypto/trading/estimated_price/?${q}`);
  }
}

export function robinhoodForEnv(env, fetchImpl) {
  return new RobinhoodCryptoMarketData({
    apiKey: env.ROBINHOOD_CRYPTO_API_KEY,
    privateKeyB64: env.ROBINHOOD_CRYPTO_PRIVATE_KEY_B64,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
