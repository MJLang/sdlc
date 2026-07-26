# Aggregate review — sdlc-implement

Load this when `sdlc guard implement {NNN}` returns `mode=review`. It carries the
discovery-result contract, reviewer set, component contract, aggregate artifact,
and convergence rules. Everything before it lives in `SKILL.md`.

For a discovery, before aggregate review create `thoughts/designs/{NNN}-discovery.md` in the worktree. It must use this contract:

```md
---
Ticket: thoughts/tickets/{ticket-file}
Plan: thoughts/plans/{plan-file}
Ticket-Hash: sha256=<approved ticket hash>
Plan-Hash: sha256=<approved plan hash>
Baseline: <implementation baseline commit>
Generated-At: <ISO-8601 UTC>
Outcome: validated | invalidated
---

# Discovery Result - Ticket {NNN}

## Question and Hypothesis
## Environment and Versions
## Experiment Matrix
## Findings
## Decision
## Retained Artifacts
## Resource Cleanup
## Follow-up Disposition
```

The matrix maps every AC to its command/fixture, predeclared threshold, observed result, durable evidence path, and `pass`, `invalidated`, or `blocked` disposition. Remove disposable scaffolding/resources and retain only reusable probes or regression fixtures. A missing, malformed, or `inconclusive` result blocks review and landing.

Run `sdlc guard review {NNN}` and require an accepted matrix row before review.
It proves all active children closed, no gate/escalation, a clean worktree, and
mechanically valid existing artifacts. Run `sdlc gates` once more when the
latest code has not already produced the current persisted gate summary.

## Reviewer set and immutable inputs

1. Run `sdlc review-packet {NNN} --head <reviewed-head> --json`. It derives the
   configured reviewer set, classifies every changed path, and emits one packet
   per reviewer. Use `general-code-reviewer` for its explicit unmapped packet;
   recompute packets every round.
2. An unavailable required reviewer is a non-gating escalation: add `human` to the epic, persist the reason, and stop. Never substitute an anonymous contract.
3. Capture one reviewed code HEAD. Give each reviewer only its packet: ticket
   intent/live ACs, approved identity and lane steps, complete changed-file
   inventory, lane-scoped diff, cross-lane interfaces, gate summary, and prior
   finding inventory. Every reviewer reads its lane diff fully, stays inventory
   aware, lightly checks interfaces, states any read beyond the packet, remains
   read-only, verifies the canonical plan hash, and stops on drift.
4. Run reviewers against that one HEAD, concurrently when useful. Do not edit during review. Before aggregation, confirm HEAD is unchanged and the worktree is clean; otherwise discard all reports and restart the same round after reconciling the state.

## Component contract

Each component report must contain exactly one standalone verdict line matching:

```text
Verdict: BLOCKED — <positive n> MUST FIX
Verdict: APPROVED — <positive n> NIT
Verdict: APPROVED
```

Hyphen, en dash and em dash all parse and normalize to ` — `, so the dash character never blocks a round; everything else in the line is exact. Each MUST FIX gets a reviewer-scoped stable ID such as `MF-backend-001`, never reassigned. From round two onward each reviewer first classifies all prior IDs as `fixed` or `persists` with evidence, then performs a complete fresh review against the new HEAD for regressions and new findings.

A component with no MUST FIX must include **Clean-Pass Evidence** covering ticket intent/ACs, plan steps/deviations, canonical sibling conventions, tests/failure paths, and applicable security, data, performance, accessibility, and operational surfaces. There is no requirement to invent findings. Missing/duplicate/malformed verdicts, identity gaps, or clean approval without this evidence receive one retry against the same HEAD; the retry does not consume a round. A second malformed result labels the epic `human`, records evidence, and stops.

For each non-gating escalation above, mutate only the epic under this actor:

```bash
BEADS_ACTOR="<session-actor>" bd update <epic-id> --add-label human --append-notes="escalation: <reviewer unavailable, malformed output, or convergence evidence>"
```

