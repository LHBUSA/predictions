# Signal 10 ORIGINAL — ledger writer/2 (issue #69)

Persistence-only repair of the forward paper account `S10-FWD-1`. **The model and policy are unchanged:**
`signal10-rank/1.0.0` and `signal10-manager/1.0.0`, and `policy.js`, `rank.js`, `portfolio.js`, `data.js`, `universe.js`
and `aliases.js` are byte-identical (pinned in `test/signal10-writer2.test.js`). No stored row is rewritten.

## Defect (writer/1, live 2026-10-09 → 10-10)
- `appendEvents` moves each event's `seq` and `origin` into row columns. For the flat STATE payload that also removed the
  **account's** `seq` and `origin`.
- After a restore, the account emitted orders with `origin: undefined` and `seq: NaN`.
- `canonical()` hashed the in-memory value, including the text `"origin":undefined`. jsonb drops undefined keys, so those
  STATE rows **cannot be re-verified from the database**.
- `FILL.orderSeq` became NaN, which is stored as `null`, so fills lost their order reference.
- Trading, cash and positions were unaffected. The economic-parity test proves it: writer/1 and writer/2 produce identical
  orders, fills, decisions, marks, cash and positions.
- Production on 2026-10-10: 14 rows, 1 STATE (seq 14, 2026-10-09). No restore had happened yet, so **no bad row exists**.
  The first one would have been written at the first EOD after the 2026-10-12 OPEN.

## Fix (writer/2, `LEDGER_WRITER = 'signal10-ledger-writer/2'`)
1. **Payloads are JSON-normalised before hashing.** The hash covers exactly what jsonb stores. For every row writer/1
   wrote correctly (all 14 production rows), normalisation is a no-op, so old and new rows verify with the same formula.
2. **STATE nests the account.** It is stored as `{ phase, writer, state: { …account, bench } }`, so `seq` and `origin`
   survive. `restoreState()` reads both the nested form and the legacy flat STATE (`legacy: true`).
3. **Every restore re-bases the account on the ledger head:** `st.seq = lastSeq`, `st.origin = FORWARD_PAPER`. Events are
   appended in emission order directly after the head, so an event's local seq **is** its ledger seq, and
   `FILL.orderSeq` = the ORDER row's `seq`.
4. **The first restore of a legacy STATE writes one `LEDGER_WRITER_UPGRADE` event.** It records the from/to writer
   versions and the restored seq/origin. For each pending order it says whether the order's stored seq matches a ledger
   ORDER row with the same symbol and side: `VERIFIED` or `UNVERIFIED`. A link is never invented.

## Verification formula (unchanged)
`hash = sha256(prev_hash + canonical({account, origin, seq, type, d, payload, model_version, policy_version}))`.
`canonical` is JSON with sorted keys. It is computed on the payload **as stored**.

## Separately versioned: `signal10-schedule/2` (early closes)
- The EOD final-close gates used a fixed 16:00 ET. On NYSE early-close sessions (2026-11-27, 2026-12-24, 13:00 ET) the
  source's final bar is stamped about 13:00, so the EOD would never have run.
- writer/2 gates on `closeMinutes(D)` from the NYSE calendar in `src/market-tape/core.js`.
- The EOD window still opens at 16:20 ET, after the official close on every session. Nothing else in scheduling changes.

## Runbook, 2026-10-12 (first restore)
- **Preferred:** deploy writer/2 before 09:45 ET. The OPEN run writes the `LEDGER_WRITER_UPGRADE` event.
- **Then verify:** `GET /api/signal10/ledger?origin=FORWARD_PAPER` (All Access, or the admin view) and recompute the chain
  with the formula above. Every FILL must reference an ORDER row.
- **If writer/2 cannot ship safely:** set the wrangler var `SIGNAL10` to anything but `"true"` before 09:45 ET. That pauses
  every V1 write, and claims and the ledger stay intact. Resume after the deploy. A missed OPEN is booked at EOD from the
  official open, the same as writer/1.
- **Rollback:** Worker `pbe-predictions` version **5e7bacf1** (main 2c85084, writer/1). Rows written by writer/2 stay
  readable by writer/1's API, because `restoreState` in writer/2 reads both shapes. Writer/1 cannot restore a nested STATE,
  so after a rollback pause V1 with `SIGNAL10` rather than letting writer/1 run on top of writer/2 rows.

## Proofs
- `test/signal10-writer2.test.js`, using the frozen writer/1 copy `test/fixtures/signal10-forward-writer1.js`:
  - reproduction;
  - restarts verified from stored bytes;
  - FILL → ORDER links;
  - economic parity;
  - idempotency and concurrency;
  - a split across a restart;
  - legacy and nested restore;
  - pinned files.
- `scripts/db/prove-69.mjs <rows.json>`, with production rows read locally and never committed (the repo is public):
  - loads the real ledger into PGlite jsonb;
  - runs writer/2 for two sessions;
  - re-verifies the full chain, including the legacy rows, from the stored bytes.
