---
name: next
description: Autonomous loop dispatcher — perform exactly one legal pipeline transition (plan an approved ticket, or implement an approved plan) and queue the human gates. Designed to be driven by /loop.
disable-model-invocation: true
---

Run ONE iteration of the ticket → plan → implement pipeline (`thoughts/AGENTS.md`). Strictly non-interactive: never ask the user anything; flag decisions with the `human` label (`bd update <id> --add-label human`).

## Derive state — from disk and beads only, never from memory of past sessions

Spawn ONE read-only subagent (Explore, cheapest available model tier — mechanical parsing) to collect the snapshot and return it as a compact table, no prose. Do not gather inline: in loop mode this runs every iteration, and the driver's context must stay small for the `/implement` that may follow.

1. Plans: `Status` + `Beads Epic` of every file in `thoughts/plans/`.
2. Tickets: `Status` of every file in `thoughts/tickets/`.
3. Live: `bd ready`, `bd list --status=in_progress`, `bd human list`, and per in-flight epic: claim holder + last-activity times.
4. In-flight file sets: for every plan that is `approved` with open epic issues, the union of the files its steps declare.

The subagent gathers facts only. The transition decision below — legality, overlap, claim semantics — is made HERE, by you, from the snapshot.

## Pick the highest-priority legal transition — first match wins, execute exactly one

1. **Implement**: a plan with `Status: approved`, an epic recorded, open issues in the epic, the epic NOT claimed/in_progress by another session, **and no overlap between its declared file set and any in-flight plan's** → invoke `/implement {NNN}`. It claims first; if the claim fails, treat the plan as owned elsewhere and fall through to the next candidate. Candidates skipped for file overlap are reported, never silently dropped.
2. **Plan**: a ticket with `Status: approved` and no plan file with its number → invoke `/plan {NNN}`.
3. **Idle**: no legal transition → report idle immediately and stop. Keep this path cheap — no research, no subagents.

## Never

- Never perform `/approve`, `/land`, `/cancel`, or `/chore` — those are human gates. Instead, end every report with the **human queue**:
  - plans in `Status: review` (awaiting `/approve`),
  - plans whose epic notes carry an APPROVED review verdict (awaiting `/land`),
  - anything in `bd human list`,
  - **stale claims** — epics claimed/in_progress with no beads or git activity for >24h: likely a crashed session; a human should unclaim, after which `/implement` resumes cleanly.
- Never ask questions. On ambiguity, flag the nearest issue with the `human` label and move on.

One transition per invocation. When it completes (or refuses), report and stop — the outer `/loop` schedules the next iteration.
