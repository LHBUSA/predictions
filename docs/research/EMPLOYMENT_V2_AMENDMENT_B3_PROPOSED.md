# Employment V2 — Amendment B3: Cloudflare-native capture validity (PROPOSED · NOT ADOPTED)

**Status:** for owner approval. Nothing here takes effect, and no capture changes status, until the owner adopts B3 in
writing. The frozen protocol (`EMPLOYMENT_V2_PROTOCOL.md`) is unchanged until then.

**Not retroactive:** shadow captures stay shadow evidence forever. Captures in the historical GitHub repository keep
their GitHub push record as proof.

**Replaces:** the GitHub clause of V2 protocol B2.5 ("pushed before 08:30 ET on release day, as shown by the GitHub push
record"). The rest of B2.5 (single scheduled collector, ownership) is unchanged. Tier B wording stays on HOLD.

## 1. When an R2 capture is valid

A Kalshi slot snapshot counts only if **all** of the following hold. Any failure means the slot is **MISSED** (§4).

| # | Condition | Evidence |
|---|---|---|
| V1 | Written by `pbe-employment-collector` in the **authoritative** namespace (`MODE=authoritative`, R2 root), after an owner-approved cutover | Capture metadata: `code.mode`, `code.commit`, `code.files` (sha256 of every bundled source), `worker_version_id` |
| V2 | Collection completed **before the slot time**: the last order-book response finished before the slot, by the Worker clock | `completed_before_slot = true`; per-request `request_started_utc` / `response_completed_utc` |
| V3 | The Worker clock agreed with Kalshi's clock: the median of (server `Date` − completion) is within ±2 s | `clock_check` in the capture |
| V4 | Stored promptly: the R2-assigned upload time of every object in the capture is ≤ slot + 5 min, and before 08:30 ET on release day | R2 object `uploaded` (set by R2; the Worker cannot set it) |
| V5 | Content is intact: each object's bytes hash to the sha256 that R2 stored at upload, which equals the hash recorded in the capture metadata and in its `TICK_SEAL` | `/admin/verify` and the independent verifier (§3) |
| V6 | The audit chain verifies: the `TICK_SEAL` holding these hashes is in an unbroken `seq/prev/hash` chain from the cutover `IMPORT` entry to the current head, and the R2 ledger head equals the Durable Object head | `/admin/verify` chain report |
| V7 | **External anchor (new):** an RFC 3161 timestamp token over the `TICK_SEAL` entry hash, from an independent public Time-Stamping Authority, with `genTime` ≤ slot + 5 min, stored beside the ledger | Token (DER) under `ledger-anchors/`, verified against the TSA certificate |

BLS, DOL and terms captures use V1 and V4–V7, with "before 08:30 ET on release day" as the deadline.

## 2. How completion-before-cutoff is verified

1. Read every object of the capture and its R2 metadata, read-only (S3 API or `/admin/verify`).
2. Recompute V2 from the per-request timestamps; never trust the stored flag alone.
3. Check V3 from the recorded server `Date` headers.
4. Check V4 against R2's `uploaded` time.
5. Check V7 against the anchor's `genTime`.

A capture passes only if the Worker-clock evidence (V2, V3) agrees with **two independent clocks**: R2's upload time
(V4) and the TSA's time (V7).

## 3. Hash and audit-chain validation

- **Per object:** sha256(bytes) = R2 stored checksum = metadata hash = `TICK_SEAL` hash.
- **Chain:** recompute every entry's `hash = sha256(prev ‖ canonical entry)` from `IMPORT` to the head. `seq` must have
  no gaps. The R2 ledger objects and the Durable Object rows must be identical.
- **Anchors:** every anchored `TICK_SEAL` hash must equal the hash recomputed in the chain check.
- **Who checks:**
  - `/admin/verify`, inside the Worker.
  - An **independent offline verifier** (`scripts/research/employment/collector/verify-r2.mjs`, written on adoption)
    re-runs every check with a read-only R2 credential, outside the Worker that wrote the data.

## 4. Missed windows

- A slot with no capture satisfying V1–V7 by the end of its window is **MISSED**.
- The collector writes a sealed `MISSED.json` (slot, reason, detected time). The slot counts as missed in coverage.
- A missed slot is **never backfilled.**
- A capture that arrives after the window, or fails any of V1–V7, is kept and labelled `LATE` or `INVALID` with its
  reason. It never counts and never replaces `MISSED`.

## 5. Duplicate prevention and the designated observation

The collector runs one tick per 5-minute bucket. As on Windows, every tick inside a slot window [slot - 15 min, slot)
takes a snapshot, so a slot has at most 3 on-time captures, at about :45, :50 and :55. Duplicates are prevented as follows:

- **One tick per bucket.** A per-namespace 5-minute idempotency key held in the Durable Object means alarm, cron and
  manual triggers can never produce two ticks, or two captures, in the same bucket. A single-writer lease stops
  overlapping ticks.
- **Write-once keys.** Each capture lives under its own timestamped key. Every R2 evidence write is refused if the key
  already exists with different bytes (code check), and overwrite or delete is refused at the platform level (bucket
  lock).
- **Designated observation.** Each slot has exactly one designated observation: the latest capture that satisfies V1–V7
  and whose first request started at or after slot - 10 min. This enforces protocol B2.3: "fetched between 19:50 and
  20:00 ET … no more than 10 minutes old". The other on-time captures are kept as supplementary evidence and are never
  averaged or substituted.
- **The 19:45 capture.** It cannot be the B2.3 snapshot. If it is the only valid capture, the slot's executable price
  is NO_PRICE under B2.3, while the capture is still kept and coverage-counted.
- **Cutoff is final.** A capture completing at or after the slot can never be designated.
- **Namespaces.** Shadow and rehearsal captures live under `shadow/` and `rehearsal/` and can never satisfy V1.

This designation rule applies equally to Windows-era captures. It is a clarification of B2.3 that the owner must adopt
together with B3.

## 6. Privileged Cloudflare administrators

R2 bucket-lock rules stop the Worker and ordinary credentials from overwriting or deleting evidence, but an account
administrator can change or remove those rules. B3 therefore does not rely on bucket locks for **time** or
**authenticity**:

| An administrator could… | Effect |
|---|---|
| Insert a fabricated "pre-cutoff" capture later | **Prevented** by V4 (a new upload carries a new R2 time) and V7 (a TSA cannot issue a past `genTime`). |
| Alter an existing capture | **Detected** by V5: the hash no longer matches the anchored `TICK_SEAL`. |
| Delete a capture or ledger objects | **Detected** by a chain gap or a missing anchored hash. The slot becomes MISSED, with the deletion on record. |
| Change or remove lock policies | **Recorded** in the Cloudflare account audit log (visible to the owner). The evidence rule does not depend on the locks. |

Residual risk: an administrator can destroy evidence, which turns a slot into MISSED. They cannot make an invalid or
late capture count.

## 7. Implementation status

- **V7 anchoring: BUILT (2026-10-09, `src/tsa.js`).**
  - After every sealed tick, the new chain head is timestamped by DigiCert's public TSA, with Sectigo as fallback. No
    account or signup.
  - The token is stored write-once at `ledger-anchors/<month>/<tick>_seq<N>.tsr` (bucket-locked).
  - `/admin/verify` checks every token: granted, echoes the chain hash at its seq, and genTime not before the entry.
  - Offline proof: a DigiCert token over a test hash passed `openssl ts -verify` against the public CA bundle
    ("Verification OK").
  - A failed anchor alerts (`ANCHOR_FAILED`) and never blocks collection. A slot whose seal has no token with genTime
    ≤ slot + 5 min fails V7 and is MISSED.
- **Independent offline verifier: NOT YET WRITTEN.** It is the read-only re-check of §3 with an R2 read-only token plus
  `openssl ts -verify` on each anchor. Due before any authoritative cutover.
- No capture made before both exist can count. Shadow captures never count (V1) in any case.

## Owner decision

- **(a)** Adopt B3 as written, effective from the first authoritative capture after cutover.
- **(b)** Adopt it with changes.
- **(c)** Keep a GitHub anchor.

Until a decision, every cloud capture is shadow evidence only, and no cutover is proposed.
