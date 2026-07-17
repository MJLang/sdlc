---
name: chore
version: 0.5.0
description: Human-gated lightweight lane that takes one small low-risk change through an AC-tagged ticket, native Beads ownership/worktree, structured review, merge, and post-merge memory audit without a plan or epic.
argument-hint: <short description of the small change>
disable-model-invocation: true
---

Run the chore lane for `$ARGUMENTS`. Explicit invocation approves this small lane and its eventual merge, but does not waive a later external/destructive decision.

## Lane guard

Refuse and direct the user to `/ticket` when any condition fails:

- the change is not a typo, documentation/configuration correction, dependency bump, or tiny low-risk fix;
- it adds feature surface, schema/public-contract change, or a new pattern;
- expected scope exceeds about five files or 150 changed lines.

If implementation outgrows the boundary, stop without merging, keep the ticket/worktree, and direct the user to create and approve a real plan for the same `{NNN}`.

## Session and resumability

1. Before allocating, look for exactly one existing `Type: chore` ticket marked `Chore lane - no plan` whose normalized title matches this request and whose Bead/worktree or incomplete local merge closeout remains. Resume unimplemented work by stable ticket path and Bead ID. If the ticket is already `implemented`, resume only when one matching local merge commit exists and memory, close/push, cleanup, or slot-release work is demonstrably incomplete; continue after that commit and never merge again. Ambiguous matches require a human choice.
2. Set one unique root actor before the first Beads mutation:

   ```bash
   sdlc actor <runtime> --new
   ```

   Capture the literal and carry it unchanged through this invocation. Per the
   contract actor invariant, prefix every mutation with
   `BEADS_ACTOR="<session-actor>"`; never rely on shell export or an older actor.

3. Require Beads `>=1.1.0` and the native gate/worktree/read-only capabilities; never fall back to labels or raw Git worktrees. Every observation uses `bd --readonly`. In embedded mode, Beads 1.1 does not implement JSON `doctor --agent`, so use `bd --readonly context --json` plus the focused gate, dependency, worktree, stale, orphan, and claim checks. In server mode also require `bd --readonly doctor --agent --json` and `bd --readonly doctor --server --json`. Never repair automatically.

For a proven post-merge recovery, skip ticket allocation, implementation, review, freshness, and merge. Use the existing merge SHA and resume at the post-merge memory/close/push/cleanup steps; if remote movement would require rewriting that SHA, stop for human recovery.

## Ticket, Bead, and worktree

1. For new work, allocate `{NNN}` as `/ticket` does. Write the canonical primary-checkout `thoughts/tickets/{NNN}-{slug}.md` with `Status: approved`, `Type: chore`, configured target, 2-5 stable tags, scope, Open Questions, and at least one stable `AC-NNN` outcome. Include `Chore lane - no plan`. Invocation is the ticket approval.
2. Create one Bead with the ticket as spec and stable identity, then atomically claim it:

   ```bash
   BEADS_ACTOR="<session-actor>" bd create "<title>" --type=chore --priority=3 --spec-id="<ticket path>" \
     --metadata='{"sdlc_ticket":"<ticket path>"}' \
     --description="Chore {NNN}: <scope and ACs>" --silent
   BEADS_ACTOR="<session-actor>" bd update <chore-id> --claim
   ```

   On resume, claim the existing Bead. A different actor blocks the lane; never treat a matching OS/Git user as this session. A new session may resume only after the human verifies the prior session is inactive, establishes a fresh `<recovery-actor>`, and explicitly runs `BEADS_ACTOR="<recovery-actor>" bd update <chore-id> --status=open --assignee="" --append-notes="claim recovery: <evidence>"`; then rerun `/chore` and claim atomically under its new actor.
3. Safely update primary main without stashing/discarding unrelated changes. Create the missing worktree only through:

   ```bash
   BEADS_ACTOR="<session-actor>" bd worktree create .worktrees/{NNN}-c-{slug} --branch={NNN}-c-{slug}
   ```

   Verify/resume an existing path through `bd --readonly worktree list --json`; never use raw `git worktree add`. Publish the branch when a remote exists.

## Implement and gate

1. Edit only inside the worktree. Give any implementer the absolute canonical ticket path and ACs; worktree artifact snapshots are not authoritative.
2. Run `sdlc gates --cwd <worktree> --target <target>`. Use its bounded failure
   excerpt/full-log path, then commit and push only after every configured gate
   passes.
3. If a human decision or external/destructive action becomes necessary, keep the chore open and create:

   ```bash
   BEADS_ACTOR="<session-actor>" bd gate create --type=human --blocks <chore-id> --reason="<specific decision>"
   ```

   Stop and report the gate plus the human recovery command `BEADS_ACTOR="<new-session-actor>" bd gate resolve <gate-id> --reason="<resolution>"`. Do not put a `human` label on the chore for a blocking question and do not use `bd human respond`.
4. Append durable discoveries only as `memory-candidate: key=<slug>; tags=<list>; finding=<fact>; why=<reason>; applies=<scope>; source-step=<chore-id>`. Do not audit, remember, or forget before merge.

## Structured review - at most two completed rounds

