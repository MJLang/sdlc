# Agent Instructions

This repository uses Beads `>= 1.1.0` for issue tracking and native pipeline
coordination. The workflow contract is `thoughts/AGENTS.md`; execute transitions
through their owning skills.

Only a mutating root pipeline session reads the minimal project context with
`bd --readonly prime` and captures one actor using `sdlc actor <runtime> --new`.
Read-only observers and subagents do not prime. Every observation uses
`bd --readonly`; every authorized mutation supplies the root's exact captured
`BEADS_ACTOR` literal.

Use Beads for task state rather than Markdown TODO lists. Native dedicated gates
hold blocking human decisions, and native worktree commands create/remove plan
worktrees. Never use `bd doctor --fix`, `bd orphans --fix`, raw Git worktree
fallbacks, or another session's claim identity to bypass recovery.

## Memory

Fresh sessions load no memory bodies. `/sdlc-plan` retrieves only tag-matched
memories with `bd --readonly memories "tag:<tag>" --json` plus explicit
`bd --readonly recall <key>`; `/sdlc-land` owns the complete post-merge memory audit
and durable-memory format. Implementation records only `memory-candidate:` epic
notes. Never create `MEMORY.md`.

## Repository Structure

- `thoughts/tickets/`: WHAT/WHY and stable acceptance criteria
- `thoughts/plans/`: approved implementation contract
- `thoughts/designs/`: optional bounded research synthesis
- `thoughts/docs/INDEX.md`: targeted product-document routing
- `thoughts/reviews/`: aggregate review evidence

Before ending an authorized mutating session, run the configured workflow gates,
update Beads state, push Git and Beads where remotes exist, verify both stores
independently, and leave a concise handoff. Read-only sessions make no closeout
mutations.
