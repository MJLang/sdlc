---
name: plan
description: Write an implementation plan for an approved ticket. Use when a ticket in thoughts/tickets is approved and needs a concrete plan before implementation.
argument-hint: <ticket number, e.g. 003>
---

Write the plan for ticket $ARGUMENTS — the instruction artifact of the pipeline in `thoughts/AGENTS.md`.

## Preconditions — refuse with the specific failure if unmet

1. The ticket `thoughts/tickets/{NNN}-*.md` exists.
2. The ticket has `Status: approved`. If `draft`, tell the user to review and approve the ticket first.
3. No plan with number {NNN} exists in `thoughts/plans/` (unless its `Status` is `cancelled`). If one exists, stop and report it — plans are revised, not duplicated.

## Steps

1. **Research first.** Read the ticket in full, the product docs in `thoughts/docs/`, and the code of the ticket's Target. Understand existing conventions before proposing anything — the plan must follow the repo's grain, and the code reviewers will hold the implementation to it.
2. **Frontend constraint.** If the plan includes frontend work, check `thoughts/AGENTS.md` (Project Configuration) for design-system constraints (e.g. no new pages until the design system exists) and honor any configured design skill for on-brand implementation. Note both in the plan.
3. **Write** `thoughts/plans/{NNN}-{t}-{kebab-case-title}.md` — `t` = first letter of Type, `NNN` = same number as the ticket:

   ```yaml
   ---
   Status: review
   Tags: []
   Type: <type>
   Target: <target>
   Ticket Origin: <ticket filename>
   Beads Epic:
   ---
   ```

   (`Beads Epic` stays empty — `/approve` fills it.)

   Body sections:
   - **Context** — why this work exists, link to the ticket, the relevant existing code.
   - **Implementation Steps** — numbered. Each step states: what to do, files touched, and an explicit `Depends on: step N` line (or `Depends on: none`). Steps must be independently completable and gate-checkable. Mark steps whose file sets are disjoint as parallelizable. These `Depends on:` lines become beads issue dependencies at approval — they are the machine-readable form; a mermaid diagram of the step graph is optional, for human readability only.
   - **Quality Gates** — what must pass after every step: the gate commands defined in `thoughts/AGENTS.md` (Project Configuration), plus the target's own `test` / `typecheck` / `build` scripts where defined.
   - **Verification** — how to exercise the finished work end-to-end, mapped to the ticket's acceptance criteria.
   - **Open Questions** — anything unresolved.

4. **Stop at `review`.** Do NOT create beads issues, worktrees, or code. Report the plan path and that it awaits human review → `/approve {NNN}`.

If something is ambiguous and no user is available (unattended run), do not guess silently: record it under **Open Questions** — the human resolves it at review time.
