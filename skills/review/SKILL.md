---
name: review
version: 0.3.0
description: Prepare an implemented plan's Beads-visible worktree, approved-plan identity, diff, and persisted aggregate review for local human inspection without changing pipeline state.
---

# Local review handoff

Use this human-review surface before `/land`. It is not an automated review or state transition. Never edit, stage, commit, push, change Beads, resolve a gate, or invoke `/land`.

## Input

`/review <NNN> [--editor] [--artifact] [--diff] [--preview] [--port <number>]`

Require `<NNN>`; never guess among plans.

## Procedure

1. From the primary checkout, run `sdlc doctor <NNN> --json` and `sdlc review <NNN>`. Every Beads query made directly or by a delegated observer must be `bd --readonly ...`.
2. Resolve and display prominently:
   - absolute canonical ticket and plan paths in primary main;
   - latest reproducible approved plan SHA-256 and approval commit;
   - Beads epic and current doctor state;
   - native Beads-visible worktree path, branch HEAD, merge base, dirty state, and diff stat;
   - latest `thoughts/reviews/<NNN>-round*.md`, its Reviewed code SHA, approved plan SHA/commit, structured Overall checks, and final verdict.
3. Treat worktree ticket/plan copies as snapshots. Report skew as informational and keep linking the canonical main files; never recommend copying or rebasing amended artifact text into the worktree.
4. Validate the handoff facts without mutation:
   - aggregate/component verdict grammar is valid and consistent;
   - `Scope-Check`, `AC-Coverage`, and `Fix-Disposition` parse and reconcile;
   - the review note binds the artifact commit and Reviewed code SHA;
   - the artifact's approved plan hash/commit equals the epic's latest reproducible approval;
   - the reviewed HEAD is current or connected only by the permitted recorded clean-rebase chain.

   Warn plainly when the artifact is missing, malformed, blocked, stale against code, or bound to a different plan approval. Such work is not ready to land. Likewise surface doctor `reapproval_required`, `legacy`, or `blocked` with its exact recovery action.
5. Run an optional action only when the user explicitly requested its flag:
   - `--editor`: open the configured editor at the worktree;
   - `--artifact`: open the persisted aggregate report;
   - `--diff`: present `main...HEAD`;
   - `--preview`: start the configured preview from the worktree and return its URL. Require **Local preview** and **Preview URL** in Project Configuration; substitute `{worktree}` and `{port}`, with default port 4173.

Opening an editor, artifact, diff, or preview never implies approval. Close with the actual doctor/review status and say `/land <NNN>` is available only when the user is satisfied and every landing precondition is healthy.

Optional Project Configuration remains:

```md
- **Review editor:** `code {worktree}`
- **Local preview:** `npm run dev -- --port {port}`
- **Preview URL:** `http://localhost:{port}`
```
