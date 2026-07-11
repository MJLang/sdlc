---
name: chore
version: 0.2.0
description: Human gate — the lightweight lane. Take a small, low-risk change (typo, doc fix, config tweak, dep bump) end-to-end in one pass — chore ticket → worktree → gates + one review → merge — without a plan or epic.
argument-hint: <short description of the small change>
disable-model-invocation: true
---

Run the chore lane for: $ARGUMENTS. This is a human gate: invocation IS the approval — which is why this skill may merge to main at the end, and why it runs only on explicit user invocation.

## Lane guard — refuse and point to /ticket if any of these fail

- The change is small and low-risk: typo, docs, config tweak, dependency bump, tiny bugfix.
- No new feature surface, no schema/contract changes, no new patterns being established.
- Expected diff ≲ 5 files / ~150 lines. If the diff outgrows this during implementation, STOP: keep the ticket, tell the user it needs a real plan (`/plan {NNN}`), and leave the worktree in place for it.

## Steps

1. **Ticket (audit trail):** allocate the next number and write `thoughts/tickets/{NNN}-{slug}.md` as usual, with `Type: chore`, `Status: approved` (invocation is approval), and 2–5 stable memory-retrieval tags as `/ticket` would (include the target name). Note in the body: "Chore lane — no plan."
2. **Bead:** one task, no epic: `bd create "<title>" --type=task --priority=3 --description="Chore {NNN}: <what>"`, then claim it.
3. **Worktree:** from up-to-date main (`git pull --rebase`): `git worktree add .worktrees/{NNN}-c-{slug} -b {NNN}-c-{slug}`, publish with `git push -u origin {NNN}-c-{slug}`.
4. **Implement** the change in the worktree. Commit and push.
5. **Gates:** the gate commands defined in `thoughts/AGENTS.md` (Project Configuration), plus the target's `test` / `typecheck` scripts where defined.
6. **Review — at most two aggregate rounds:**
   - At the start of every round, derive the reviewer set from the actual diff, excluding prior `thoughts/reviews/` artifacts. Use every distinct mapped reviewer needed by the changed lanes and `general-code-reviewer` for an unmapped lane. Deduplicate a repeated reviewer name by unioning its scopes. Recompute the set in round 2 because a fix may add a lane. If a required named reviewer is unavailable, label the chore bead `human` and stop; never substitute an anonymous reviewer.
   - Require a clean worktree, record the code HEAD, pass that expected SHA to every reviewer, and run the entire set against it. Require exactly one `BLOCKED — <positive n> MUST FIX` / `APPROVED — <positive n> NIT` / `APPROVED` verdict from each. Retry malformed output once against the same HEAD; if it remains invalid, label the chore bead `human` and stop. Before aggregation, re-read HEAD and status; if either moved or became dirty, discard the results, resolve the unexpected state, and restart the same round.
   - Persist one `thoughts/reviews/{NNN}-round{n}.md` artifact. Its header records `Reviewed code SHA` and `Reviewers`; component reports follow verbatim in reviewer-name order; `## Overall` comes last with the final verdict line. Sum blocking MUST FIX counts, otherwise sum NITs. Commit only that artifact.
   - If blocked, fix MUST FIX findings, re-run gates, commit, and start round 2 from reviewer-set derivation against the new HEAD. Still blocked → stop and report; do not merge.
7. **Memory audit — after an APPROVED review only:** use the chore ticket's tags to retrieve candidates with `bd memories "tag:<tag>" --json`, which searches the memories' explicit index markers. Deduplicate and `bd recall` them, then keep, refresh, merge, or forget only memories proven obsolete or superseded. Capture any new durable decision, convention, or footgun using the structured tagged-memory format from `AGENTS.md`, including matching `Index: tag:<tag>` entries; never add an untagged or unindexed memory. Append a `memory audit: ...` summary to the chore bead.
8. **Merge** (squash, as `/land` does): in the main checkout, `git pull --rebase`, `git merge --squash {NNN}-c-{slug}`, flip the ticket → `Status: implemented` in the same commit. Message: `chore: <title> (ticket NNN)`.
9. **Close out:** `bd close <id>`; `git push` + `bd dolt push` (mandatory); remove the worktree and branch (local + remote).
10. **Report:** merge commit, diff stat, review verdict, memory-audit actions.
