---
name: sdlc-implement
version: 0.6.0
description: Implement an approved, fingerprinted plan in a Beads-managed worktree, execute its dependency graph, and run the bounded structured aggregate review. Use when doctor reports a plan healthy and ready for execution.
argument-hint: <plan number, e.g. 003>
---

Implement plan `$ARGUMENTS` under `thoughts/AGENTS.md`. Canonical ticket and plan text always comes from the primary `main` checkout; worktree copies are non-authoritative snapshots.

## Integrity preflight and ownership

1. Make `sdlc guard implement {NNN}` the first action. The matrix accepts
   `mode=execute` only with compatible ownership and ready work, or `mode=review`
   after all active children close; both require `healthy` and return the plan
   hash, approval commit, epic, ready IDs, and worktree. On refusal follow the
   coded recovery and run `sdlc doctor {NNN} --json` only when more detail is
   required. Never claim before this guard.
2. If a remote exists, fetch and safely update primary main without stashing or overwriting unrelated user changes, then run the same guard again. Refuse if current main cannot be made current safely.
3. Establish one root actor. Inherit only when `/sdlc-next` explicitly invoked this transition and supplied its exact captured actor identity; otherwise treat this as a new root boundary, set `<runtime>`, and run:

   ```bash
   sdlc actor <runtime> --new
   ```

   Capture the literal and carry it unchanged through this invocation. Per the
   contract actor invariant, prefix every mutation with
   `BEADS_ACTOR="<session-actor>"`; never rely on shell export or an older actor.
4. Make the atomic epic claim the first Beads mutation:

   ```bash
   BEADS_ACTOR="<session-actor>" bd update <epic-id> --claim
   ```

   A different owner stops the transition. A repeated claim is resumable only when it is this exact session actor; never equate a shared OS/Git identity with ownership.

All pipeline observations use `bd --readonly`, including reads by implementer/reviewer subagents. The parent owns issue/gate/note mutations unless a subagent is explicitly authorized under the inherited actor.

## Working tree

Use the plan filename without `.md` for both branch and worktree name.

1. Default to **branch mode**: work on branch `<plan-name>` in the primary checkout, no worktree created. Switch to **worktree mode** only when the plan's `Isolation:` frontmatter is `worktree` or the invocation passes `--worktree`; the flag overrides at runtime with no plan amendment and no re-approval, since `branch → worktree` only adds isolation.
2. Inspect `bd --readonly worktree list --json` regardless of mode. If a Beads-visible worktree for this plan already exists, resume it exactly as today: verify its branch, native shared-store state (`local` is the Beads 1.1 worktree-list value for a linked worktree; `shared`/`redirect` remain compatible), and ownership. Legacy worktrees may finish only when native discovery resolves them and safety checks pass.
3. Absent an existing worktree: in branch mode, check out branch `<plan-name>` in the primary checkout; in worktree mode, create one from current main only through:

   ```bash
   BEADS_ACTOR="<session-actor>" bd worktree create .worktrees/<plan-name> --branch=<plan-name>
   ```

   Never fall back to raw `git worktree add`.
4. If the resumed or newly checked-out tree is dirty, reconcile changes with the currently claimed step. Never reset, discard, or blindly commit user or crashed-session work.
5. Publish a newly created branch with `git push -u origin <plan-name>` when a remote exists. Keep later completed steps pushed; report a no-remote repository explicitly.
6. Retain the absolute canonical ticket path, canonical plan path, approved `plan-sha256`, and approved main commit from doctor. Give these values to every implementer and reviewer. Never read the working tree's `thoughts/tickets/` or `thoughts/plans/` as gate truth and never copy an amended plan into it.

## Execution loop

Repeat until every active child issue is closed or gated:

1. At the top of every iteration run
   `BEADS_ACTOR="<session-actor>" sdlc guard implement {NNN}`. This matrix check
   replaces the repeated full-doctor preflight: drift, ownership, gates, and
   ready IDs are projected in one line. `mode=review` ends the execution loop
   and hands off to the aggregate-review contract below; a refusal may be
   expanded with one full doctor call.
