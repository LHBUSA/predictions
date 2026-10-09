// pbe-employment-collector Kalshi signer: both Kalshi key types, type decided from the PARSED key (not the PEM header),
// signatures verified independently with node:crypto, GET-only, fail-closed without leaking key material.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, constants, createPublicKey } from 'node:crypto';
import { kalshiSigner, parseKalshiKey, __resetKalshiAuthCache, KalshiAuthError } from '../workers/pbe-employment-collector/src/kalshi-auth.js';

const URL_ = 'https://api.elections.kalshi.com/trade-api/v2/markets/KXU3-26OCT/orderbook?depth=0';
const PRE = (ts) => Buffer.from(`${ts}GET/trade-api/v2/markets/KXU3-26OCT/orderbook`);
const env = (pem) => ({ KALSHI_API_KEY_ID: 'key-id-test', KALSHI_PRIVATE_KEY: pem });

test('Ed25519 PKCS#8: signs the documented pre-sign text (path without query)', async () => {
  __resetKalshiAuthCache();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const s = await kalshiSigner(env(privateKey.export({ type: 'pkcs8', format: 'pem' })));
  assert.equal(s.keyType, 'ed25519');
  const h = await s('GET', URL_, 1760000000123);
  assert.equal(h['KALSHI-ACCESS-KEY'], 'key-id-test');
  assert.equal(h['KALSHI-ACCESS-TIMESTAMP'], '1760000000123');
  const sig = Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64');
  assert.equal(sig.length, 64);
  assert.equal(verify(null, PRE('1760000000123'), publicKey, sig), true);
});

for (const fmt of ['pkcs1', 'pkcs8']) {
  test(`RSA-2048 ${fmt.toUpperCase()}: RSA-PSS SHA-256, salt = digest length`, async () => {
    __resetKalshiAuthCache();
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: fmt, format: 'pem' });
    if (fmt === 'pkcs8') assert.match(pem, /BEGIN PRIVATE KEY/, 'a PKCS#8 RSA key carries the same header as Ed25519');
    assert.equal(parseKalshiKey(pem).type, 'rsa', 'type comes from the parsed OID, not the header');
    const s = await kalshiSigner(env(pem));
    assert.equal(s.keyType, 'rsa');
    const h = await s('GET', URL_, 1760000000999);
    const sig = Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64');
    assert.equal(sig.length, 256);
    assert.equal(verify('sha256', PRE('1760000000999'), { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig), true);
    assert.equal(verify('sha256', PRE('1760000000999'), { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 }, sig), false, 'salt length is pinned to 32');
  });
}

test('escaped newlines (secret pasted as one line) still parse', async () => {
  __resetKalshiAuthCache();
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
  assert.equal((await kalshiSigner(env(pem))).keyType, 'ed25519');
});

test('GET only: any other method is refused before signing', async () => {
  __resetKalshiAuthCache();
  const { privateKey } = generateKeyPairSync('ed25519');
  const s = await kalshiSigner(env(privateKey.export({ type: 'pkcs8', format: 'pem' })));
  for (const m of ['POST', 'DELETE', 'PUT', 'post']) await assert.rejects(s(m, 'https://api.elections.kalshi.com/trade-api/v2/portfolio/orders'), /kalshi_auth_method_not_allowed/);
});

test('fail closed without leaking key material', async () => {
  __resetKalshiAuthCache();
  assert.equal(await kalshiSigner({}), null);
  await assert.rejects(kalshiSigner({ KALSHI_API_KEY_ID: 'x' }), /private_key_missing/);
  await assert.rejects(kalshiSigner({ KALSHI_PRIVATE_KEY: 'x' }), /key_id_missing/);
  await assert.rejects(kalshiSigner(env('not a pem')), /key_not_pem/);
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(kalshiSigner(env(ec)), /key_type_unsupported/, 'an EC key with the generic header is refused, not mis-signed');
  __resetKalshiAuthCache();
  const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  await assert.rejects(kalshiSigner(env(small)), /rsa_key_too_small/);
  __resetKalshiAuthCache();
  const bad = '-----BEGIN PRIVATE KEY-----\nMIIBAAAA\n-----END PRIVATE KEY-----';
  try { await kalshiSigner(env(bad)); assert.fail('should throw'); } catch (e) { assert.ok(e instanceof KalshiAuthError); assert.ok(!String(e.message).includes('MIIB')); }
});

test('public key derivation sanity (test keys only)', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  assert.ok(createPublicKey(privateKey));
});