## Aggregate artifact

Write exactly one `thoughts/reviews/{NNN}-round{n}.md` per completed round. Do
not hand-author the format — generate, fill, validate:

1. **Generate.** Emit the skeleton with the identity header already resolved:

   ```bash
   sdlc review-artifact --template {NNN} --round <n> --head <reviewed-head> \
     --reviewers <the reviewer set from step 1> \
     > thoughts/reviews/{NNN}-round{n}.md
   ```

   It fills the title, reviewed code SHA, approved plan SHA-256 and approved
   plan commit from doctor. Pass `--reviewers` with the set the reviewer-set
   step already derived; without it the command re-derives the same list and
   pays for that work twice. It fills nothing else, by design: verdicts,
   findings and control-line values are review evidence and must come from the
   reviewers.

2. **Fill.** Replace each `<!-- component report -->` with that reviewer's report
   verbatim, in the reviewer-name order the template already emitted. Then
   complete the `## Overall` block:

   - `Scope-Check: PASS - unplanned=none`, or `FAIL` with a comma-separated
     unplanned path list when actual code scope is not declared by active plan
     steps.
   - `AC-Coverage: PASS - verified=AC-001,AC-002; missing=none`, or `FAIL` when
     evidence does not verify every live, non-waived AC.
   - `Fix-Disposition: N/A` in round 1; from round 2 on,
     `fixed=<ids|none>; persists=<ids|none>; new=<ids|none>`.
   - One `- <reviewer-name>: <component verdict>` line per reviewer.
   - `Verdict: <aggregate verdict>` as the unique final standalone line.

3. **Validate.** Before committing:

   ```bash
   sdlc review-artifact --validate thoughts/reviews/{NNN}-round{n}.md
   ```

   It exits non-zero and reports every failure with its line number, so one pass
   repairs the whole artifact. A validation failure is a contract failure, not a
   review outcome: fix the artifact and validate again.

A failed structured check blocks the aggregate. Reconcile all component IDs and counts; an old ID may disappear only as `fixed` and an unverifiable fix `persists`.

Before persisting, require every failed Scope/AC control to be represented by at least one applicable component MUST FIX with a stable ID. If the parent detects a failed control that every component missed, return the concrete control evidence to the applicable reviewer for one same-HEAD contract retry. If it still returns no corresponding finding, treat the round as malformed, escalate `human`, and stop. Never emit a blocking aggregate with a zero MUST FIX count or silently convert a parent-only failure into approval.

Sum MUST FIX counts when blocked; otherwise sum NIT counts or approve bare. Commit only the aggregate artifact for that round.

## Convergence

- After the first blocked aggregate, fix every actionable MUST FIX, rerun
  `sdlc gates --cwd <worktree> --target <target>`, commit/push fixes, and create
  fresh packets for the complete reviewer set against the new HEAD.
- If a later aggregate MUST FIX count is greater than or equal to the previous completed round, persist/commit/push the evidence, label the epic `human`, and stop immediately. `Fix-Disposition` lets the human distinguish persistence from churn.
- If the count decreases but remains positive, continue within the three-completed-round cap.
- If round three remains blocked, persist it, label the epic `human`, and stop.
- Any code change invalidates every prior component approval and requires the full reviewer set again.

After an approved aggregate is committed, append and push this binding under the session actor:

```text
review: APPROVED sha=<artifact-commit HEAD> code-sha=<Reviewed code SHA> plan-sha256=<approved hex> plan-commit=<approved main SHA> rounds=<n>
```

After `sdlc guard review {NNN}` accepts an existing artifact, reread only its
identity header and `## Overall` block; the guard already reproduces the full
artifact grammar, AC/scope controls, rounds, hashes, and HEAD binding.

Push the branch and Beads data where remotes exist. Report completed steps, gates, open dedicated gates or escalations, review verdict, approved plan identity, and worktree path. Never merge main; `/sdlc-land {NNN}` remains the human gate.