2. Select only ready children of this epic. Respect `Depends on` and serialize overlapping `Files`; concurrently execute only plan-declared parallel steps whose file sets are disjoint.
3. Claim each selected child atomically under this session actor. A conflicting owner stops work on that child; do not share it.
4. Give an implementer only this compact immutable step packet:
   - the worktree directory as its only edit root;
   - exact step text and issue ID;
   - `Covers` plus the quoted live AC text for those IDs;
   - declared `Files`, `Depends on`, applicable configured gates/constraints;
   - approved plan hash/commit and absolute canonical plan path;
   - the target and worktree root.

   The full ticket/plan remain available only for a specific ambiguity. The
   subagent verifies `sdlc hash <canonical-plan>` against the supplied literal,
   never edits canonical artifacts, and keeps Beads reads `bd --readonly`.
   Return exactly:

   ```text
   status=<pass|blocked> commit=<sha|none> files=<paths|none> gates=<summary> memory-candidates=<keys|none> blocker=<none|specific blocker>
   ```

   The parent consumes only these handoff facts and owns lifecycle mutations.
5. Run `sdlc gates --cwd <worktree> --target <target>`. Its configured global
   and target commands are authoritative; fix any failure using the bounded
   excerpt/full-log path before closing the issue.
6. Commit one step as `step N: <title> (<issue-id>)`, then push the Git commit when a remote exists. Only after the code is safely published, close the issue with the inline session actor and push Beads. A crash after commit/push but before close is recovered through the issue-bearing commit reported by `bd --readonly orphans --json`; never auto-close merely because an orphan signal exists.
7. At the next iteration, verify that any committed-but-open issue corresponds to the exact expected commit and gates before explicitly closing it. Verify any closed-but-unpushed step before pushing. Do not duplicate commits.

### Human decisions

When a step needs a human product choice, execution-time approval, destructive/external action, or another decision the plan did not settle, keep the step open and create a dedicated gate:

```bash
BEADS_ACTOR="<session-actor>" bd gate create --type=human --blocks <step-id> --reason="<AA-NNN when applicable; specific question and required decision>"
```

Continue other unblocked steps. If nothing remains ready, stop and report the gate ID and human recovery `BEADS_ACTOR="<new-session-actor>" bd gate resolve <gate-id> --reason="<resolution>"`. The resolution reason must name the Approval Attention ID when one exists, leaving an auditable execution-time decision without editing canonical plan text. Never label the implementation step `human`, never use `bd human respond` to answer the question, and never infer resolution. Reserve the `human` label for non-gating escalation such as reviewer failure or convergence stop.

A pre-contract step already labeled `human` is a legacy blocker, not a gate or escalation. Do not auto-convert or call `bd human respond`; require the human's recorded decision, remove the label only when continuing the still-open step is safe, and use dedicated gates for all new questions.

## Memory candidates only

Do not run `bd remember`, `bd forget`, or a memory audit. Append only durable, high-signal candidates to the epic:

```text
memory-candidate: key=<stable-slug>; tags=<comma-list>; finding=<fact>; why=<reason>; applies=<scope>; source-step=<issue-id>
```

`/sdlc-land` evaluates and promotes them after a merge commit exists. Candidates from cancelled work deliberately remain unpromoted.

## Aggregate review

Only when `sdlc guard implement {NNN}` returns `mode=review`, read `review.md`
next to this file (canonically `.agents/skills/sdlc-implement/review.md`) and
follow it. It holds the discovery-result contract, reviewer set, component
contract, aggregate artifact, and convergence rules. Do not load it earlier: it
is irrelevant until every active child issue is closed or gated.

Generate the aggregate artifact with `sdlc review-artifact --template {NNN}
--round <n>` and check it with `sdlc review-artifact --validate <path>` rather
than hand-authoring the grammar.
