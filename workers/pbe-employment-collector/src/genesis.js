// Authoritative GENESIS (owner adoption of Amendment B3 + cloud-only cutover, Issue #3 comment 6082392799,
// 2026-10-09T13:57:42Z). Opens a brand-new authoritative ledger: NO Windows/GitHub evidence is imported or promoted;
// legacy evidence stays read-only in the historical GitHub repo (and shadow evidence under shadow/). Fails closed unless:
//   - the auth namespace is completely uninitialised (no state, no chain, no index rows, no ledger rows), and
//   - the authoritative R2 root holds no objects (only shadow/, rehearsal/, drill/, locktest/ may exist), and
//   - the genesis record gets an RFC 3161 anchor (a genesis without an external time anchor is never written).
// The GENESIS entry is seq 1 of the auth chain; its at_utc is the effective_at: collection eligibility starts there.
import { COLLECTOR_VERSION } from './collector.js';
import { chainEntries } from './ledger.js';
import { compactUtc } from '../../../scripts/research/employment/collector/lib.mjs';
import { iso } from './util.js';

export const NON_AUTH_PREFIXES = /^(shadow|rehearsal|drill|locktest)\//;

export async function preflight({ store, state }) {
  const st = await state.getState('auth');
  const rows = await state.index('auth');
  const ledger = await state.ledgerTail('auth', 1);
  const rootObjects = (await store.list('')).filter((o) => !NON_AUTH_PREFIXES.test(o.path));
  const problems = [];
  if (Object.keys(st).length) problems.push(`auth state not empty: ${Object.keys(st).join(',')}`);
  if (rows.length) problems.push(`auth index has ${rows.length} rows`);
  if (ledger.length) problems.push('auth ledger has rows');
  if (rootObjects.length) problems.push(`authoritative R2 root has ${rootObjects.length} objects (e.g. ${rootObjects[0].path})`);
  return { empty: problems.length === 0, problems, root_objects: rootObjects.length };
}

export async function genesis({ store, state, anchor, now, code, approval, windows }) {
  const pre = await preflight({ store, state });
  if (!pre.empty) return { error: 'auth namespace not empty: genesis refused', ...pre };
  const at = now();
  const entry = {
    type: 'GENESIS', at_utc: iso(at), collector: COLLECTOR_VERSION, mode: 'authoritative', effective_at: iso(at),
    approval, windows, code,
    rules: 'Amendment B3 (V1-V7, B2.3 designation: snapshot fetched in [slot-10 min, slot); the :45 capture is never designated); Tier A data and market prices only',
    legacy: 'Windows/GitHub evidence (LHBUSA/pbe-employment-evidence) is preserved read-only and is NOT imported or promoted; shadow evidence stays under shadow/ and is never authoritative',
    note: 'Fresh authoritative ledger. Nothing before effective_at is authoritative; no backfill.',
  };
  const { out, chain } = await chainEntries([entry], null);
  const a = anchor ? await anchor(chain.head) : { ok: false, errors: ['no anchor function'] };
  if (!a.ok) return { error: 'genesis RFC 3161 anchor failed: genesis NOT written', errors: a.errors };
  const ledgerKey = `ledger-ticks/${iso(at).slice(0, 7)}/${compactUtc(at)}_genesis.jsonl`;
  const anchorKey = `ledger-anchors/${iso(at).slice(0, 7)}/${compactUtc(at)}_seq1.tsr`;
  await store.put(ledgerKey, out.map((x) => JSON.stringify(x)).join('\n') + '\n', 'application/x-ndjson');
  await store.put(anchorKey, a.bytes, 'application/timestamp-reply');
  await state.appendLedger('auth', out);
  const last_anchor = { seq: 1, head: chain.head, tsa: a.tsa, gen_time_utc: a.gen_time_utc, key: anchorKey };
  await state.putState('auth', { enabled_at: iso(at), chain, last_ledger_key: ledgerKey, last_anchor, genesis: { effective_at: iso(at), head: chain.head, ledger_key: ledgerKey, anchor_key: anchorKey } });
  return { effective_at: iso(at), chain, ledger_key: ledgerKey, anchor: last_anchor };
}