1. Run `sdlc review-packet {NNN} --head <reviewed-head> --json`. Chore packets
   carry ticket intent/live ACs with `N/A` plan identity, lane-scoped diffs,
   complete inventory, cross-lane interfaces, gate summaries, and prior
   findings. Use the derived reviewers (including explicit unmapped fallback),
   union duplicate scopes, and recompute every round. An unavailable named
   reviewer labels the chore `human` as a non-gating escalation and stops.
2. Capture a clean immutable code HEAD. Each reviewer reads its packet's lane
   diff fully, remains aware of the complete inventory, checks cross-lane
   interfaces lightly, states any read beyond the packet, and uses
   `bd --readonly`. In round two, verify prior stable `MF-<reviewer>-NNN` IDs
   first, then perform the complete lane review against the new packet.
3. Require exactly one component verdict using the repository's exact grammar:

   ```text
   Verdict: BLOCKED — <positive n> MUST FIX
   Verdict: APPROVED — <positive n> NIT
   Verdict: APPROVED
   ```

   A clean result includes Clean-Pass Evidence for ticket/ACs, deviations, sibling conventions, tests/failures, and applicable risk surfaces. Retry malformed output once against the same HEAD without consuming a round; a second failure labels `human` and stops. If HEAD or cleanliness moves during review, discard all reports and restart the same round.
4. Persist `thoughts/reviews/{NNN}-round{n}.md` with:

   ```md
   # Automated Review - {NNN} round {n}
   Reviewed code SHA: <sha>
   Approved plan SHA256: N/A - chore lane
   Approved plan commit: N/A - chore lane
   Reviewers: <names>

   ## Overall

   Scope-Check: PASS - unplanned=none
   AC-Coverage: PASS - verified=AC-001; missing=none
   Fix-Disposition: N/A

   - <reviewer>: APPROVED

   Verdict: APPROVED
   ```

   Embed component reports verbatim in deterministic order before Overall. Later-round disposition is `fixed=<ids|none>; persists=<ids|none>; new=<ids|none>`. Compare actual files to the ticket's approved small scope for Scope-Check. Reconcile AC evidence, identities, counts, and verdict; the unique final line is Overall `Verdict:`. A failed Scope/AC control must correspond to an applicable component MUST FIX with a stable ID. If every component missed the concrete failure, give that evidence to the applicable reviewer for one same-HEAD contract retry; a second miss is malformed and escalates `human`. Never write a blocking aggregate with a zero MUST FIX count. Commit only the artifact.
5. If round one blocks, fix every MUST FIX, rerun gates, commit/push, then run the complete set against new HEAD. If round-two MUST FIX count is non-decreasing, or round two remains blocked at all, persist evidence, label `human`, and stop. Code changes invalidate all approvals.
6. After approval, append:

   ```text
   review: APPROVED sha=<artifact-commit HEAD> code-sha=<Reviewed code SHA> plan-sha256=N/A plan-commit=N/A rounds=<n>
   ```

## Merge and post-merge memory

1. If Project Configuration enables Beads merge slots, require a previously initialized slot, then run `BEADS_ACTOR="<session-actor>" bd merge-slot acquire --holder="<session-actor>" --json` before final fetch/rebase/pull/merge, omitting `--wait`. A missing slot stops with `BEADS_ACTOR="<new-session-actor>" bd merge-slot create`; a held slot stops and reports holder/age. When disabled, do not use the feature.
2. Refresh main and the worktree. A conflict requires human resolution and fresh
   review. After a clean rebase, rerun
   `sdlc gates --cwd <worktree> --target <target>` and record
   `rebased: <old>-><new> gates=pass`; any code edit invalidates review.
3. In clean primary main, squash the branch, stage the canonical ticket with `Status: implemented`, and create exactly one `chore: <title> (ticket {NNN})` merge commit.
4. Only now audit tagged memories against the merged tree and staged candidates using the same keep/refresh/merge/forget conservatism as `/land`. Every added/refreshed memory cites `Source: chore {NNN}, merge commit <sha>`. Append `memory audit: merge=<sha>; kept=...; refreshed=...; merged=...; forgot=...; added=...` to the chore Bead.
5. If memory work fails, leave the merge commit intact, stop before close/push/cleanup, and record enough completed/pending state for an idempotent resume. Never merge a second time. Retain an acquired merge slot for this incomplete landing when safe; release it only after proving main clean and recording the incomplete merge SHA.
6. Close the Bead under `<session-actor>`, push Git then `BEADS_ACTOR="<session-actor>" bd dolt push`, and verify both independently. Remove the worktree with `BEADS_ACTOR="<session-actor>" bd worktree remove .worktrees/{NNN}-c-{slug}` without `--force`, then delete local/remote branches.
7. Release an acquired merge slot only after main is proven clean and Git/Beads pushes succeed, using `BEADS_ACTOR="<session-actor>" bd merge-slot release --holder="<session-actor>" --json`; push Beads again after release. If only native cleanup remains, release and report it. Retain the slot for a recorded incomplete post-merge recovery or whenever main cleanliness is uncertain.

Report ticket/Bead, merge SHA, diff stat, AC/review result, memory audit, push states, cleanup, and slot disposition.
