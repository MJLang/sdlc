---
name: sdlc-review
version: 0.5.1
description: Prepare an implemented plan's Beads-visible worktree, approved-plan identity, diff, and persisted aggregate review for local human inspection without changing pipeline state.
---

# Local review handoff

Use this human-review surface before `/sdlc-land`. It is not an automated review or state transition. Never edit, stage, commit, push, change Beads, resolve a gate, or invoke `/sdlc-land`.

## Input

`/sdlc-review <NNN> [--editor] [--artifact] [--diff] [--preview] [--port <number>]`

Require `<NNN>`; never guess among plans.

## Procedure

1. From the primary checkout, run `sdlc guard review <NNN>` and then
   `sdlc review <NNN>`. The guard's `pending|existing` matrix proves child,
   gate/escalation, worktree, approval, and aggregate-artifact invariants. On
   refusal, run `sdlc doctor <NNN> --json` only when its coded recovery needs
   more detail. Every Beads query remains `bd --readonly ...`.
2. Resolve and display prominently:
   - absolute canonical ticket and plan paths in primary main;
   - latest reproducible approved plan SHA-256 and approval commit;
   - Beads epic and current doctor state;
   - native Beads-visible worktree path, branch HEAD, merge base, dirty state, and diff stat;
   - latest `thoughts/reviews/<NNN>-round*.md`, reading only its identity header
     and `## Overall` block after the guard accepts it.
   - for discovery, `thoughts/designs/{NNN}-discovery.md`, including outcome and evidence paths. Verify every AC, predeclared thresholds, reproducibility, unsupported conclusions, retained-code scope, and resource cleanup. Discovery always uses normal approved-plan identity, never chore `N/A` identity.
3. Treat worktree ticket/plan copies as snapshots. Report skew as informational and keep linking the canonical main files; never recommend copying or rebasing amended artifact text into the worktree.
4. Use the guard result for component grammar, structured controls, review-note
   and plan-approval bindings, and clean-rebase-chain validation. Warn plainly
   on a refusal; such work is not ready to land.
5. Run an optional action only when the user explicitly requested its flag:
   - `--editor`: open the configured editor at the worktree;
   - `--artifact`: open the persisted aggregate report;
   - `--diff`: present `main...HEAD`;
   - `--preview`: start the configured preview from the worktree and return its URL. Require **Local preview** and **Preview URL** in Project Configuration; substitute `{worktree}` and `{port}`, with default port 4173.

Opening an editor, artifact, diff, or preview never implies approval. Close with the actual doctor/review status and say `/sdlc-land <NNN>` is available only when the user is satisfied and every landing precondition is healthy.

Optional Project Configuration remains:

```md
- **Review editor:** `code {worktree}`
- **Local preview:** `npm run dev -- --port {port}`
- **Preview URL:** `http://localhost:{port}`
```
