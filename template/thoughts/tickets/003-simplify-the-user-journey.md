---
Status: draft
Tags: [sdlc, workflow, ux, recovery, performance]
Type: feature
Target: sdlc
---

# Ticket 003 - Simplify the user journey between human gates

## Summary

The pipeline protects approval, review, and landing boundaries, but it still
asks the user to drive too much of the machinery between them. Ticket approval
requires a manual frontmatter edit. Some recovery instructions expose raw
Beads commands and actor placeholders. Artifact transcription errors can halt
review. Full quality gates may run after every implementation step. The chore
lane and `/sdlc-next` both stop more often than their names imply. Refreshing an
installation can also force the user to reconstruct project configuration.

The intended journey is:

```text
describe work
-> approve the ticket
-> approve the plan
-> resolve a real execution-time decision, when one exists
-> land
```

The workflow should handle planning, implementation steps, review rounds,
routine state checks, and safe recovery between those boundaries. It should
stop with one executable next action whenever a safe action exists. Human
approval and review standards remain unchanged.

This ticket turns the outcomes in
`thoughts/design/simplification-counterproposal.md` into one product release.
Its eight workstreams may become dependent plan steps or separately landed
subplans, but they share one release-level user journey and verification path.

## Dependencies

- Land the current review artifact template and validation work before planning
  the review finalization outcome in AC-002.
- Resolve and land Ticket 002's JSON configuration foundation before planning
  AC-001 and AC-005. Ticket 003 should add only the missing migration and gate
  profile behavior instead of rebuilding the JSON reader, schema, overlay, or
  documentation. If Ticket 002 cannot be approved in its current state,
  disposition it explicitly before planning this ticket.

## Scope

In scope:

- a recoverable move from legacy Project Configuration to
  `.agents/sdlc.json`, without asking the user to copy settings by hand;
- review artifact generation that asks reviewers for evidence and judgment
  while deriving copied identities, counts, summaries, and aggregate verdicts;
- standalone artifact validation that reports ticket, plan, critique, research,
  and discovery errors while the artifact is being written;
- state-bound, task-level commands for ticket approval and every recoverable
  queue, guard, gate, claim, escalation, merge-slot, and orphan stop;
- responsive queue and guard checks, an optional fast gate profile for
  implementation steps, and full gates before review and landing;
- a state-aware `/sdlc-chore` path that completes in one human invocation when
  no genuine decision blocks it;
- resumable first approval and amendment handling that hides Git and Beads
  transaction ordering from the user;
- `/sdlc-next <NNN> --until=human`, which continues mechanical work until the
  next human boundary.

Out of scope:

- removing ticket approval, plan approval, execution-time consent, review
  evidence, or the human landing decision;
- making Beads optional;
- reducing configured reviewers, changed-file inventory, relevant plan-step
  context, or full pre-land gates;
- a general `sdlc bd` passthrough, a third "trivial" lane, or representing a
  chore as a zero-step plan;
- internal cleanup whose only result is fewer modules, enums, exports, or lines
  of prose.

## Acceptance Criteria

- AC-001: Building on Ticket 002's JSON configuration authority, a project using
  the generated 0.5.1 Project Configuration can preview and complete migration
  without manually entering a setting. Invalid or ambiguous input writes
  nothing, an interrupted write is resumable, and two later
  `sdlc setup --force` runs leave shared and local configuration byte-identical.
  A local overlay cannot weaken shared targets, gates, reviewers, Beads mode, or
  merge-slot policy.

- AC-002: Planned and chore reviews use a generate, fill, finalize, and validate
  flow. Reviewers supply findings, dispositions, evidence, and PASS/FAIL
  judgments. The CLI supplies known identities and sets, then derives finding
  counts, summary lines, finding buckets, the aggregate verdict, and the review
  note payload. A copied count, stale summary, wrong aggregate verdict, or dash
  variant cannot consume a review retry or create a human escalation. Existing
  valid review artifacts remain compatible.

- AC-003: `sdlc artifact --validate <path> [--json]` validates tickets, plans
  including their critiques, research syntheses, and discovery results without
  requiring live Beads state. It reports all independently actionable errors
  with a line or stable field. `/sdlc-ticket` cannot report an invalid draft as
  ready, and `/sdlc-plan` cannot reach review status with an invalid plan or
  critique. Doctor and the write-time command use the same parser result.

- AC-004: Every recoverable queue item, guard refusal, and stopped lane supplies
  one complete, task-level command bound to the state that produced it. User
  actions contain no raw `bd`, `BEADS_ACTOR`, actor placeholder, unspecified
  issue ID, or instruction to edit frontmatter. The supported actions include
  ticket approval, gate and escalation resolution, claim resume, merge-slot
  initialization, and read-only orphan inspection. Mutations verify ownership,
  require any human reason, refuse stale state, and are idempotent on replay.

- AC-005: On the same host and real project used for the baseline, the median
  warm accepted implement guard is at or below four seconds across five runs.
  Queue snapshot and next-selection medians each improve by at least 35 percent.
  Configuration supports optional `fast` and required `full` gate profiles.
  Implementation steps may use `fast`; review and landing require `full` bound
  to the current code, target, command list, and configuration. Existing
  configuration keeps its current gate behavior until a fast profile is
  explicitly added.

- AC-006: From a clean checkout, an in-scope chore with passing gates and review
  reaches merged state from one top-level `/sdlc-chore` invocation. The runner
  chooses a branch or worktree from current repository state, runs a configured
  worktree bootstrap before editing when needed, and resumes after interruption
  without duplicating the ticket, issue, branch, worktree, commit, review,
  merge, note, or push. Any human stop returns the action required by AC-004.

- AC-007: First plan approval and later amendments use a deterministic,
  fingerprint-bound reconciliation manifest and an idempotent apply operation.
  Interrupting after any Git mutation, Beads mutation, approval note, or push is
  recoverable by rerunning `/sdlc-approve`. A replay creates no duplicate state
  and never consumes unrelated staged or dirty files. Unresolved critique
  findings, open questions, missing AC coverage, and unrecorded waivers still
  block approval.

- AC-008: `/sdlc-next <NNN> --until=human` creates a fresh snapshot after each
  completed transition and continues planning, implementation, gates, and
  review until a human boundary or unsafe state. It never approves a ticket or
  plan, resolves a gate or escalation, lands, cancels, performs destructive
  cleanup, or switches to another ticket after a refusal. Foreign claim adoption
  requires an explicit numbered invocation with `--adopt`; `--once` preserves
  the current one-transition behavior.

- AC-009: A release fixture completes the whole journey without test-only state
  edits: migrate a 0.5.1 project, approve a ticket without editing frontmatter,
  catch a malformed plan before approval, resume an approval interrupted at
  each transaction phase, continue an approved plan through fast step gates and
  full boundary gates, finalize review evidence, resolve a dedicated human gate
  from the queue action, and stop at ready-to-land without merging. The same
  fixture also completes a chore in one invocation and resumes it after an
  injected crash.

- AC-010: The README and generated workflow contract describe the resulting
  commands and user journey without exposing implementation-only recovery
  procedures. Internal resolver, state, adapter, and documentation refactors
  count toward this ticket only when an acceptance criterion above requires
  them.

## Open Questions

- None.

## Documentation Sources

- `thoughts/design/simplification-counterproposal.md`
- `thoughts/research/simple.md`
- `thoughts/design/workflow-simplification.md`
- `thoughts/tickets/002-project-config-json.md`
- `README.md`
