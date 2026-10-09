#!/usr/bin/env node
// INDEPENDENT OFFLINE VERIFIER for the Cloudflare Employment collector's R2 evidence (proposed Amendment B3 §3).
// Runs OUTSIDE the Worker that wrote the data and only READS (Cloudflare REST API: list + get objects). It shares nothing
// with the Worker except the protocol rules module (lib.mjs: slot times, order-book derivation), which is the
// specification itself. The chain check is a separate implementation, and timestamp tokens are verified
// cryptographically by OpenSSL against the public CA bundle (the Worker can only check that a token echoes the hash).
//   node verify-r2.mjs [--ns shadow|auth|rehearsal:<id>] [--out report.json]
// Credential: the local wrangler OAuth login (never printed). Exit code 0 = no problems, 1 = problems found.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveBook } from './lib.mjs';

const ACC = 'fd3a233edadd0a60916413c1199f71ee'; const BUCKET = 'pbe-employment-evidence';
const CA = 'C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const ns = arg('--ns', 'shadow');
const prefix = ns === 'auth' ? '' : ns === 'shadow' ? 'shadow/' : ns === 'drill' ? 'drill/' : `rehearsal/${ns.slice('rehearsal:'.length)}/`;
const token = readFileSync(`${process.env.USERPROFILE}/.wrangler/config/default.toml`, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) { console.error('no wrangler login'); process.exit(2); }
const API = `https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/${BUCKET}/objects`;
const H = { Authorization: `Bearer ${token}` };
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function listAll() {
  const out = []; let cursor = '';
  do {
    const j = await (await fetch(`${API}?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: H })).json();
    if (!j.success) throw new Error(`list failed ${JSON.stringify(j.errors)}`);
    out.push(...j.result); cursor = j.result_info?.is_truncated ? j.result_info.cursor : '';
  } while (cursor);
  return out.map((o) => ({ key: o.key, path: o.key.slice(prefix.length), size: o.size, uploaded: o.last_modified, sha256: o.custom_metadata?.sha256 || null }))
    .filter((o) => prefix || !/^(shadow|rehearsal|drill|locktest)\//.test(o.key));
}
const cache = new Map();
async function get(key) {
  if (cache.has(key)) return cache.get(key);
  const r = await fetch(`${API}/${key.split('/').map(encodeURIComponent).join('/')}`, { headers: H });
  if (!r.ok) throw new Error(`get ${key} ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer()); cache.set(key, b); return b;
}

const objects = await listAll();
const byPath = new Map(objects.map((o) => [o.path, o]));
const problems = []; const stats = { objects: objects.length, rehashed: 0, capture_files: 0, books: 0, anchors: 0, anchors_openssl_ok: 0 };

// 1. every object: sha256(bytes) == sha256 stored at upload
for (const o of objects) {
  const b = await get(o.key); stats.rehashed += 1;
  if (!o.sha256) problems.push(`no stored sha256 ${o.path}`); else if (sha(b) !== o.sha256) problems.push(`stored sha256 mismatch ${o.path}`);
}
// 2. captures: recorded file hashes, books re-derived, timing recomputed from per-request times
const slots = {};
for (const o of objects.filter((x) => /(snapshot|capture|settlement)\.json$/.test(x.path))) {
  const j = JSON.parse((await get(o.key)).toString('utf8')); const dir = o.path.replace(/\/[^/]+$/, '');
  for (const m of j.files || (j.file ? [j.file] : [])) {
    if (!m.file) continue;
    stats.capture_files += 1;
    const f = byPath.get(`${dir}/${m.file}`);
    if (!f) { problems.push(`missing ${dir}/${m.file}`); continue; }
    if (sha(await get(f.key)) !== m.sha256) problems.push(`recorded hash mismatch ${dir}/${m.file}`);
  }
  if (j.kind !== 'KALSHI_SNAPSHOT') continue;
  for (const s of Object.values(j.series)) for (const ct of s.contracts || []) {
    if (!ct.orderbook_file) continue;
    const book = deriveBook(JSON.parse((await get(`${prefix}${dir}/${ct.orderbook_file}`)).toString('utf8'))); stats.books += 1;
    if (book.best_yes_bid !== ct.book.best_yes_bid || book.best_yes_ask !== ct.book.best_yes_ask || book.mid !== ct.book.mid) problems.push(`book ${dir} ${ct.ticker}`);
  }
  if (!j.slot_at_utc) continue; // ADHOC
  const slotAt = Date.parse(j.slot_at_utc);
  const firstStart = Math.min(...j.files.map((f) => Date.parse(f.request_started_utc)));
  const lastDone = Math.max(...j.files.map((f) => Date.parse(f.response_completed_utc)));
  const uploads = j.files.filter((f) => f.file).map((f) => Date.parse(byPath.get(`${dir}/${f.file}`)?.uploaded)).concat(Date.parse(o.uploaded));
  const diffs = j.files.filter((f) => f.server_date).map((f) => Date.parse(f.server_date) - Date.parse(f.response_completed_utc)).sort((a, b) => a - b);
  const clockMs = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null;
  const c = {
    dir, status: j.status, mode: j.mode ?? j.code?.mode ?? null,
    V2_completed_before_slot: lastDone < slotAt, stored_flag_agrees: j.completed_before_slot === (lastDone < slotAt),
    V3_clock_within_2s: clockMs !== null && Math.abs(clockMs) <= 2000, clock_median_ms: clockMs,
    V4_uploaded_by_slot_plus_5m: uploads.every((t) => t <= slotAt + 300000), max_upload_utc: new Date(Math.max(...uploads)).toISOString(),
    B2_3_started_within_10m: firstStart >= slotAt - 600000, first_request_utc: new Date(firstStart).toISOString(),
  };
  if (!c.stored_flag_agrees) problems.push(`completed_before_slot flag disagrees with request times ${dir}`);
  (slots[`${j.release.release_date}/${j.slot}`] ||= { slot_at_utc: j.slot_at_utc, captures: [] }).captures.push(c);
}
// 3. ledger chain, independent implementation: seq 1..n, prev links, hash = sha256(JSON of the entry without hash)
const lines = [];
for (const o of objects.filter((x) => x.path.startsWith('ledger-ticks/')).sort((a, b) => a.path.localeCompare(b.path))) lines.push(...(await get(o.key)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
let head = 'GENESIS'; let chainOk = true;
lines.forEach((x, i) => {
  const { hash, ...rest } = x;
  if (chainOk && (x.seq !== i + 1 || x.prev !== head || sha(JSON.stringify(rest)) !== hash)) { chainOk = false; problems.push(`chain break at line ${i + 1} (seq ${x.seq})`); }
  head = hash;
});
const sealedAt = new Map(); // evidence path -> seq of the TICK_SEAL that sealed it
for (const x of lines.filter((l) => l.type === 'TICK_SEAL' || l.type === 'IMPORT')) for (const f of x.files || []) {
  sealedAt.set(f.path, x.seq);
  const o = byPath.get(f.path);
  if (!o) problems.push(`sealed file missing ${f.path}`); else if (o.sha256 !== f.sha256 && f.path !== 'calendar/bls-empsit-schedule.json') problems.push(`sealed file changed ${f.path}`);
}
// 4. RFC 3161 anchors: cryptographic verification with OpenSSL against the public CA bundle
const bySeq = new Map(lines.map((l) => [l.seq, l])); const anchorBySeq = new Map();
const tmp = mkdtempSync(join(tmpdir(), 'emp-verify-'));
try {
  for (const o of objects.filter((x) => x.path.startsWith('ledger-anchors/'))) {
    stats.anchors += 1;
    const seq = Number((/_seq(\d+)\.tsr$/.exec(o.path) || [])[1]); const entry = bySeq.get(seq);
    if (!entry) { problems.push(`anchor for unknown seq ${o.path}`); continue; }
    const f = join(tmp, `a${seq}.tsr`); writeFileSync(f, await get(o.key));
    const v = spawnSync('openssl', ['ts', '-verify', '-digest', entry.hash, '-in', f, '-CAfile', CA], { encoding: 'utf8' });
    const t = spawnSync('openssl', ['ts', '-reply', '-in', f, '-text'], { encoding: 'utf8' });
    const gen = (/Time stamp: (.+)/.exec(t.stdout || '') || [])[1];
    const ok = /Verification: OK/.test(`${v.stdout}${v.stderr}`);
    if (ok) { stats.anchors_openssl_ok += 1; anchorBySeq.set(seq, gen ? new Date(gen).toISOString() : null); } else problems.push(`anchor fails openssl verify ${o.path}`);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
// an anchor at seq N covers every entry with seq <= N: the earliest anchor at or after a seal proves its time
const anchorFor = (seq) => [...anchorBySeq.entries()].filter(([s]) => s >= seq).sort((a, b) => a[0] - b[0])[0] || null;

// 5. per-slot validity (B3 V2-V7) and the designated observation (latest valid capture started >= slot - 10 min)
for (const [key, s] of Object.entries(slots)) {
  const slotAt = Date.parse(s.slot_at_utc);
  for (const c of s.captures) {
    const seq = sealedAt.get(`${c.dir}/snapshot.json`); const a = seq ? anchorFor(seq) : null;
    Object.assign(c, { sealed_seq: seq ?? null, V6_sealed_in_valid_chain: !!seq && chainOk, V7_anchor_gen_time: a?.[1] ?? null, V7_anchored_by_slot_plus_5m: !!a?.[1] && Date.parse(a[1]) <= slotAt + 300000 });
    c.valid_V2_V7 = c.status === 'OK' && c.V2_completed_before_slot && c.V3_clock_within_2s && c.V4_uploaded_by_slot_plus_5m && c.V6_sealed_in_valid_chain && c.V7_anchored_by_slot_plus_5m;
  }
  const designated = s.captures.filter((c) => c.valid_V2_V7 && c.B2_3_started_within_10m).sort((a, b) => a.first_request_utc.localeCompare(b.first_request_utc)).at(-1);
  s.designated = designated?.dir ?? null;
  s.outcome = designated ? 'VALID' : s.captures.some((c) => c.valid_V2_V7) ? 'VALID_CAPTURE_BUT_NO_B2_3_SNAPSHOT' : 'MISSED_OR_INVALID';
  s.note = ns === 'auth' ? null : 'non-authoritative namespace: never counts (B3 V1)';
}
for (const o of objects.filter((x) => x.path.endsWith('/MISSED.json'))) { const key = o.path.slice('kalshi/'.length, -'/MISSED.json'.length); if (slots[key]?.designated) problems.push(`MISSED and a valid designated capture both present ${key}`); (slots[key] ||= { captures: [] }).missed_record = o.path; }

const report = { generated_utc: new Date().toISOString(), verifier: 'scripts/research/employment/collector/verify-r2.mjs (independent, read-only)', bucket: BUCKET, namespace: ns, prefix, stats, ledger: { entries: lines.length, chain_ok: chainOk, head, anchors: stats.anchors, anchors_openssl_ok: stats.anchors_openssl_ok }, slots, problems, ok: problems.length === 0 };
const out = arg('--out', null); if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { outcome: v.outcome, designated: v.designated, captures: v.captures.length, missed_record: v.missed_record }])) }, null, 1));
process.exitCode = problems.length ? 1 : 0;
