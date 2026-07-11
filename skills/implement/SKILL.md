---
name: implement
version: 0.2.0
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

## Capture durable insight

When a step surfaces a non-obvious fact that may outlive this plan — a toolchain gotcha, *why* a gate or flag had to be set an unusual way, a setup/first-run footgun — record it as a **memory candidate**. Do not write it as a memory yet: the completed implementation performs one audit after review, so stale or duplicate advice does not accumulate.

## Review — once per plan, at the end

1. **Derive the required reviewer set from the current diff.** Use the actual changed files (excluding prior `thoughts/reviews/` artifacts), not only the plan's declared `Target`. Dispatch every distinct reviewer mapped to the affected lanes in `thoughts/AGENTS.md` (Project Configuration). Use the shipped `general-code-reviewer` for each changed lane that has no configured reviewer; give every reviewer the ticket and plan paths plus its explicit lane/file scope. Deduplicate repeated reviewer names by giving that reviewer the union of its scopes. Recompute this set for every round. If a required named reviewer is unavailable, flag the epic `human` and stop; never substitute an anonymous reviewer whose verdict contract is unknown.
2. **Run one review round against one HEAD.** Require a clean worktree, record the current code HEAD, and pass that expected SHA explicitly to every required reviewer. Run them against that exact HEAD (concurrently is fine because reviewers are read-only); do not edit or commit between reviewer runs. Each component result must contain exactly one standalone line matching one of `Verdict: BLOCKED — <positive n> MUST FIX`, `Verdict: APPROVED — <positive n> NIT`, or `Verdict: APPROVED`. Retry a missing, duplicate, or malformed verdict once against the same HEAD without consuming a round. If the configured reviewer still violates the contract, flag the epic `human` and stop; never silently replace a configured reviewer with the fallback or infer approval. After collecting valid results, re-read `HEAD` and `git status --short`. If the SHA changed or the worktree is no longer clean, discard every component result, resolve the unexpected state, and restart the same round; never aggregate reports from a mixed or moving HEAD.
3. **Write one aggregate artifact.** In deterministic reviewer-name order, embed each component report verbatim under its own heading in `thoughts/reviews/{NNN}-round{n}.md`. Include the reviewed code HEAD and reviewer list at the top. End the file with an `## Overall` section and make its aggregate `Verdict:` the **final verdict line in the file**:
   - if any component is blocked, sum their MUST FIX counts and emit `Verdict: BLOCKED — <n> MUST FIX`;
   - otherwise, sum all NIT counts and emit `Verdict: APPROVED — <n> NIT`, or bare `Verdict: APPROVED` when the sum is zero.

   Use this shape:

   ```md
   # Automated Review — <NNN> round <n>
   Reviewed code SHA: <sha>
   Reviewers: <comma-separated agent names>

   ## <reviewer-name>
   <component report verbatim>

   ## Overall
   - <reviewer-name>: <component verdict>

   Verdict: <aggregate verdict>
   ```

   This last-line rule makes the artifact machine-readable even though it contains the component `Verdict:` lines. Commit **only** the aggregate artifact in the round commit; its complete findings and NITs travel with the branch.
4. **Resolve a blocked round.** Fix every actionable MUST FIX in the worktree, re-run gates, and commit. Then start a new round against the new HEAD and rerun the **entire** required reviewer set; no approval carries across a code change. Cap at 3 completed aggregate rounds; if still blocked, flag the epic (`bd update <epic-id> --add-label human`) and report.
5. **Record aggregate approval.** After the approved aggregate artifact is committed, record the overall verdict against the resulting HEAD and push:

   ```bash
   bd update <epic-id> --append-notes="review: APPROVED sha=<worktree HEAD sha> rounds=<n>"
   git push
   ```
6. **Audit and maintain tagged memories.** Read the plan's `Tags`. For each tag, run `bd memories "tag:<tag>" --json`; this searches the memory's explicit index marker rather than matching incidental prose. Deduplicate the keys and `bd recall` every candidate returned. Audit each memory against the completed implementation and classify it:
   - **Keep** when it remains accurate and useful.
   - **Refresh** when its wording, evidence, or `Applies when` needs correction; update it in place with the same `--key`.
   - **Merge** when two memories convey the same lesson; write the consolidated canonical memory first, then `bd forget <duplicate-key>`.
   - **Forget** only when the implementation proves it false, obsolete, or superseded. Never forget a memory merely because this plan did not use it; if uncertain, keep it.

   Then promote the high-signal memory candidates that survived the audit. Each memory needs 2–5 plain retrieval tags — include applicable plan tags and, when useful, `decision`, `footgun`, or `convention` — plus the fact, why it matters, when it applies, and its source:

   ```bash
   bd remember "Tags: <plan-tag>, <technology>, <decision|footgun|convention>
   Index: tag:<plan-tag> tag:<technology> tag:<decision|footgun|convention>
   Finding: <durable fact>
   Why: <why it matters>
   Applies when: <scope>
   Source: plan <NNN>, commit <sha>" --key <stable-slug>
   ```

   Record the actions and affected keys on the epic, including an explicit `none` when nothing changed, then sync the Beads database:

   ```bash
   bd update <epic-id> --append-notes="memory audit: kept=<keys|none>; refreshed=<keys|none>; merged=<keys|none>; forgot=<keys|none>; added=<keys|none>"
   bd dolt push
   ```

   This is separate from an issue close `--reason` (which records what happened in one step). Memories are the handful of facts worth carrying into future sessions — keep them few and high-signal. See the Memory guidance in the root `AGENTS.md`.

## Never

- Never merge to main — that is `/land`, a human gate.
- Never edit files outside the worktree. Plan and ticket frontmatter are untouched here; live progress lives in beads.
- Never ask the user questions mid-run — use the `human` label and keep going where possible.

**Report:** steps completed, gate results, review verdict, and worktree path. When the review is approved, tell the user they can inspect it with `/review {NNN}` (or `sdlc review {NNN}`) before invoking `/land {NNN}`; `/land` remains the next human gate.
