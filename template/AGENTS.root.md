# Agent Instructions

This project uses **bd** (beads) for issue tracking — run `bd prime` for full workflow context.

> **Architecture:** Issues live in a local Dolt DB (`.beads/dolt/`); sync uses `bd dolt push/pull` over `refs/dolt/data` on your git remote (separate from `refs/heads/*`). `.beads/issues.jsonl` is a passive export, not the source of truth — see [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md) for anti-patterns.

## Folder Structure

- Use the `thoughts/` folder to define work — the ticket → plan → implement → land pipeline is described in `thoughts/AGENTS.md`.
- `thoughts/docs/` holds product/context docs that tickets are grounded in.

## Beads Issue Tracker

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Quality Gates

<!-- Define the commands that must pass before work merges, and keep them in sync
     with the "Quality gates" line in thoughts/AGENTS.md (Project Configuration). -->

```bash
npm test
```

## Session Completion

**When ending a work session:**

1. **File issues for remaining work** — create beads issues for anything that needs follow-up
2. **Run quality gates** (if code changed) — tests, linters, builds
3. **Update issue status** — close finished work, update in-progress items
4. **Push to remote** — both code and beads data:
   ```bash
   git pull --rebase
   git push
   bd dolt push
   ```
5. **Verify** — all changes committed AND pushed
6. **Hand off** — provide context for next session
