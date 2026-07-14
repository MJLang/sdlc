---
name: implement
version: 0.3.0
description: Implement an approved, fingerprinted plan in a Beads-managed worktree, execute its dependency graph, and run the bounded structured aggregate review. Use when doctor reports a plan healthy and ready for execution.
argument-hint: <plan number, e.g. 003>
---

Implement plan `$ARGUMENTS` under `thoughts/AGENTS.md`. Canonical ticket and plan text always comes from the primary `main` checkout; worktree copies are non-authoritative snapshots.

## Integrity preflight and ownership

1. Make `sdlc doctor {NNN} --json` the first action. Refuse unless it returns `healthy` and identifies one approved plan, ticket, epic, latest reproducible approval record, and no native coordination blocker. `reapproval_required` means `/approve {NNN}`; `legacy` requires explicit migration; `blocked` requires the reported recovery. Never claim first and validate later.
2. If a remote exists, fetch and safely update primary main without stashing or overwriting unrelated user changes, then run doctor again. Refuse if current main cannot be made current safely.
3. Establish one root actor. Inherit only when `/next` explicitly invoked this transition and supplied its exact captured actor identity; otherwise treat this as a new root boundary, set `<runtime>`, and run:

   ```bash
   sdlc actor <runtime> --new
   ```

   Capture the printed value as `<session-actor>` and carry that exact literal through this invocation. The actor is persisted in Git-common state for worktree visibility, but an unqualified latest-actor lookup cannot distinguish overlapping same-runtime roots. Because agent tool calls may use fresh shells, prefix every mutating Beads command with `BEADS_ACTOR="<session-actor>"`; never rely on a prior `export`. Pass the same literal identity and prefix rule to every authorized mutating subagent. A later root session must use a different actor.
4. Make the atomic epic claim the first Beads mutation:

   ```bash
   BEADS_ACTOR="<session-actor>" bd update <epic-id> --claim
   ```

   A different owner stops the transition. A repeated claim is resumable only when it is this exact session actor; never equate a shared OS/Git identity with ownership.

All pipeline observations use `bd --readonly`, including reads by implementer/reviewer subagents. The parent owns issue/gate/note mutations unless a subagent is explicitly authorized under the inherited actor.

## Worktree

Use the plan filename without `.md` for both branch and worktree name.

1. Inspect `bd --readonly worktree list --json`. Create a missing worktree from current main only through:

   ```bash
   BEADS_ACTOR="<session-actor>" bd worktree create .worktrees/<plan-name> --branch=<plan-name>
   ```

   Never fall back to raw `git worktree add`. If a matching Beads-visible worktree exists, verify its branch, native shared-store state (`local` is the Beads 1.1 worktree-list value for a linked worktree; `shared`/`redirect` remain compatible), and ownership, then resume it. Legacy worktrees may finish only when native discovery resolves them and safety checks pass.
2. If the resumed worktree is dirty, reconcile changes with the currently claimed step. Never reset, discard, or blindly commit user or crashed-session work.
3. Publish a newly created branch with `git push -u origin <plan-name>` when a remote exists. Keep later completed steps pushed; report a no-remote repository explicitly.
4. Retain the absolute canonical ticket path, canonical plan path, approved `plan-sha256`, and approved main commit from doctor. Give these values to every implementer and reviewer. Never read worktree `thoughts/tickets/` or `thoughts/plans/` as gate truth and never copy an amended plan into the worktree.

## Execution loop

Repeat until every active child issue is closed or gated:

1. Re-run `sdlc doctor {NNN} --json` at the top of every iteration, before selecting work. Any ticket/plan drift or new approval identity stops immediately before another issue claim and reports `/approve {NNN}`. Re-derive the issue graph with `bd --readonly show <epic-id> --json` and eligibility with `bd --readonly ready --json`.
2. Select only ready children of this epic. Respect `Depends on` and serialize overlapping `Files`; concurrently execute only plan-declared parallel steps whose file sets are disjoint.
3. Claim each selected child atomically under this session actor. A conflicting owner stops work on that child; do not share it.
4. Give an implementer subagent:
   - the worktree directory as its only edit root;
   - absolute canonical ticket and plan paths;
   - approved plan hash and commit;
   - exact step text, issue ID, `Covers`, and `Files`;
   - current repository instructions and the requirement to follow existing conventions.

   The subagent must verify `sdlc hash <canonical-plan>` equals the supplied approved hash before editing. It must not edit canonical artifacts. Beads reads, if needed, use `bd --readonly`; the parent performs lifecycle mutations.
5. Run Project Configuration gates plus applicable target test/typecheck/build commands in the worktree. Fix failures before closing the issue.
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

`/land` evaluates and promotes them after a merge commit exists. Candidates from cancelled work deliberately remain unpromoted.

## Aggregate review

Run review only after all active implementation children are closed, no gate is open, the worktree is clean, and quality gates pass.

### Reviewer set and immutable inputs

