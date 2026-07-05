---
name: land
description: Human gate — merge an implemented plan's worktree into main, flip plan/ticket statuses, close the beads epic, clean up, and push.
argument-hint: <plan number, e.g. 003>
disable-model-invocation: true
---

Land plan $ARGUMENTS. This is a human gate: it runs only on explicit user invocation.

## Preconditions — verify ALL; refuse with the specific failure otherwise

1. The plan exists with `Status: approved` and `Beads Epic:` set; the worktree `.worktrees/<plan-name>` exists.
2. Every issue in the epic is closed. Open `human`-labeled issues block landing unless the user explicitly waives them — list them and confirm.
3. The epic's notes contain `review: APPROVED sha=<sha>`, and that sha either equals the worktree's current HEAD or is connected to it by an unbroken chain of `rebased: <old>→<new> gates=pass` notes (written in step 1). Any other commits after the verdict mean the review phase of `/implement` must re-run first.
4. The review artifact exists in the worktree: `thoughts/reviews/{NNN}-round*.md`.

## Steps

1. **Freshness.** In the worktree: `git fetch`; if main has moved, rebase onto latest main.
   - Rebase **conflicts** → STOP. Conflict resolution is semantic risk: resolve in the worktree, then re-run `/implement`'s review phase (new HEAD ⇒ new verdict) before landing.
   - Rebase **clean** → re-run the quality gates (the gate commands in `thoughts/AGENTS.md` + target tests), then record the hop: `bd update <epic-id> --append-notes="rebased: <old-sha>→<new-sha> gates=pass"`. Gate failures block landing.
2. **Merge** — default is squash: one ticket = one reviewable unit = one commit on main.

   ```bash
   git pull --rebase          # in the main checkout
   git merge --squash <plan-name>
   ```

   Before committing, flip the state files **in the same commit**: plan → `Status: merged`, ticket → `Status: implemented`. Commit message: `<type>: <ticket title> (ticket NNN)`, body referencing the plan file and epic id.
3. **Close beads:** `bd close <epic-id>` plus any straggler step issues (`--reason` where non-obvious).
4. **Push — mandatory** where the root `AGENTS.md` grants git authority (skip only if the repo has no remote; note it in the report):

   ```bash
   git push
   bd dolt push
   git status   # MUST show "up to date with origin"
   ```

5. **Clean up:**

   ```bash
   git worktree remove .worktrees/<plan-name>
   git branch -D <plan-name>
   git push origin --delete <plan-name>
   ```

6. **Report:** the merge commit, statuses flipped, epic closed, cleanup done.
