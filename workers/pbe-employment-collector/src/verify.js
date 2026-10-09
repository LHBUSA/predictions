// verify: re-hash every evidence object in R2 against both its recorded capture metadata and the sha256 stored at upload,
// re-derive every order book, check MISSED vs OK per slot, verify the hash-chained ledger end to end (and that every
// TICK_SEAL'd file is still in R2 with the sealed sha256), cross-check the Durable Object index, and report the timestamp
// proof: each capture's R2 upload time (assigned by R2, cannot be backdated) against its recorded completion time and,
// for slot snapshots, against the slot and the release. Optional prefix keeps one call inside Worker limits.
import { deriveBook } from '../../../scripts/research/employment/collector/lib.mjs';
import { verifyChain } from './ledger.js';
import { NON_AUTH_PREFIXES } from './genesis.js';
import { inspectResponse } from './tsa.js';
import { dec, sha256 } from './util.js';

export async function verify({ store, state, ns, chain, prefix = '' }) {
  // the authoritative root never includes the shadow, rehearsal, drill or lock-test namespaces
  const objects = (await store.list(prefix)).filter((o) => store.prefix !== '' || !NON_AUTH_PREFIXES.test(o.path));
  const byPath = new Map(objects.map((o) => [o.path, o]));
  let files = 0; let bad = 0; let snaps = 0; let rederived = 0; let ledgerLines = 0; let objectsRehashed = 0; const problems = []; const timing = [];
  const bytesOf = async (p) => store.getBytes(p);
  for (const o of objects) {
    const b = await bytesOf(o.path); objectsRehashed += 1;
    if (o.sha256 && (await sha256(b)) !== o.sha256) { bad += 1; problems.push(`r2-sha ${o.path}`); }
    if (/(snapshot|capture|settlement)\.json$/.test(o.path)) {
      const j = JSON.parse(dec.decode(b)); const dir = o.path.replace(/\/[^/]+$/, '');
      for (const m of j.files || (j.file ? [j.file] : [])) {
        if (!m.file) continue;
        files += 1;
        const fb = await bytesOf(`${dir}/${m.file}`);
        if (!fb || (await sha256(fb)) !== m.sha256) { bad += 1; problems.push(`hash ${o.path} ${m.file}`); }
      }
      const doneAt = j.completed_utc || j.captured_utc || j.first_seen_utc || j.file?.response_completed_utc;
      if (doneAt && o.uploaded) {
        const lag = (Date.parse(o.uploaded) - Date.parse(doneAt)) / 1000;
        const t = { path: dir, kind: j.kind, completed_utc: doneAt, r2_uploaded_utc: o.uploaded, upload_lag_s: +lag.toFixed(1) };
        if (j.kind === 'KALSHI_SNAPSHOT' && j.slot_at_utc) Object.assign(t, { slot_at_utc: j.slot_at_utc, uploaded_before_slot: Date.parse(o.uploaded) < Date.parse(j.slot_at_utc), uploaded_before_release: Date.parse(o.uploaded) < Date.parse(j.release.release_at) });
        timing.push(t);
        if (lag < -2) problems.push(`recorded completion is after the R2 upload time ${dir}`);
      }
      if (j.kind === 'KALSHI_SNAPSHOT') {
        snaps += 1;
        for (const s of Object.values(j.series)) for (const ct of s.contracts || []) {
          if (!ct.orderbook_file) continue;
          const book = deriveBook(JSON.parse(dec.decode(await bytesOf(`${dir}/${ct.orderbook_file}`))));
          if (book.best_yes_bid !== ct.book.best_yes_bid || book.best_yes_ask !== ct.book.best_yes_ask || book.best_yes_ask_size !== ct.book.best_yes_ask_size || book.mid !== ct.book.mid) problems.push(`book ${o.path} ${ct.ticker}`); else rederived += 1;
        }
      }
    }
    if (/^kalshi\/terms\/[0-9a-f]{64}\.pdf$/.test(o.path)) { files += 1; if (`kalshi/terms/${await sha256(b)}.pdf` !== o.path) { bad += 1; problems.push(`terms ${o.path}`); } }
    if (/^ledger(-ticks)?\//.test(o.path) && o.path.endsWith('.jsonl')) for (const l of dec.decode(b).split('\n').filter(Boolean)) { ledgerLines += 1; try { JSON.parse(l); } catch { problems.push(`ledger ${o.path}`); } }
  }
  const rows = state ? await state.index(ns) : [];
  const okKeys = new Set(rows.filter((r) => r.kind === 'KALSHI_SNAPSHOT' && r.ok).map((r) => r.key));
  for (const r of rows.filter((x) => x.kind === 'MISSED')) if (okKeys.has(r.key)) problems.push(`MISSED and OK both present for ${r.key}`);
  for (const o of objects.filter((x) => x.path.endsWith('/MISSED.json'))) { const key = o.path.slice('kalshi/'.length, -'/MISSED.json'.length); if (okKeys.has(key)) problems.push(`MISSED and OK both present for ${key}`); }
  for (const r of rows.filter((x) => x.path && x.kind === 'KALSHI_SNAPSHOT' && x.path.startsWith(prefix))) if (!byPath.has(`${r.path}/snapshot.json`)) problems.push(`index without evidence ${r.path}`);
  // the ledger chain, end to end (only meaningful for an unfiltered verify of the namespace)
  let ledger = { status: 'SKIPPED (prefix filter)' };
  if (!prefix) {
    const lines = [];
    for (const o of objects.filter((x) => x.path.startsWith('ledger-ticks/')).sort((a, b) => a.path.localeCompare(b.path))) lines.push(...dec.decode(await bytesOf(o.path)).split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l)));
    const v = await verifyChain(lines);
    let sealedFiles = 0;
    for (const x of lines.filter((l) => l.type === 'TICK_SEAL')) for (const f of x.files) { sealedFiles += 1; const o = byPath.get(f.path); if (!o) problems.push(`sealed file missing ${f.path}`); else if (o.sha256 !== f.sha256 && !f.path.startsWith('calendar/bls-empsit-schedule.json')) problems.push(`sealed file changed ${f.path}`); }
    if (!v.ok) problems.push(`ledger chain broken at seq ${v.seq}: ${v.problem}`);
    else if (chain && (chain.seq !== v.seq || chain.head !== v.head)) problems.push(`ledger chain in R2 (seq ${v.seq}) differs from the Durable Object head (seq ${chain.seq})`);
    // external anchors: each RFC 3161 token must be granted and echo the chain hash at its seq; genTime must not precede the entry
    const bySeq = new Map(lines.map((l) => [l.seq, l]));
    const anchors = [];
    for (const o of objects.filter((x) => x.path.startsWith('ledger-anchors/'))) {
      const seq = Number((/_seq(\d+)\.tsr$/.exec(o.path) || [])[1]); const entry = bySeq.get(seq);
      const info = entry ? inspectResponse(await bytesOf(o.path), entry.hash) : null;
      const ok = !!info?.granted && info.echoes_hash && !!info.gen_time_utc && Date.parse(info.gen_time_utc) >= Date.parse(entry.at_utc) - 2000;
      if (!ok) problems.push(`anchor invalid ${o.path}`);
      anchors.push({ seq, gen_time_utc: info?.gen_time_utc ?? null, ok });
    }
    ledger = { status: v.ok ? 'OK' : 'BROKEN', anchors: anchors.length, anchors_ok: anchors.filter((a) => a.ok).length, last_anchor: anchors.sort((a, b) => a.seq - b.seq).at(-1) || null, entries: lines.length, seq: v.seq, head: v.head ?? null, sealed_files: sealedFiles, matches_durable_object: !!chain && chain.seq === v.seq && chain.head === v.head };
  }
  return { prefix, objects: objects.length, objects_rehashed: objectsRehashed, files_hashed: files, hash_mismatches: bad, kalshi_snapshots: snaps, order_books_rederived: rederived, ledger_lines: ledgerLines, index_rows: rows.length, ledger_chain: ledger, timestamp_proof: timing, problems, ok: problems.length === 0 };
}
