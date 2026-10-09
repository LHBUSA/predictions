// R2 evidence store. Keys mirror the evidence repo layout under a mode prefix ('' authoritative, 'shadow/', 'rehearsal/<id>/').
// Evidence is write-once: an existing key may only be "written" again with identical bytes; anything else is an
// IMMUTABLE_VIOLATION and the tick fails. R2 verifies the sha256 of every upload server-side. The only mutable key is the
// derived calendar (its raw source pages are immutable). Every write is remembered for the GitHub mirror.
import { jsonBytes, sha256, toBytes } from './util.js';

const MUTABLE = new Set(['calendar/bls-empsit-schedule.json']);

export class EvidenceStore {
  constructor(bucket, prefix = '') { this.bucket = bucket; this.prefix = prefix; this.written = []; }
  key(path) { return this.prefix + path; }
  async put(path, data, contentType = 'application/octet-stream') {
    const bytes = toBytes(data); const h = await sha256(bytes); const key = this.key(path);
    if (!MUTABLE.has(path)) {
      const head = await this.bucket.head(key);
      if (head) {
        if (head.customMetadata?.sha256 === h) return { path, sha256: h, existed: true };
        throw new Error(`IMMUTABLE_VIOLATION ${key}: existing ${head.customMetadata?.sha256} != new ${h}`);
      }
    }
    await this.bucket.put(key, bytes, { sha256: h, httpMetadata: { contentType }, customMetadata: { sha256: h } });
    this.written.push({ path, sha256: h, bytes });
    return { path, sha256: h, existed: false };
  }
  putJson(path, obj) { return this.put(path, jsonBytes(obj), 'application/json'); }
  async getBytes(path) { const o = await this.bucket.get(this.key(path)); return o ? new Uint8Array(await o.arrayBuffer()) : null; }
  async getJson(path) { const b = await this.getBytes(path); return b ? JSON.parse(new TextDecoder().decode(b)) : null; }
  async list(prefix) {
    const out = []; let cursor;
    do { const r = await this.bucket.list({ prefix: this.key(prefix), cursor, limit: 1000, include: ['customMetadata'] }); out.push(...r.objects.map((o) => ({ path: o.key.slice(this.prefix.length), size: o.size, sha256: o.customMetadata?.sha256 }))); cursor = r.truncated ? r.cursor : undefined; } while (cursor);
    return out;
  }
}
