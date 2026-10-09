#!/usr/bin/env node
// Replay equivalence (local, read-only): serve the raw bytes a Windows-collected snapshot recorded, URL for URL, to the
// Worker's kalshiSnapshot, then compare everything derived from them with the Windows snapshot.json: file names, URLs,
// statuses, byte counts and sha256s, every contract's book / fees / rules hashes / market record, series fee + terms
// hashes, completeness and close-date checks. Only clock, code and per-request timestamps may differ.
// Evidence never leaves the private evidence directories (nothing is written; outputs a JSON verdict).
//   node replay-equivalence.mjs <evidence-root> <snapshot-dir-relative-to-root> [...more]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kalshiSnapshot } from '../src/collector.js';
import { makeGet } from '../src/http.js';
import { MemoryState } from '../src/state.js';
import { EvidenceStore } from '../src/store.js';

const [root, ...dirs] = process.argv.slice(2);
const KB = 'https://api.elections.kalshi.com/trade-api/v2';
class Bucket { constructor() { this.m = new Map(); } async head(k) { return this.m.has(k) ? { customMetadata: this.m.get(k).meta } : null; } async put(k, b, o) { this.m.set(k, { b, meta: o.customMetadata }); } }
const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (['orderbook_completed_utc', 'request_started_utc', 'response_completed_utc', 'request_started_local_clock_utc', 'response_completed_local_clock_utc', 'server_date', 'attempt', 'signed', 'ms'].includes(k) ? undefined : v)));
const results = [];
for (const rel of dirs) {
  const dir = join(root, rel);
  const win = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  const byUrl = new Map(win.files.map((f) => [f.url, { f, bytes: f.file ? readFileSync(join(dir, f.file)) : null }]));
  for (const s of Object.values(win.series)) for (const t of Object.values(s.terms || {})) if (t?.stored_as) byUrl.set(t.url, { f: t, bytes: readFileSync(join(root, t.stored_as)) });
  let served = 0; let t = Date.parse(win.started_utc);
  const fetchImpl = async (url) => { const e = byUrl.get(url); if (!e) throw new Error(`not recorded: ${url}`); served += 1; return new Response(e.bytes, { status: e.f.status, headers: { 'content-type': e.f.content_type || 'application/json', ...(e.f.last_modified ? { 'last-modified': e.f.last_modified } : {}), ...(e.f.etag ? { etag: e.f.etag } : {}) } }); };
  const bucket = new Bucket();
  const c = { mode: 'replay', ns: 'replay', store: new EvidenceStore(bucket, 'replay/'), state: new MemoryState(), get: makeGet({ fetchImpl, signer: async () => ({ 'KALSHI-ACCESS-SIGNATURE': 'replay' }), kalshiBase: KB, now: () => t, sleep: async () => {} }), kalshiBase: KB, now: () => t, sleep: async () => { t += 120; }, code: {}, host: 'replay', ledger: () => {}, alert: async () => {} };
  const cloud = await kalshiSnapshot(c, win.release, win.slot, win.slot_at_utc ? Date.parse(win.slot_at_utc) : null);
  const diffs = [];
  const a = strip(win.series); const b = strip(cloud.series);
  if (JSON.stringify(a) !== JSON.stringify(b)) for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`series ${k}`);
  const fa = strip(win.files).map((f) => [f.file, f.url, f.status, f.bytes, f.sha256].join(' ')); const fb = strip(cloud.files).map((f) => [f.file, f.url, f.status, f.bytes, f.sha256].join(' '));
  if (JSON.stringify(fa) !== JSON.stringify(fb)) diffs.push('files');
  if (win.status !== cloud.status) diffs.push(`status ${win.status} vs ${cloud.status}`);
  const stored = [...bucket.m.keys()].filter((k) => !k.endsWith('snapshot.json')).length;
  results.push({ snapshot: rel, windows_status: win.status, worker_status: cloud.status, files: win.files.length, served, stored_raw_objects: stored, contracts: Object.fromEntries(Object.entries(cloud.series).map(([k, v]) => [k, `${v.orderbooks_ok}/${v.markets_listed}`])), equivalent: diffs.length === 0, diffs });
}
console.log(JSON.stringify({ all_equivalent: results.every((r) => r.equivalent), results }, null, 1));
process.exitCode = results.every((r) => r.equivalent) ? 0 : 1;
