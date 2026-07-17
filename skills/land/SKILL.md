---
name: land
version: 0.5.0
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

Make `sdlc guard land {NNN}` the first action. The `normal` matrix row proves
unique canonical/Beads/worktree identity, closed children, no open gate,
escalation or orphan ambiguity, reproducible approval hashes, a clean worktree,
an approved aggregate grammar and HEAD binding, and resolved dedicated-gate
evidence for every consent-requiring open `AA-NNN`. The
`post-merge-recovery` row accepts only the terminal status/merge evidence it can
prove and returns `semantic-recovery-proof-required` for the remaining human
tree-equivalence judgment. Any other result refuses; run
`sdlc doctor {NNN} --json` only when the coded recovery needs expanded evidence.

After an accepted normal guard, read only the aggregate identity header and
`## Overall` block. Every Beads observation remains `bd --readonly`; never run a
repair command. Completed legacy work uses only the explicit closeout path;
open legacy work requires `/approve` migration.

For discovery, the guard also requires a valid `thoughts/designs/{NNN}-discovery.md`. Append its `validated|invalidated` outcome and report path to the epic notes and include both in the final handoff. An invalidated result completes only the tested discovery, not a replacement architecture or production implementation.

## Session actor and optional merge slot

Before the first Beads mutation, set one unique root actor:

```bash
sdlc actor <runtime> --new
```

Capture the literal and carry it unchanged through this invocation. Per the
contract actor invariant, prefix every mutation with
`BEADS_ACTOR="<session-actor>"`; never rely on shell export or an older actor.

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
3. After a clean rebase, run
   `sdlc gates --cwd <worktree> --target <target>`. On success append:

   ```text
   rebased: <old-sha>-><new-sha> gates=pass
   ```

   On failure, stop. A clean rebase chain may preserve review validity only under the existing exact-chain rule; any resolution/code edit requires a fresh review.
4. Re-run `sdlc guard land {NNN}` against the post-rebase state. Refuse if plan
   approval, review binding, consent evidence, or native safety drifted; expand
   with full doctor only when needed.

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
   Tags: <2-5 stable tags>
   Index: tag:<tag> tag:<tag>
   Finding: <durable fact>
   Why: <why it matters>
   Applies when: <scope>
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
