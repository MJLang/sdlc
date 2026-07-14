# Agent Instructions

This project uses **bd** (Beads) `>= 1.1.0` for issue tracking and native pipeline coordination — run `bd --readonly prime` for full workflow context. Execute ticket/plan state transitions through the owning skill; the detailed contract lives in `thoughts/AGENTS.md`.

> **Architecture:** Issues live in a local Dolt DB (`.beads/dolt/`); sync uses `bd dolt push/pull` over `refs/dolt/data` on your git remote (separate from `refs/heads/*`). `.beads/issues.jsonl` is a passive export, not the source of truth — see [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md) for anti-patterns.

## Memory (`bd remember`)

Memories load into every session at `bd prime`, so they are for **durable, repo-wide facts that aren't in the code** and that the next session would otherwise re-derive the hard way: a toolchain gotcha, *why* a gate or flag is configured an unusual way, a setup/first-run footgun. Outside an active implementation lane, capture such a fact when you learn it rather than burying it in an issue's close `--reason`. During implementation, stage it as a candidate for `/land` instead.

- **Do** capture: the reason a config looks "wrong but deliberate" (so nobody simplifies it back to broken), first-run footguns, tool-version quirks.
- **Don't** capture: task or step state (that's issues), or anything a reader finds directly in the code, a close-reason, or product docs.
- Keep them **few and high-signal** — every memory taxes every `bd prime`. Beads does not have a native memory-tag field, so put 2–5 stable, plain retrieval tags in the memory content. Reuse the ticket or plan tags where they apply (for example: `db`, `postgres`, `data`), then add `decision`, `footgun`, or `convention` only when useful. Mirror every tag in an `Index:` line as `tag:<tag>` (for example, `tag:db tag:postgres tag:footgun`). Search each tag with `bd --readonly memories "tag:<tag>" --json`, then inspect a candidate with `bd --readonly recall <key>`. The index prevents an incidental prose match such as `data` matching `database`.
- Use one explicit, stable `--key <slug>` per insight. Re-running `bd remember` with that key updates the memory in place; it does not add another value. Store memories in this format:

  ```text
  Tags: db, postgres, footgun
  Index: tag:db tag:postgres tag:footgun
  Finding: <durable fact>
  Why: <why it matters>
  Applies when: <scope>
  Source: plan <NNN>, commit <sha>
  ```

- During implementation, record discoveries only as structured `memory-candidate:` notes on the epic. Do not add, refresh, merge, or forget memories before the work lands.
- After the merge commit exists, `/land` audits memories returned by the work's tags: keep accurate memories, refresh changed advice, merge duplicates (write the canonical memory before forgetting duplicates), and `bd forget <key>` only for facts proven false, obsolete, or superseded. Do not forget a memory merely because the current work did not use it; keep it when uncertain. New or refreshed memories cite the merge commit in `Source`; the audit is recorded on the epic or chore task.

Persistent knowledge goes here — **never** in a `MEMORY.md` file (those fragment across accounts).

## Folder Structure

- Use the `thoughts/` folder to define work — the ticket → plan → implement → land pipeline is described in `thoughts/AGENTS.md`.
- `thoughts/docs/` holds product/context docs that tickets are grounded in.

## Beads Issue Tracker

### Quick Reference

```bash
bd --readonly ready       # Observe available work
bd --readonly show <id>   # Observe issue details
BEADS_ACTOR="<session-actor>" bd update <id> --claim    # Mutating pipeline session only
BEADS_ACTOR="<session-actor>" bd close <id>             # Mutating pipeline session only
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd --readonly prime` for detailed command reference and session close protocol
- Use `BEADS_ACTOR="<session-actor>" bd remember` for persistent knowledge — do NOT use MEMORY.md files
- Every research, critique, review, queue, snapshot, or diagnostic command must use `bd --readonly ...`
- Authorized pipeline mutations use the unique root-session `BEADS_ACTOR`; never reuse a default OS/Git identity to assume ownership
- Use dedicated `bd gate` issues for blocking implementation decisions and Beads-native worktree commands for plan worktrees; do not repurpose implementation issues or bypass native cleanup guards

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
   BEADS_ACTOR="<session-actor>" bd dolt push
   ```
5. **Verify** — all changes committed AND pushed
6. **Hand off** — provide context for next session
