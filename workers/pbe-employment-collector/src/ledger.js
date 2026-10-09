// Hash-chained audit ledger. Each entry carries seq (1, 2, ...), prev (the previous entry's hash, 'GENESIS' first) and
// hash = sha256 of the entry's JSON without `hash`. Any deleted, inserted, reordered or edited entry breaks the chain.
// TICK_SEAL entries carry the sha256 of every evidence object written in that tick, so the chain also covers the evidence.
import { sha256 } from './util.js';

export async function chainEntries(entries, chain) {
  let seq = chain?.seq || 0; let head = chain?.head || 'GENESIS';
  const out = [];
  for (const e of entries) {
    const { seq: _s, prev: _p, hash: _h, ...body } = e;
    const x = { ...body, seq: ++seq, prev: head };
    x.hash = await sha256(JSON.stringify(x));
    head = x.hash; out.push(x);
  }
  return { out, chain: { seq, head } };
}

// lines: every ledger entry in sealed order. Returns the recomputed head, or the first break.
export async function verifyChain(lines) {
  let head = 'GENESIS'; let seq = 0;
  for (const x of lines) {
    const { hash, ...rest } = x;
    if (x.seq !== seq + 1) return { ok: false, seq, problem: `seq ${x.seq} after ${seq}` };
    if (x.prev !== head) return { ok: false, seq: x.seq, problem: 'prev does not match the previous hash' };
    if ((await sha256(JSON.stringify(rest))) !== hash) return { ok: false, seq: x.seq, problem: 'hash does not match the entry' };
    head = hash; seq = x.seq;
  }
  return { ok: true, seq, head };
}
