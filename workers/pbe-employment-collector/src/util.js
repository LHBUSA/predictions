// Small runtime-neutral helpers (Workers and Node 20+ both provide WebCrypto, TextEncoder, atob/btoa).
export const enc = new TextEncoder();
export const dec = new TextDecoder();
export const iso = (ms) => new Date(ms).toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const toBytes = (x) => (x instanceof Uint8Array ? x : typeof x === 'string' ? enc.encode(x) : new Uint8Array(x));
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) { return hex(await crypto.subtle.digest('SHA-256', toBytes(bytes))); }
// git's object id for a blob (lets the mirror prove GitHub stored exactly these bytes)
export async function gitBlobSha(bytes) {
  const b = toBytes(bytes); const head = enc.encode(`blob ${b.length}\0`);
  const all = new Uint8Array(head.length + b.length); all.set(head); all.set(b, head.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
}
export function b64(bytes) {
  const b = toBytes(bytes); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export const jsonBytes = (o) => enc.encode(JSON.stringify(o, null, 1) + '\n');
