---
name: queue
description: Read-only dashboard of the ticket → plan → implement → land pipeline — what is in flight, what is stalled, and what awaits a human decision. Use when the user asks what needs them, what's in progress, or for overall pipeline status.
---

Build the pipeline dashboard. Strictly read-only — no mutations to files, beads, or git.

## Gather — delegate to a cheap subagent

Spawn ONE read-only subagent (Explore, cheapest available model tier — this is mechanical parsing) to collect the snapshot below and return it as a compact table, no prose. Do not gather inline: delegation keeps this session's context clean.

1. Tickets: `Status` of every file in `thoughts/tickets/`.
2. Plans: `Status` + `Beads Epic` of every file in `thoughts/plans/`.
3. Beads: `bd ready`, `bd list --status=in_progress`, `bd human list`, and per in-flight epic: open/closed child counts, last-activity times, and any `review:` / `rebased:` notes.
4. Worktrees: `git worktree list`; branches ahead of main.
5. Recently landed: the last ~5 main commits referencing tickets.

Interpretation of the snapshot (staleness, what needs a human) happens here, not in the subagent.

## Report — human queue first

1. **Needs you now**
   - plans in `Status: review` → awaiting `/approve`
   - epics whose notes carry `review: APPROVED` for the worktree's HEAD → awaiting `/land`
   - `bd human list` flags
   - **stale claims** — epics claimed/in_progress with no beads or git activity for >24h: likely a crashed session; note the recovery (unclaim, then `/implement` resumes)
2. **In flight** — plans `approved` with open epic issues: N/M steps closed, claim holder, last activity, worktree path
3. **Ready to start** — plans `approved` awaiting `/implement`; tickets `approved` without a plan (→ `/plan`)
4. **Drafts** — tickets in `draft` awaiting your approval
5. **Recently landed** — the last few merges

Keep it compact — one line per item, with ids and the next command inline. Omit empty sections.