1. Derive the required reviewer set from actual changed paths against main, excluding `thoughts/reviews/`. Use every configured lane reviewer; use `general-code-reviewer` for an unmapped changed lane; deduplicate a repeated reviewer by unioning scopes. Recompute every round.
2. An unavailable required reviewer is a non-gating escalation: add `human` to the epic, persist the reason, and stop. Never substitute an anonymous contract.
3. Capture one reviewed code HEAD. Give every reviewer the exact HEAD, canonical ticket/plan paths, approved plan hash/commit, lane scope, current ACs, and, for rounds after one, the prior finding inventory. Every reviewer is read-only, uses `bd --readonly`, verifies the canonical plan hash, and stops on drift.
4. Run reviewers against that one HEAD, concurrently when useful. Do not edit during review. Before aggregation, confirm HEAD is unchanged and the worktree is clean; otherwise discard all reports and restart the same round after reconciling the state.

### Component contract

Each component report must contain exactly one standalone verdict line matching:

```text
Verdict: BLOCKED — <positive n> MUST FIX
Verdict: APPROVED — <positive n> NIT
Verdict: APPROVED
```

This em-dash verdict grammar is exact. Each MUST FIX gets a reviewer-scoped stable ID such as `MF-backend-001`, never reassigned. From round two onward each reviewer first classifies all prior IDs as `fixed` or `persists` with evidence, then performs a complete fresh review against the new HEAD for regressions and new findings.

A component with no MUST FIX must include **Clean-Pass Evidence** covering ticket intent/ACs, plan steps/deviations, canonical sibling conventions, tests/failure paths, and applicable security, data, performance, accessibility, and operational surfaces. There is no requirement to invent findings. Missing/duplicate/malformed verdicts, identity gaps, or clean approval without this evidence receive one retry against the same HEAD; the retry does not consume a round. A second malformed result labels the epic `human`, records evidence, and stops.

For each non-gating escalation above, mutate only the epic under this actor:

```bash
BEADS_ACTOR="<session-actor>" bd update <epic-id> --add-label human --append-notes="escalation: <reviewer unavailable, malformed output, or convergence evidence>"
```

### Aggregate artifact

Write exactly one `thoughts/reviews/{NNN}-round{n}.md` per completed round, with component reports verbatim in deterministic reviewer-name order:

```md
# Automated Review - {NNN} round {n}
Reviewed code SHA: <reviewed HEAD>
Approved plan SHA256: <hex>
Approved plan commit: <main SHA>
Reviewers: <comma-separated names>

## <reviewer-name>
<component report verbatim>

## Overall

Scope-Check: PASS - unplanned=none
AC-Coverage: PASS - verified=AC-001,AC-002; missing=none
Fix-Disposition: N/A

- <reviewer-name>: <component verdict>

Verdict: <aggregate verdict>
```

For later rounds use `Fix-Disposition: fixed=<ids|none>; persists=<ids|none>; new=<ids|none>`. `Scope-Check` is `FAIL` with a comma-separated unplanned path list when actual code scope is not declared by active plan steps. `AC-Coverage` is `FAIL` when evidence does not verify every live, non-waived AC. A failed structured check blocks the aggregate. Reconcile all component IDs and counts; an old ID may disappear only as `fixed` and an unverifiable fix `persists`.

Before persisting, require every failed Scope/AC control to be represented by at least one applicable component MUST FIX with a stable ID. If the parent detects a failed control that every component missed, return the concrete control evidence to the applicable reviewer for one same-HEAD contract retry. If it still returns no corresponding finding, treat the round as malformed, escalate `human`, and stop. Never emit a blocking aggregate with a zero MUST FIX count or silently convert a parent-only failure into approval.

The `Verdict:` in `## Overall` is the unique final standalone line in the file. Sum MUST FIX counts when blocked; otherwise sum NIT counts or approve bare. Commit only the aggregate artifact for that round.

### Convergence

- After the first blocked aggregate, fix every actionable MUST FIX, rerun gates, commit/push fixes, and start a complete fresh round against the new HEAD.
- If a later aggregate MUST FIX count is greater than or equal to the previous completed round, persist/commit/push the evidence, label the epic `human`, and stop immediately. `Fix-Disposition` lets the human distinguish persistence from churn.
- If the count decreases but remains positive, continue within the three-completed-round cap.
- If round three remains blocked, persist it, label the epic `human`, and stop.
- Any code change invalidates every prior component approval and requires the full reviewer set again.

After an approved aggregate is committed, append and push this binding under the session actor:

```text
review: APPROVED sha=<artifact-commit HEAD> code-sha=<Reviewed code SHA> plan-sha256=<approved hex> plan-commit=<approved main SHA> rounds=<n>
```

Push the branch and Beads data where remotes exist. Report completed steps, gates, open dedicated gates or escalations, review verdict, approved plan identity, and worktree path. Never merge main; `/land {NNN}` remains the human gate.
