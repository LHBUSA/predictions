// Small runtime-neutral helpers (Workers and Node 20+ both provide WebCrypto, TextEncoder, atob/btoa).
export const enc = new TextEncoder();
export const dec = new TextDecoder();
export const iso = (ms) => new Date(ms).toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const toBytes = (x) => (x instanceof Uint8Array ? x : typeof x === 'string' ? enc.encode(x) : new Uint8Array(x));
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) { return hex(await crypto.subtle.digest('SHA-256', toBytes(bytes))); }
export const jsonBytes = (o) => enc.encode(JSON.stringify(o, null, 1) + '\n');
