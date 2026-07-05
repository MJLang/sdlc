---
name: implement
description: Implement an approved plan in its own git worktree — claim the beads epic, execute steps via subagents in dependency order, run quality gates per step, then one full code review. Use when a plan is approved and its beads epic exists.
argument-hint: <plan number, e.g. 003>
---

Implement plan $ARGUMENTS per the pipeline in `thoughts/AGENTS.md`.

## Preconditions — refuse with the specific failure if unmet

1. The plan exists, has `Status: approved`, and `Beads Epic:` is set. If `review` → needs `/approve` first. If `merged` → already done.
2. **Claim the epic as the very first action** — this is the concurrency mutex:

   ```bash
   bd update <epic-id> --claim
   ```

   If it is already claimed / in_progress by another session, STOP: another loop or session owns this plan.

## Setup

1. From an up-to-date main (`git pull --rebase`), create the worktree — path and branch are both the plan name (plan filename without `.md`):

   ```bash
   git worktree add .worktrees/<plan-name> -b <plan-name>
   ```

   If the worktree or branch already exists, resume it — do not recreate. On resume with a dirty worktree: diff the uncommitted changes against the in-progress step and either finish or reset them; never blindly commit.
2. Publish the branch immediately: `git push -u origin <plan-name>` — from here on, nothing exists only locally. (Skip only if the repo has no remote; note it in the report.)

## Execution loop

Repeat until every issue in the epic is closed. **Re-derive the issue set from beads at the top of every iteration** — plans can be amended mid-flight (`/approve` re-sync), and newly added issues simply join the queue.

1. `bd ready` → pick unblocked issues belonging to the epic. Claim each before working: `bd update <id> --claim`.
2. For each claimed issue, spawn an implementer subagent (Agent tool) working **inside the worktree directory**, giving it: the ticket, the plan, the step's text, and the instruction to follow existing repo conventions. Steps the plan marks parallelizable (disjoint file sets) may run as concurrent subagents; otherwise serialize — parallel edits to overlapping files in one worktree will conflict.
3. After each step, run the plan's quality gates inside the worktree: the gate commands defined in `thoughts/AGENTS.md` (Project Configuration), plus the target's own `test` / `typecheck` scripts where defined. Gates fail → fix before proceeding.
4. Gates pass → commit in the worktree (one commit per step: `step N: <title> (<issue-id>)`), `bd close <issue-id>`, and `git push` — every finished step is on the remote branch the moment it closes; a crashed session strands nothing.
5. Blocked on something only a human can decide → flag it (`bd update <issue-id> --add-label human`), leave the issue open, and continue with other unblocked steps. If nothing else can proceed, stop and report.

## Review — once per plan, at the end

1. Dispatch the reviewer mapped to the plan's `Target` in `thoughts/AGENTS.md` (Project Configuration) — both lanes' reviewers if the diff spans lanes; a thorough general code-review subagent if no reviewer is configured. Pass the ticket and plan paths.
2. Persist each round's full reviewer output verbatim to `thoughts/reviews/{NNN}-round{n}.md` inside the worktree and commit it — the review is an artifact that travels with the branch; its NITs are fodder for later chore tickets.
3. MUST FIX findings → fix in the worktree, re-run gates, commit, re-review (next round, next file). Cap at 3 rounds; if still blocked, flag the epic (`bd update <epic-id> --add-label human`) and report.
4. On APPROVED: commit the final review file first, then record the verdict against the resulting HEAD and push:

   ```bash
   bd update <epic-id> --append-notes="review: APPROVED sha=<worktree HEAD sha> rounds=<n>"
   git push
   ```

## Never

- Never merge to main — that is `/land`, a human gate.
- Never edit files outside the worktree. Plan and ticket frontmatter are untouched here; live progress lives in beads.
- Never ask the user questions mid-run — use the `human` label and keep going where possible.

**Report:** steps completed, gate results, review verdict, worktree path, and that `/land {NNN}` is the next (human) step.
