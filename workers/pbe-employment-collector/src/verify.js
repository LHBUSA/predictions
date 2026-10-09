// verify: re-hash every evidence object in R2 against both its recorded capture metadata and the sha256 stored at upload,
// re-derive every order book, check MISSED vs OK per slot, parse every ledger line, and cross-check the Durable Object
// capture index against R2. Optional prefix keeps one call inside Worker limits as the archive grows.
import { deriveBook } from '../../../scripts/research/employment/collector/lib.mjs';
import { dec, sha256 } from './util.js';

export async function verify({ store, state, ns, mirror, lastPushed, prefix = '' }) {
  const objects = await store.list(prefix);
  const byPath = new Map(objects.map((o) => [o.path, o]));
  let files = 0; let bad = 0; let snaps = 0; let rederived = 0; let ledgerLines = 0; let objectsRehashed = 0; const problems = [];
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
  const remote = mirror ? await mirror.remoteHistory(lastPushed) : { status: 'NOT_MIRRORED' };
  if (remote.status === 'REWRITTEN') problems.push(`remote history rewritten: ${JSON.stringify(remote)}`);
  return { prefix, objects: objects.length, objects_rehashed: objectsRehashed, files_hashed: files, hash_mismatches: bad, kalshi_snapshots: snaps, order_books_rederived: rederived, ledger_lines: ledgerLines, index_rows: rows.length, remote_history: remote, problems, ok: problems.length === 0 };
}
