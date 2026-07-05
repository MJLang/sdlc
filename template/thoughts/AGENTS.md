# Workflow Setup

- Do not edit files outside of the ticket-plan tree of the current task

The pipeline is **ticket → plan → implement → land**. This file describes the artifacts and their states. Every state transition is owned by a skill — run the skill, never flip a `Status` by hand. The one exception: approving a ticket (`draft` → `approved`) is a deliberate hand-edit by the human — that edit *is* the gate:

| Skill | Transition | Gate |
|---|---|---|
| `/ticket <idea>` | new ticket (`draft`) | — |
| — (hand-edit, the one exception) | ticket `draft` → `approved` | **human** |
| `/plan <NNN>` | ticket `approved` → plan (`review`) | — |
| `/approve <NNN>` | plan `review` → `approved`; creates beads epic + issues. Re-run on an approved plan = **amendment re-sync** | **human** |
| `/implement <NNN>` | executes approved plan in its worktree; ends with a review verdict | — |
| `/land <NNN>` | merge to main; plan → `merged`, ticket → `implemented` | **human** |
| `/chore <idea>` | lightweight lane: chore ticket → worktree → gates + one review → merge, in one pass | **human** |
| `/cancel <NNN> [plan]` | cancel the line of work (or just the plan, to re-plan); closes epic, removes worktree | **human** |
| `/queue` | read-only dashboard: in flight, stalled, awaiting a human | — |
| `/next` | one autonomous iteration (for `/loop`); never crosses human gates | — |

**State rule:** frontmatter `Status` records the last gate an artifact passed and changes only at hand-offs. Live execution state (what is in progress *right now*) lives in beads only — look it up via the plan's `Beads Epic` id (`bd show <id>`, `bd list --status=in_progress`), never by editing frontmatter.

**Chore lane:** small, low-risk changes (typo, docs, config tweak, dep bump) skip the plan: `/chore` runs the whole lane in a single human-invoked pass. If the diff outgrows ~5 files / ~150 lines, the change leaves the lane and gets a real plan.

## Project Configuration

> Edit this section for your project — the pipeline skills read these values.

- **Targets:** `app` <!-- the areas of the repo work can land in, e.g. cms | jobs | web | utils for a monorepo, or a single name for a simple repo -->
- **Quality gates:** `npm test` <!-- the command(s) that must pass after every implementation step, e.g. root `pnpm check` plus workspace test/typecheck scripts -->
- **Reviewers:** all targets → `backend-code-reviewer` <!-- map targets to the shipped reviewer agents, e.g. cms|jobs|utils → backend-code-reviewer, web → frontend-code-reviewer; UI targets should use frontend-code-reviewer -->
- **Product docs:** `thoughts/docs/` <!-- where tickets ground their Summary; add your product/vision doc here -->
- **Frontend constraints:** none <!-- e.g. "no new pages until the design system in apps/web is established; route UI design through impeccable" -->

## Tickets

Tickets are the originating point of most of the work in this system. They are the starting artifacts of work, laying out the ideas and overall feature/work definition to be implemented. They are *not* concrete implementations, but rather high-level descriptions of what needs to be done.
Each ticket is a self-contained unit of work and should be able to fit into a single reviewable unit of work.

- They live in [./tickets].

Frontmatter Includes:
- Status: 'draft' | 'approved' | 'implemented' | 'cancelled'
  - `draft` → `approved` is a human decision; it makes the ticket eligible for `/plan`.
  - `approved` → `implemented` is flipped by `/land` when the plan's worktree merges.
- Tags: A list of tags associated with the ticket.
- Type: 'feature' | 'bug' | 'refactor' | 'chore'
- Target: one of the targets defined in Project Configuration above

Naming Conventions:
- {NUMBER}-{KEBAB-CASE-TITLE} / Example: `001-setup-test-harness`

## Plans

Plans are the concrete steps to take to complete a ticket. They are written by `/plan` based on the ticket's target and any other relevant context. If they include frontend work, they also honor the project's frontend constraints (Project Configuration) for on-brand implementation.

- They live in [./plans]
- They include an implementation plan broken down in steps. Each step carries an explicit `Depends on:` line; steps with disjoint file sets are marked parallelizable.
- The `Depends on:` lines are the machine-readable dependency graph — they become beads issue dependencies at approval. A mermaid diagram of the step graph is optional, for human readability only.
- Plans include a beads list. Each plan is its own beads epic.
- Beads epics (and their step issues) are created by `/approve` when the plan is approved.

**Amendments** — plans change after approval; the sanctioned path is: edit the plan file, then re-run `/approve {NNN}` to re-sync the epic. Rules:
- Step numbers are immutable — never renumber. New steps get fresh numbers and place themselves via `Depends on:`.
- Removed steps stay in the file, marked `~~Step N~~ — removed: <why>`.
- Amending mid-flight is safe: a running `/implement` re-derives its issue set from beads each iteration, so added steps join its queue automatically.

Frontmatter Includes:
- Status: 'draft' | 'review' | 'approved' | 'merged' | 'cancelled'
  - `review` = awaiting human review. `review` → `approved` only via `/approve`; `approved` → `merged` only via `/land`.
  - There is deliberately no `in progress` status — live progress is a beads query, not frontmatter.
- Tags: A list of tags associated with the ticket.
- Type: 'feature' | 'bug' | 'refactor' | 'chore'
- Target: one of the targets defined in Project Configuration above
- Ticket Origin: The ticket that this plan is associated with
- Beads Epic: The beads epic that this plan is associated with (set by `/approve`)

Naming Conventions:
- {NUMBER}-{TYPE-FIRST-LETTER}-{KEBAB-CASE-TITLE} / Example: `001-f-setup-test-harness`
- The Number is always the same number as the ticket number.

## Reviews

Full review output is persisted verbatim to `thoughts/reviews/{NNN}-round{n}.md`, written inside the worktree during the review phase and merged to main at `/land` — the audit trail travels with the change. The machine-checked verdict (`review: APPROVED sha=...`) lives on the epic's notes; the file holds the complete findings, including NITs (fodder for later chore tickets).

## Implementation

Implementation is owned by `/implement` and happens only after a plan is `approved`. Its first action is claiming the epic (`bd update <epic-id> --claim`) — the concurrency mutex that keeps parallel sessions and loops off the same plan.

Each plan is implemented within its own git worktree at `.worktrees/<plan-name>` (worktree and branch are both named after the plan) so it stays separate from the main branch. The branch is published immediately, and implementer subagents execute the steps in beads dependency order — one commit per step, pushed as soon as the step closes, so a crashed session strands nothing.
After each step, the quality gates run inside the worktree: the gate commands in Project Configuration plus the target's own `test` / `typecheck` scripts where defined. A step is closed in beads only when its gates pass.

`/next` schedules around declared file sets: it will not start a plan whose files overlap a plan already in flight.

## After Implementation

One full code review per plan, at the end (not per step — the per-step check is the mechanical gates). The reviewer is dispatched by the plan's `Target` using the reviewer mapping in Project Configuration; both lanes' reviewers if the diff spans lanes, a thorough general code review if none is configured. MUST FIX findings are fixed and re-reviewed until APPROVED; each round is persisted to `thoughts/reviews/` and the verdict is recorded on the epic's notes (`review: APPROVED sha=...`), which is the precondition `/land` checks. Merging to main is `/land`, a human gate.
