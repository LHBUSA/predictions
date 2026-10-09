# Employment V2: proposed Amendment B3. Cloud-native capture validity (PROPOSED; NOT ADOPTED)

Status: **PROPOSED, awaiting owner decision.** The frozen protocol (`EMPLOYMENT_V2_PROTOCOL.md`) is unchanged until the
owner adopts this text. Raised 2026-10-09, after the owner's direction to remove GitHub from the collector runtime.

## Requirements that name GitHub today

| Document | Text | Effect if GitHub pushes stop |
|---|---|---|
| V2 protocol **B2.5** (frozen) | Capture files count only if written by the single scheduled collector and pushed before 08:30 ET on release day, as shown by the GitHub push record, not the git commit date. | No Tier A capture made by the cloud collector could count. |
| V2 protocol, prospective forecasts step 3 (Tier B, HOLD) | Write one JSON per release and commit + push it before the 08:30 ET release; the commit time is the proof. | Tier B could not start as written. |
| Collection proposal, "Where it runs" | Host is the owner's Windows machine; it does not use Cloudflare. The GitHub push record is the external timestamp. | Superseded by the owner's direction of 2026-10-09 (Cloudflare Workers is the permanent runtime). |
| Tier A authorization 2026-10-08, item 5 | A private GitHub evidence trail. | Superseded by the owner's direction of 2026-10-09 for new evidence; the historical repo stays intact. |

## What the GitHub record proved, and the Cloudflare equivalent

| Property | GitHub mechanism | Cloudflare mechanism (built, `pbe-employment-collector`) |
|---|---|---|
| External, non-backdatable time of storage | Push record (GitHub's clock) | The R2 object **upload time**, assigned by R2 and not settable by the Worker. A later re-upload can only carry a later time, and write-once storage plus bucket locks forbid re-uploads anyway. |
| Content integrity | Git object ids | sha256 per object, verified by R2 on upload and stored with the object; recorded again in each capture's metadata |
| Append-only history; deletion and rewrite detection | Commit chain + branch protection (no force-push, no delete) | Hash-chained audit ledger (`seq`, `prev`, `hash`). Every tick's `TICK_SEAL` entry carries the sha256 of every evidence object written in that tick. The ledger is held twice, as write-once R2 objects and as append-only Durable Object rows. **R2 bucket lock rules** make evidence prefixes non-deletable and non-overwritable at the platform level. |
| Single writer | One scheduled collector + ownership rule | One Durable Object lease per namespace; the authoritative namespace is written only in `MODE=authoritative` |
| Audit | `git log`, `fsck` | `GET /admin/verify`, which re-checks:<br>- every object hash;<br>- every recorded file hash;<br>- every order book;<br>- MISSED vs OK per slot;<br>- the chain end to end, matched against the Durable Object head;<br>- every sealed file still present with its sealed hash;<br>- and reports a per-capture `timestamp_proof` (R2 upload time vs recorded completion, slot and release). |

## Proposed text (replaces the GitHub clause of B2.5; the rest of B2.5 is unchanged)

> Capture files count only if:
> - they were written by the single scheduled collector (`pbe-employment-collector`, authoritative namespace);
> - their R2 upload time, as assigned by R2, is before 08:30 ET on release day; and
> - they are sealed in the hash-chained audit ledger by a `TICK_SEAL` whose chain verifies end to end.
>
> For Kalshi slot snapshots, the existing `completed_before_slot` rule still decides on-time status; the R2 upload time
> must also be before the slot plus 5 minutes, or the snapshot is void. Captures in the historical GitHub repository
> keep their GitHub push record as proof.

Tier B wording (forecast JSON "committed and pushed") would need the same substitution when Tier B is authorized; it
stays on HOLD and is not changed here.

## Owner decision needed

Adopt B3 as written, adopt it with changes, or keep a GitHub anchor. Until the decision, cloud captures are **shadow
evidence only**. No authoritative cutover is proposed before B3, or an equivalent, is adopted.
