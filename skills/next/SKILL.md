---
name: next
version: 0.3.0
description: Autonomous dispatcher that performs exactly one legal plan or implement transition and reports human gates. Use as one iteration of an unattended loop.
disable-model-invocation: true
---

Run exactly one iteration of the pipeline in `thoughts/AGENTS.md`. Never ask a question, cross a human gate, or perform a second transition after the selected transition completes or refuses.

## Root session and snapshot

1. Establish one unique root actor for possible mutation, with `<runtime>` set to the current runtime:

   ```bash
   sdlc actor <runtime> --new
   ```

   Capture the printed identity as `<session-actor>` and propagate that exact literal unchanged into `/implement`. The actor is also persisted in Git-common state for worktree visibility, but every child mutation uses `BEADS_ACTOR="<session-actor>"`; do not rely on shell-export persistence or an unqualified latest-actor lookup, and do not generate another actor in the child transition.
2. Spawn one `pipeline-snapshot` subagent to gather facts only and return a compact table. Use the configured cheap profile; if unavailable, use the cheapest isolated read-only subagent and report the fallback model. Do not gather inline.
3. Mechanically constrain every subagent Beads command to `bd --readonly`. Its snapshot includes:
   - canonical ticket/plan paths, statuses, `Beads Epic`, declared active-step file union, and latest review note;
   - `sdlc doctor {NNN} --json` state and recovery for every active number;
   - `bd --readonly ready --json`, in-progress issues and claim actors, `bd --readonly human list --json`, and `bd --readonly gate list --json`; for each open gate, resolve its blocked issue with `bd --readonly dep list <gate-id> --direction=up --type=blocks --json` because the Beads 1.1 gate-list payload omits that edge;
   - `bd --readonly context --json`, `bd --readonly worktree list --json`, `bd --readonly stale --status=in_progress --days=1 --json`, `bd --readonly orphans --json`, and `bd --readonly dep cycles --json`; configured server mode additionally uses both guarded `doctor --agent` and `doctor --server` JSON checks (Beads 1.1 embedded mode does not implement agent-doctor JSON);
   - read-only Git/worktree activity needed to corroborate candidate stale claims and declared-file overlap;
   - `bd --readonly merge-slot check --json` only when Project Configuration enables merge slots.

The subagent does not resolve gates, label issues, claim work, repair Beads, or decide transitions. Make legality and overlap decisions here from its snapshot.

## Select one transition

Use deterministic number order within each priority. First legal match wins.

1. **Implement first.** Select only a plan for which:
   - doctor is `healthy`;
   - status is `approved`, the epic exists, and active children remain open;
   - at least one child is ready and not blocked by a dedicated gate (other gated children remain visible and do not freeze unrelated work);
   - no different actor owns its epic or selected work;
   - no unresolved orphan-recovery or corroborated stale/crashed-claim condition makes execution ambiguous; and
   - its declared active-step files do not overlap the union for any other in-flight plan.

   Invoke `/implement {NNN}` with the inherited actor. A claim race or implementation refusal ends this invocation and is reported; do not fall through to another plan or ticket.
2. **Plan second.** Select an approved ticket with no active plan only when doctor reports `ready_for_planning`. Invoke `/plan {NNN}`. Its completion or refusal ends this invocation.
3. **Idle.** If neither exists, report idle immediately without research or additional agents.

Plans skipped for overlap remain visible with the conflicting plan/path set. Never silently drop them.

## Human queue in every report

Report compactly:

- `ready_for_approval` plans -> `/approve {NNN}`;
- approved aggregate reviews bound to current code and plan hashes -> `/land {NNN}`;
- `reapproval_required` -> `/approve {NNN}`;
- `legacy` -> explicit migration or permitted completed-work closeout;
- `blocked` -> doctor's exact correction/recovery action;
- open dedicated gates -> gate ID, blocked step, reason, and `BEADS_ACTOR="<new-session-actor>" bd gate resolve <gate-id> --reason="<resolution>"`;
- `human`-labeled non-gating escalations;
- orphaned issue-bearing commits -> verify the commit/issue/gates and recover explicitly, never auto-close;
- candidate stale claims only when Beads age and Git/worktree inactivity agree; report the current actor and the human recovery `BEADS_ACTOR="<new-session-actor>" bd update <claimed-id> --status=open --assignee="" --append-notes="claim recovery: <evidence>"`, but never execute it;
- enabled merge-slot contention -> holder and age; never wait or release it;
- draft tickets awaiting human ticket approval.

Never invoke `/approve`, `/review`, `/land`, `/cancel`, or `/chore`; never call `bd doctor --fix`, `bd orphans --fix`, resolve a gate, or mutate labels merely to make work runnable. One transition per invocation, including a refused attempt.
