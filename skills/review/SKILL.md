---
name: review
version: 0.2.0
description: Prepare an implemented plan's worktree for local human review. Resolve the ticket, plan, worktree, diff, and latest persisted automated-review artifact without making any changes. Use before the human invokes /land.
---

# Local review hand-off

Run this skill when the user asks to inspect an implemented plan locally before landing it. This is a **human-review surface**, not another automated review and not a state transition. It never edits, stages, commits, pushes, changes Beads, or invokes `/land`.

## Input

`/review <NNN> [--editor] [--artifact] [--diff] [--preview] [--port <number>]`

`<NNN>` is the ticket/plan number. If it is absent, ask for it; never guess among multiple plans.

## Procedure

1. Run `sdlc review <NNN>` from the primary checkout. It resolves the matching plan and registered worktree, then prints the ticket, plan, branch SHA, merge base, diff stat, latest review artifact, and dirty/clean state.
2. State the absolute worktree path prominently. Review files are in that checkout; users should not need to navigate `.worktrees/` by hand.
3. Run an optional action only when the user included its explicit flag:
   - `--editor` opens the configured editor in the worktree.
   - `--artifact` opens the latest `thoughts/reviews/<NNN>-round*.md` report.
   - `--diff` presents `main...HEAD` for inspection.
   - `--preview` starts the configured local preview in the background and returns its URL. It requires both **Local preview** and **Preview URL** in `thoughts/AGENTS.md`. `{worktree}` and `{port}` placeholders are supported; use `--port` to choose a port (default 4173).
4. If the automated review is missing, has an invalid verdict, or is blocked, say so plainly. Do not claim the change is ready to land.
5. Close with the concrete next action: the human may invoke `/land <NNN>` only when they are satisfied. Do not infer approval from opening an editor, preview, diff, or artifact.

## Configuration

Projects may add these optional Project Configuration lines to `thoughts/AGENTS.md`:

```md
- **Review editor:** `code {worktree}`
- **Local preview:** `npm run dev -- --port {port}`
- **Preview URL:** `http://localhost:{port}`
```

Keep the preview command project-specific. It must run from the worktree and should respect the passed port. `sdlc review` only runs it when `--preview` is explicit.
