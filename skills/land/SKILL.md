---
name: land
version: 0.3.0
description: Human gate that verifies the reviewed code and approved-plan fingerprint, optionally acquires the Beads merge slot, squash-merges to main, performs the post-merge memory audit, and safely closes and cleans up.
argument-hint: <plan number, e.g. 003>
disable-model-invocation: true
---

Land plan `$ARGUMENTS` only on explicit human invocation. Ticket/plan text is canonical in primary main; code and aggregate review are canonical in the Beads-visible plan worktree.

## Modes

- **Normal:** plan is `Status: approved`, ticket is approved, and the reviewed branch is not merged.
- **Post-merge recovery:** a prior `/land` created the one main merge commit and flipped plan/ticket status, but memory audit, Beads close/push, cleanup, or slot release failed. Prove the existing merge commit contains this exact reviewed change and resume after it; never merge again.

Any other merged/implemented state is already landed or inconsistent and must stop.

In post-merge recovery, validate the existing merge commit and then skip **Freshness** and **Merge once** entirely. Use that commit as `<merge-sha>` and resume at **Post-merge memory audit**. When a remote advanced after the incomplete landing, do not rebase or rewrite the merge SHA: acquire the configured slot, fetch for evidence, and stop for human recovery if the existing merge cannot be pushed without rewriting its identity.

## Read-only preflight

Make `sdlc doctor {NNN} --json` the first action. In normal mode require `healthy`. In post-merge recovery, doctor may report the expected terminal-artifact drift; accept only when the existing local merge commit contains the exact reviewed tree and status flips and the pre-merge approval/review chain still reproduces. Any unrelated doctor error remains blocking. A completed legacy plan may use only the documented legacy closeout path when all issues are closed and its valid legacy approval predates this contract; warn prominently. Open legacy work requires `/approve` migration.

Verify all of the following before main-sensitive work:

1. Plan, ticket, epic, and native Beads-visible worktree resolve uniquely. Every active child is closed and no dedicated gate is open. Any `human` escalation must be resolved explicitly; do not waive it merely because `/land` was invoked.
2. The latest epic approval record is reproducible from its main-reachable commit. Its plan/ticket hashes match the canonical pre-merge artifacts and the plan's source-ticket hash.
3. The latest aggregate artifact exists and is internally valid: expected reviewer set, component verdicts, stable finding dispositions, `Scope-Check`, `AC-Coverage`, `Fix-Disposition`, and unique final Overall verdict all reconcile. Overall must be `APPROVED` or `APPROVED` with NITs.
4. Its Approved plan SHA256/commit equal the epic's latest approval. Any plan amendment after review invalidates the review even if code HEAD is unchanged.
5. The epic review note binds the artifact-commit HEAD, Reviewed code SHA, approved plan hash/commit, and rounds. Current worktree HEAD must equal that artifact commit or be connected only by a recorded clean-rebase chain whose gates passed. Any other code commit requires `/implement` review again.
6. The worktree is clean. Native diagnostics show no unresolved corruption, dependency cycle, orphan ambiguity, or cleanup safety blocker relevant to landing.
7. Every Approval Attention item that required execution-time consent has a matching resolved dedicated-gate record naming its `AA-NNN` and decision. An unresolved item blocks landing; plan approval alone is not consent, and resolution does not require rewriting the canonical plan mid-flight.

Every Beads observation uses `bd --readonly`. Never invoke a repair command automatically.

## Session actor and optional merge slot

Before the first Beads mutation, set one unique root actor:

```bash
sdlc actor <runtime> --new
```

Capture the printed value as `<session-actor>` and carry that exact literal through this invocation. It is also persisted in Git-common state for worktree visibility, but an unqualified latest-actor lookup cannot distinguish overlapping same-runtime roots. Agent tool calls may use fresh shells, so prefix every mutating Beads command with `BEADS_ACTOR="<session-actor>"`; never rely on a prior `export`.

Read `Beads merge slot` from Project Configuration.

- When off, do not create, check, acquire, or release a slot.
- When on, require the capability and a previously initialized slot. If doctor reports `not found`, stop and have an authorized human root session run `BEADS_ACTOR="<new-session-actor>" bd merge-slot create`; rerun `/land` afterward. Never silently create a coordination primitive merely because landing was requested. With an existing slot, acquire **before** any fetch, rebase, pull, or merge:

  ```bash
  BEADS_ACTOR="<session-actor>" bd merge-slot acquire --holder="<session-actor>" --json
  ```

  Never pass `--wait`. If held, report holder and age and stop. Never force/release another holder. Manual stale-holder recovery first proves primary main clean.

