---
name: cancel
description: Human gate — cancel a line of work (ticket + plan + epic + worktree), or just the plan to re-plan against the same ticket.
argument-hint: <number> [plan]
disable-model-invocation: true
---

Cancel work for $ARGUMENTS. This is a human gate: it runs only on explicit user invocation.

Scope comes from the second word of the arguments:
- **(default)** — cancel the whole line of work: ticket, plan, epic, worktree, branch.
- **`plan`** — cancel only the plan, to re-plan differently: the ticket returns to `approved`, and `/plan {NNN}` may then write a fresh plan (its precondition permits replacing a `cancelled` one).

## Before destroying anything

1. Resolve what exists for {NNN}: ticket, plan, `Beads Epic`, worktree `.worktrees/<plan-name>`, branch (local and remote).
2. Show the blast radius and, if there is unmerged work, confirm with the user before proceeding:
   - worktree: `git -C .worktrees/<plan-name> status --short` and `git log main..<plan-name> --oneline`
   - epic: open issues (`bd show <epic-id>`)

## Steps

1. **Beads:** close the epic and all open child issues: `bd close <ids...> --reason="cancelled: <short why>"`.
2. **Git** (only after the confirmation above):

   ```bash
   git worktree remove --force .worktrees/<plan-name>
   git branch -D <plan-name>
   git push origin --delete <plan-name>   # if it was published
   ```

3. **Statuses** (the gate flip):
   - scope `plan`: plan → `Status: cancelled`; ticket stays `approved`.
   - default: plan → `cancelled` (if one exists), ticket → `cancelled`.
4. **Push — mandatory:** commit the status flips (`cancel: <ticket title> (ticket NNN) — <short why>`), then `git push` and `bd dolt push`.
5. **Report:** what was cancelled, what was destroyed, and — for scope `plan` — that `/plan {NNN}` is the next step.

Handle partial states gracefully: a ticket with no plan (just flip the ticket), a plan with no epic yet (no beads work), an epic with no worktree (no git work). Cancel what exists, skip what doesn't, report both.
