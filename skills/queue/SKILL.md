---
name: queue
version: 0.3.0
description: Build a mechanically read-only dashboard of pipeline work, integrity drift, native Beads gates and recovery signals, and the exact next human action.
---

Build the pipeline dashboard. Do not edit files, Git, or Beads. Never run a Beads command without `--readonly`, and never invoke `--fix`.

## Gather once

Spawn one configured cheap `pipeline-snapshot` subagent to return facts as compact tables. If that profile is unavailable, use the cheapest isolated read-only subagent and report the fallback model. The subagent must not interpret or mutate state.

Collect:

1. Canonical ticket/plan paths, statuses, tags, `Beads Epic`, active step counts, declared files, and review notes.
2. `sdlc doctor {NNN} --json` for every active number, including canonical hashes, approval commit, review identity, warnings, errors, and recommended recovery.
3. Native Beads state through only:

   ```text
   bd --readonly ready --json
   bd --readonly list --status=in_progress --json
   bd --readonly human list --json
   bd --readonly gate list --json
   bd --readonly dep list <open-gate-id> --direction=up --type=blocks --json
   bd --readonly worktree list --json
   bd --readonly stale --status=in_progress --days=1 --json
   bd --readonly orphans --json
   bd --readonly dep cycles --json
   ```

   Run the guarded dependency query once per open gate because Beads 1.1's gate-list payload does not itself include the blocked issue. In embedded mode, use `bd --readonly context --json` and these focused checks; Beads 1.1's embedded `doctor --agent --json` is not a JSON health surface. In configured server mode also collect `bd --readonly doctor --agent --json` and `bd --readonly doctor --server --json`. When Project Configuration enables merge slots, also use `bd --readonly merge-slot check --json`. Do not query or imply an optional slot when disabled.
4. Read-only Git evidence for Beads-visible worktrees: branch/HEAD, dirty state, ahead/behind state, last relevant commit/activity, unpushed commits, and stashes. Also collect approximately five recent main commits that reference tickets.

Use native Beads worktree inventory rather than raw Git output as the mapping authority; Git supplies corroborating safety/activity evidence.

## Interpret carefully

- Doctor state is authoritative for approval/hash legality:
  - `ready_for_planning` -> `/plan {NNN}`;
  - `ready_for_approval` -> `/approve {NNN}`;
  - `healthy` -> `/implement {NNN}` or `/land {NNN}` according to live progress;
  - `reapproval_required` -> `/approve {NNN}` before any new issue claim;
  - `legacy` -> explicit migration, except the documented completed-work landing path;
  - `blocked` -> the exact doctor recovery, never a bypass.
- A worktree ticket/plan snapshot mismatch is informational. Canonical text is in primary main; never recommend copying or rebasing artifacts into a worktree.
- A Beads stale result is only a **candidate** stale claim. Call it stale/crashed only when no recent issue, worktree, or Git activity corroborates the age. Otherwise show the conflicting evidence.
- An orphan result identifies a commit-before-close recovery candidate. Show commit and issue and instruct the human to verify code and gates before an explicit close; never auto-close.
- A dedicated human gate is distinct from a `human` label. A gate blocks a step and is resolved from a fresh mutating root as `BEADS_ACTOR="<new-session-actor>" bd gate resolve`; a label is a non-gating escalation/dashboard signal.
- A dependency cycle, unhealthy Beads store, unsupported version/capability, inconsistent mapping, or unresolved native cleanup blocker is `blocked`.
- An enabled held merge slot reports holder and age. Never wait, release, or infer abandonment; manual stale-holder recovery first proves main clean.

## Report with the human queue first

Use one compact line per item, IDs and next command inline, and omit empty sections:

1. **Needs you now** - approval/reapproval, land-ready review, dedicated gates with blocked step/reason/resolution command, human escalations, legacy migration, blocked doctor recovery, corroborated stale claims, orphan recovery, and merge-slot contention.
2. **In flight** - closed/total active steps, exact claim actor, last Beads and Git activity, Beads-visible worktree, branch SHA, doctor state, and any informational snapshot skew.
3. **Ready to start** - healthy approved plans and ready-for-planning tickets.
4. **Drafts** - tickets awaiting explicit ticket approval.
5. **Recently landed** - recent merge commits.

When evidence justifies recovery, print the command but do not run it:

- stale/legacy claim after human authorization: `BEADS_ACTOR="<new-session-actor>" bd update <claimed-id> --status=open --assignee="" --append-notes="claim recovery: <corroborating evidence>"`, then `/implement {NNN}` under another new actor;
- verified orphan: `BEADS_ACTOR="<new-session-actor>" bd close <issue-id> --reason="recovered from commit <sha>; gates verified"`;
- human gate: `BEADS_ACTOR="<new-session-actor>" bd gate resolve <gate-id> --reason="<decision, including AA-NNN when applicable>"`;
- stale merge slot only after primary main is proven clean: `BEADS_ACTOR="<new-session-actor>" bd merge-slot release --holder="<recorded-holder>"`.
- configured but missing merge slot: from a new authorized root actor, `BEADS_ACTOR="<new-session-actor>" bd merge-slot create`, then rerun doctor.

These are explicit human recovery mutations and must run from a mutating root session with its own `BEADS_ACTOR`; the dashboard itself stays read-only.

Never call `bd human respond` for a gate, `bd doctor --fix`, `bd orphans --fix`, an unclaim/reassign operation, or any state transition. This skill explains recovery; it does not perform it.
