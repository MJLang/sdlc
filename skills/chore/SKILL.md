---
name: chore
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

1. **Ticket (audit trail):** allocate the next number and write `thoughts/tickets/{NNN}-{slug}.md` as usual, with `Type: chore` and `Status: approved` (invocation is approval). Note in the body: "Chore lane — no plan."
2. **Bead:** one task, no epic: `bd create "<title>" --type=task --priority=3 --description="Chore {NNN}: <what>"`, then claim it.
3. **Worktree:** from up-to-date main (`git pull --rebase`): `git worktree add .worktrees/{NNN}-c-{slug} -b {NNN}-c-{slug}`, publish with `git push -u origin {NNN}-c-{slug}`.
4. **Implement** the change in the worktree. Commit and push.
5. **Gates:** the gate commands defined in `thoughts/AGENTS.md` (Project Configuration), plus the target's `test` / `typecheck` scripts where defined.
6. **Review — one pass:** dispatch the reviewer mapped to the change's lane in `thoughts/AGENTS.md` (or a general code-review subagent if none is configured). Persist the output to `thoughts/reviews/{NNN}-round1.md` in the worktree and commit it. MUST FIX → fix, re-run gates, one re-review. Still blocked → stop and report; do not merge.
7. **Merge** (squash, as `/land` does): in the main checkout, `git pull --rebase`, `git merge --squash {NNN}-c-{slug}`, flip the ticket → `Status: implemented` in the same commit. Message: `chore: <title> (ticket NNN)`.
8. **Close out:** `bd close <id>`; `git push` + `bd dolt push` (mandatory); remove the worktree and branch (local + remote).
9. **Report:** merge commit, diff stat, review verdict.