Track whether this invocation acquired the slot. On any failure, release it only after proving primary main has no merge/rebase/conflict or uncommitted state. If main cleanliness cannot be proven, retain the slot, add a `human` escalation with evidence, and stop.

## Freshness

1. Fetch in the Beads-visible worktree. If remote main moved, rebase the plan branch onto latest main.
2. On conflict, stop for semantic resolution and require a fresh full `/implement` review. If primary main is proven clean, release an acquired slot before returning.
3. After a clean rebase, run all Project Configuration and target gates. On success append:

   ```text
   rebased: <old-sha>-><new-sha> gates=pass
   ```

   On failure, stop. A clean rebase chain may preserve review validity only under the existing exact-chain rule; any resolution/code edit requires a fresh review.
4. Re-run doctor/read-only review validation against the post-rebase state. Refuse if plan approval drifted or the review binding is no longer valid.

## Merge once

In primary main:

1. Require a clean checkout and safely update main without stashing or discarding unrelated user changes.
2. Run `git merge --squash <plan-branch>`.
3. Before committing, flip the canonical plan to `Status: merged` and ticket to `Status: implemented` in the same staged change.
4. Commit exactly once as `<type>: <ticket title> (ticket {NNN})`, with body references to the plan path and epic ID. Capture this merge commit SHA. Verify its tree and status flips before continuing.

If commit creation fails, restore main to a proven clean pre-merge state without discarding unrelated work, or retain the merge slot and escalate. Never create a second merge commit on rerun; post-merge recovery detects the first by its ticket/plan/epic references and tree.

## Post-merge memory audit

Run only after the merge commit exists. Do not roll back or rewrite that commit because memory maintenance fails.

1. Read plan tags. Retrieve current memories with `bd --readonly memories "tag:<tag>" --json`, deduplicate keys, and inspect each with `bd --readonly recall <key>`.
2. Read every `memory-candidate:` epic note and evaluate it against the merged tree. Include a new landing-time candidate only for a durable repo-wide fact actually proven during landing.
3. Conservatively classify existing memories:
   - keep when accurate and useful;
   - refresh in place when wording, evidence, or applicability needs correction;
   - merge duplicates by writing the canonical memory first, then forgetting the duplicate;
   - forget only when the merged result proves it false, obsolete, or superseded. Uncertainty means keep.
4. Promote only high-signal surviving candidates. Every added/refreshed memory has 2-5 retrieval tags, matching `Index: tag:<tag>` markers, a fact, why it matters, applicability, and:

   ```text
   Source: plan {NNN}, merge commit <merge-sha>
   ```

5. Append to the epic:

   ```text
   memory audit: merge=<merge-sha>; kept=<keys|none>; refreshed=<keys|none>; merged=<keys|none>; forgot=<keys|none>; added=<keys|none>
   ```

If any audit mutation fails, record/report the completed and pending operations and stop before epic close, final push, or cleanup. Keep an acquired merge slot while the landing is incomplete when doing so is safe; if operational policy requires releasing it, first prove primary main clean and record the incomplete merge SHA so queue/doctor can block competing recovery. A rerun enters post-merge recovery and completes the audit idempotently from this summary and the merge commit.

## Close, publish, and clean up

1. Close the epic and any verified straggler issues under the session actor, using reasons where non-obvious. Do not auto-close an orphan without verifying its issue-bearing commit and gates.
2. Push Git, then `BEADS_ACTOR="<session-actor>" bd dolt push` where remotes exist. Verify main is up to date. Report either push independently; never claim cross-store atomicity.
3. Remove the worktree through native safety checks only:

   ```bash
   BEADS_ACTOR="<session-actor>" bd worktree remove .worktrees/<plan-name>
   ```

   Never pass `--force` during landing. Dirty files, unpushed commits, or stashes leave it registered for explicit recovery. After safe removal, delete the local plan branch and its published remote branch.
4. If a merge slot was acquired, release it only after Git and Beads push and primary main cleanliness are proven:

   ```bash
   BEADS_ACTOR="<session-actor>" bd merge-slot release --holder="<session-actor>" --json
   ```

   Push Beads once more so the released state is durable. If only worktree cleanup failed but landing is otherwise published and main is clean, release the slot and report the retained worktree. An explicitly recorded incomplete post-merge recovery may retain the slot to preserve the merge identity; any failure with main not provably clean must retain it and escalate.

Report the approved plan identity, reviewed code/artifact SHAs, merge SHA, status flips, memory audit, epic close, both push states, native cleanup, and merge-slot disposition.
