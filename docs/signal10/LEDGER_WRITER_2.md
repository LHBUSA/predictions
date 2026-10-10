# Signal 10 ORIGINAL — ledger writer/2 (issue #69)

Persistence-only repair of the forward paper account `S10-FWD-1`. **The model and policy are unchanged:**
`signal10-rank/1.0.0` and `signal10-manager/1.0.0`, and `policy.js`, `rank.js`, `portfolio.js`, `data.js`, `universe.js`
`aliases.js`, `members-latest.js` and `sql/016` are byte-identical (pinned in `test/signal10-writer2.test.js`). No stored
row is rewritten.

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
   An `UNVERIFIED` pending order keeps no sequence number, so its later FILL carries `orderSeq: null` rather than a
   number that could point at an unrelated row. Benchmark (SPY/QQQ) orders use benchmark-local numbers and were never
   ledger rows: they are listed in `benchmarkLinks` as `UNVERIFIED` and their numbers cleared.
5. **The nested state carries no `phase`**; the STATE event's own `phase` is authoritative.

## Verification formula (unchanged)
`hash = sha256(prev_hash + canonical({account, origin, seq, type, d, payload, model_version, policy_version}))`.
`canonical` is JSON with sorted keys. It is computed on the payload **as stored**.

## Separately versioned: `signal10-schedule/2` (early closes)
- The EOD final-close gates used a fixed 16:00 ET. On NYSE early-close sessions (2026-11-27, 2026-12-24, 13:00 ET) the
  source's final bar is stamped about 13:00, so the EOD would never have run.
- writer/2 gates on `closeMinutes(D)` from the NYSE calendar in `src/market-tape/core.js`.
- The EOD window still opens at 16:20 ET, after the official close on every session. Nothing else in scheduling changes.

## Runbook, 2026-10-12 (first restore)
- **Before deploying:** confirm the production ledger head is still seq 14 (STATE seq 14, 2026-10-09) and that the live
  Worker's source is main, so the deploy diff is exactly this PR. Deploy on the weekend, when no V1 run fires.
- **After the 2026-10-12 OPEN, verify** (an All Access session on `GET /api/signal10/ledger?origin=FORWARD_PAPER`, or a
  read-only DB select — there is no admin ledger view):
  - exactly one `LEDGER_WRITER_UPGRADE` row, at seq 15, with `pendingLinks` MU → 10 and VTRS → 11 `VERIFIED` and
    `benchmarkLinks` (SPY, QQQ) `UNVERIFIED` (benchmark-local numbers, never ledger rows);
  - the MU and VTRS `FILL` rows carry `orderSeq` 10 and 11; `BENCHMARK_FILL.orderSeq` is null by design;
  - the whole chain, legacy rows included, recomputes with the formula above.
- **If writer/2 cannot ship safely:** set the wrangler var `SIGNAL10` to anything but `"true"` before 09:45 ET (a deploy
  of the CURRENT code with the var changed). That pauses the cron lane; claims and the ledger stay intact. Note that
  `POST /admin/signal10/run` is not gated by `SIGNAL10` — do not call it while paused. A missed OPEN is booked at EOD from
  the official open, the same as writer/1.
- **Rollback — fix forward only.** Once writer/2 has written its first STATE, **never roll back to 5e7bacf1 (writer/1)**:
  writer/1's `restoreState` cannot read a nested STATE, so its `/v1/signal10/live` and `/today` throw (member 500s), the
  market-tape research overlay silently drops the held symbols, and its cron errors every minute (it writes nothing,
  because each run fails before its claim). A rollback to 5e7bacf1 also restores `SIGNAL10="true"` from that version's
  vars. To stop V1 safely, deploy the writer/2 code with `SIGNAL10="false"` (one deploy), then fix forward.
  Before the first writer/2 STATE exists (i.e. before the 2026-10-12 OPEN), rolling back to the previous version is safe.

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
