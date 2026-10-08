# Audit of unexpected commit b2ae835 on `employment-v1` (2026-10-08)

Owner direction 2026-10-08, item 1. This file records facts only. The commit itself is left untouched in history.

## Facts

| Field | Value |
|---|---|
| Commit | `b2ae835d2223b84d2d32a10b73214b959f53e768`, parent `a1f917e` |
| Message | `research(employment): document post-gate edge diagnosis and scoped next experiments` |
| Author / committer | `LHBUSA <sales@localhomebuyersusa.com>` (the same git identity every session on this machine uses) |
| Author date = commit date | 2026-10-08 10:36:57 -0500 (15:36:57Z) |
| Pushed | 15:36:57Z, GitHub activity API: `push` by `LHBUSA`, `a1f917e -> b2ae835` (same second as the commit) |
| Signature | unsigned (GitHub `verification.reason = unsigned`). A GitHub web-UI commit would be GitHub-signed with GitHub as committer, so this was a git client. |
| Trailer | none. Every commit from the owning session carries a `Co-Authored-By` trailer. |
| Scope | one file added: `docs/research/EMPLOYMENT_POSTGATE_EDGE_DIAGNOSTIC_20261008.md` (+70, -0). No code, data, ledger, evidence JSON, protocol, test, cron, Worker or CPI file touched. |

## Source session: not identifiable from local records

- No local reflog has it as a local commit. Its only entries are this worktree's `fetch` and `pull --rebase` at 15:39Z,
  after the push.
- Every Claude Code transcript under `~/.claude/projects` was searched for the file name. The only match is the owning
  session (goodl-c0), which read the file after fetching it. The Codex session store has no session after 2026-10-06.
- The four peer sessions listed at audit time (goodl-38, goodl-54, two goodl-d7) leave transcripts on this machine,
  and none of those transcripts mention the file.
- Conclusion: the author is a git client with push rights under the shared identity, possibly a remote or cloud agent
  or another machine. Its exact source cannot be established from this machine. The owner should treat it as
  unattributed. Rotating or partitioning push credentials is the only way to make this attributable in future, and
  is the owner's call.

## Content review

| Claim in b2ae835 | Verified? |
|---|---|
| Label sign error in the V1 comparison | Yes. Already corrected in a1f917e (erratum), before b2ae835. |
| U-3: 106/316 priced contracts quoted > 2 h before cutoff, max 71 h; payrolls 39/279, max 46 h | Yes, reproduced exactly (`fresh-quote-sensitivity.mjs`). |
| Fresh (<= 2 h) U-3: 38 releases, 210 contracts, market LL 0.394 vs V1 0.505; payrolls 31/240, 0.470 vs 0.756 | Yes, reproduced exactly. b2ae835 gave no intervals; they are now in `employment-v1-kalshi-fresh-quote-sensitivity.json`. |
| Statistics should use the release, not the contract, as the unit | Correct, and already how V1 was scored. Now pre-registered for V2 (Amendment B2). |
| 2026 payroll sub-period favours V1 (7 events, driven by Jan/Feb) | Arithmetic not re-derived. It is a post-hoc sub-period selection and is not used anywhere. |
| CPS flows (E->U, U->E, N->U, U->N) as a U-3 feature family | Hypothesis only. Not in the frozen V2 protocol, and not adopted. Would need a vintage-availability audit and a new owner-approved amendment. |
| Alternative forecast horizons (T-14D/T-7D/T-3D) | Hypothesis only. Not adopted. The frozen V2 cutoff stays T-1D 20:00 ET. |
| "Decision: HOLD deployment; GO on narrow ... research" | **Not an owner decision.** The only owner decisions are the dated owner directions. This line authorizes nothing. |

## Disposition

- **Kept and adopted:** the quote-age finding, through protocol Amendment B0 (8a84177), plus executable-price and
  liquidity rules and release-level units (Amendment B2). It was adopted by owning-session commits that cite it, not by
  editing b2ae835.
- **Not adopted:** CPS flows, horizon search, the 2026 sub-period result and the "GO" line.
- **Not reverted:** it is docs-only, its numbers check out, and reverting would rewrite a pushed branch.

## Single ownership of research branches (rule from 2026-10-08)

1. `employment-v1` and any future Employment research or capture branch have exactly one owning session at a time, named
   in the owner's direction. Only the owner's direction transfers ownership.
2. Any commit not made by the owning session is **foreign**. It is audited like this one before anything builds on it,
   adopted only through an owning-session commit that cites it, and never treated as a decision, gate change or
   evidence.
3. A foreign commit that touches a frozen ledger, evidence JSON, gate, or a capture file is void for gate purposes
   whatever it says. The owning session restores the frozen content in a new commit; history is never rewritten.
4. Prospective capture files (V2 protocol section 5) count only if written by the single scheduled collector and pushed
   before the release. The GitHub push time is the external timestamp. b2ae835 shows that git commit dates are
   self-reported and prove nothing.
5. Before every push, the owner session runs `git fetch` and audits any unseen commit (this happened for b2ae835: the
   push was rejected, the commit reviewed, then rebased onto).
