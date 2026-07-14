# Workflow Setup

- Do not edit files outside the ticket-plan tree of the current task.
- Run state transitions through their owning skill. Do not reproduce them with ad hoc Git or Beads commands.

The pipeline is **ticket -> plan -> implement -> land**. Frontmatter records the last human gate an artifact passed; Beads records live execution. Every transition is owned by a skill except the deliberate human edit that approves a draft ticket.

| Skill | Transition | Gate |
|---|---|---|
| `/ticket <idea>` | new ticket (`draft`) | - |
| Human edit | ticket `draft` -> `approved` | **human** |
| `/plan <NNN>` | approved ticket -> plan (`review`) | - |
| `/approve <NNN>` | plan `review` -> `approved`; creates or syncs the Beads graph and commits the gate artifacts | **human** |
| `/implement <NNN>` | executes an approved plan in its worktree; ends with an aggregate review verdict | - |
| `/review <NNN>` | prepares the implemented worktree for local human inspection; does not merge | - |
| `/land <NNN>` | squash-merges; plan -> `merged`, ticket -> `implemented` | **human** |
| `/chore <idea>` | small-change lane: ticket -> worktree -> gates -> review -> merge | **human** |
| `/cancel <NNN> [plan]` | cancels the line of work, or only its plan for re-planning | **human** |
| `/queue` | mechanically read-only pipeline dashboard | - |
| `/next` | performs exactly one legal autonomous transition; never crosses a human gate | - |

There is no `in progress` frontmatter state. Query live state through Beads and the plan's `Beads Epic`; never change artifact status to represent execution activity.

The chore lane is for a small, low-risk change (roughly no more than five files or 150 changed lines). Larger or riskier work needs a ticket and plan.

## Project Configuration

> Edit this section for the project. Pipeline skills and `sdlc doctor` read these values.

- **Targets:** `app` <!-- repo areas work can land in, e.g. cms | jobs | web | utils -->
- **Quality gates:** `npm test` <!-- commands required after every implementation step -->
- **Reviewers:** all targets -> `backend-code-reviewer` <!-- map targets to shipped reviewers; unmapped lanes use general-code-reviewer -->
- **Product docs:** `thoughts/docs/` <!-- source material for ticket summaries -->
- **Frontend constraints:** none <!-- project-specific UI/design-system constraints -->
- **Beads merge slot:** `off` <!-- off | on; opt in only with a proven stale-holder recovery procedure -->
- **Beads mode:** `embedded` <!-- embedded | server; use server for genuinely concurrent root writers -->
- **Review editor:** <!-- optional, e.g. `code {worktree}` -->
- **Local preview:** <!-- optional, e.g. `npm run dev -- --port {port}` -->
- **Preview URL:** <!-- optional, e.g. `http://localhost:{port}` -->

The executable workflow requires Beads `>= 1.1.0`. Embedded mode is appropriate for one mutating root session plus read-only subagents. Server mode is recommended when multiple root sessions genuinely mutate Beads concurrently; setup never starts a persistent server automatically. Before changing `Beads merge slot` to `on`, establish a new authorized actor and initialize the one native slot with `BEADS_ACTOR="<session-actor>" bd merge-slot create`; doctor blocks an enabled-but-missing slot.

## Authority and Native Beads Rules

| Concern | Authority |
|---|---|
| Ticket, research synthesis, and approved plan text | Primary `main` checkout |
| Approved ticket/plan identity | Latest reproducible `approval:` note on the Beads epic |
| Execution graph, progress, claims, gates, and notes | Beads |
| Implementation code and aggregate review artifact | Plan worktree |
| Durable project memory | Beads memories, promoted after merge |

Ticket and plan files inside a worktree are snapshots and are never authoritative gate inputs. Implementers and reviewers receive absolute paths to the canonical files in the primary checkout plus the approved plan hash. Plan amendments reach execution through the updated Beads graph and canonical main text; do not merge, rebase, copy, or cherry-pick artifact snapshots into a live worktree.

Native execution rules:

- Every root pipeline invocation uses one unique actor, `BEADS_ACTOR=sdlc:<runtime>:<session-id>`, for all authorized Beads mutations. Create it with `sdlc actor <runtime> --new` only at a new root-session boundary, capture the printed identity, and carry that exact literal through the invocation. The CLI also persists it in Git-common state for worktree visibility, but an unqualified latest-actor lookup is not a concurrency boundary for overlapping same-runtime roots. Because agent tool calls may use fresh shells, every mutation supplies the captured literal inline as `BEADS_ACTOR="<session-actor>" bd ...` rather than trusting a prior `export`. A `/next -> /implement` chain inherits the same actor. A later session never impersonates a prior claim owner.
- Research, critique, review, snapshot, queue, and doctor contexts invoke every Beads command as `bd --readonly ...`. Prompt-level read-only wording is not the enforcement boundary.
- After a read-only preflight, `/implement` makes `BEADS_ACTOR="<session-actor>" bd update <epic-id> --claim` its first mutation. A different owner blocks execution.
- A blocking implementation decision creates a dedicated human gate with `BEADS_ACTOR="<session-actor>" bd gate create --type=human --blocks <step-id> --reason="..."`. Resolve it from a fresh authorized root with `BEADS_ACTOR="<new-session-actor>" bd gate resolve <gate-id> --reason="..."`; never close or repurpose the implementation step. The `human` label is only for non-gating escalation.
- Create and remove plan worktrees with `BEADS_ACTOR="<session-actor>" bd worktree create` and `BEADS_ACTOR="<session-actor>" bd worktree remove`. Never force normal cleanup or silently fall back to raw `git worktree` commands.
- Epic and child `spec-id` fields point to the canonical repository-relative plan path. Metadata contains only `sdlc_ticket`, `sdlc_plan`, and child `sdlc_step` identity values; it never copies prose or hashes.
- `BEADS_ACTOR="<session-actor>" bd batch` is permitted only for amendment operations that fit its supported Beads-only grammar and already have stable IDs. It is not Git/Beads atomicity.
- When merge slots are enabled, `/land` acquires one without waiting before main-sensitive work. It releases only after success or after a failed attempt proves main clean; otherwise it retains the slot and escalates.

Beads formulas, molecules, swarms, persisted `set-state` workflow state, interaction analytics, and contributor preflight are not part of this pipeline. `/next` remains the only dispatcher.

## Hash and Doctor Contract

`sdlc hash <file>` computes the pipeline's normalized full-file SHA-256 and prints exactly `sha256=<hex>`. All transitions use this command or its shared implementation; do not substitute platform-specific shell hashing.

Plans record the canonical ticket hash in frontmatter:

```yaml
Source Ticket Hash: sha256=<hex>
```

`/approve` updates frontmatter, commits the ticket, plan, and associated research synthesis to main, hashes those committed files, and appends this immutable epic note:

```text
approval: plan-sha256=<hex> ticket-sha256=<hex> commit=<main-sha>
```

The latest reproducible note is authoritative. Editing the ticket or plan after approval requires `/approve <NNN>` amendment re-sync before implementation or landing.

Use `sdlc doctor <NNN>` for concise diagnostics and `sdlc doctor <NNN> --json` for machine consumption. Doctor is read-only and reports exactly one state:

| State | Meaning |
|---|---|
| `ready_for_planning` | Approved ticket is structurally valid and has no active plan. |
| `ready_for_approval` | Review-state plan is valid and awaits `/approve`. |
| `healthy` | Hash chain, Git, Beads, worktree, and applicable review state agree. |
| `reapproval_required` | Canonical ticket/plan drifted or lacks a reproducible approval. |
| `blocked` | A structural or coordination invariant makes the next transition unsafe. |
| `legacy` | Artifact predates this contract and needs explicit migration or permitted closeout. |

Doctor also reports Beads version/capabilities, applicable health, dependency cycles, human gates, worktrees, corroborated stale claims, orphaned issue-referencing commits, merge-slot state, and review consistency. Beads 1.1 embedded mode does not implement JSON `doctor --agent`, so doctor uses guarded context plus focused native checks there; configured server mode runs both agent and server doctor profiles. It never repairs or closes anything. Worktree-local ticket/plan skew is informational because main is canonical.

## Tickets

Tickets define **what and why**, not implementation. They live in `thoughts/tickets/` and use `<NNN>-<kebab-title>.md`.

Frontmatter includes:

- `Status`: `draft | approved | implemented | cancelled`
- `Tags`: two to five stable, lowercase memory-retrieval terms
- `Type`: `feature | bug | refactor | chore`
- `Target`: a configured target

Every ticket, including a chore ticket, has stable acceptance IDs:

```md
## Acceptance Criteria

- AC-001: <observable outcome>
- AC-002: <observable outcome>
```

IDs are unique and three-digit within the ticket. Once a plan exists, never reassign an ID. Preserve a removed criterion as `~~AC-NNN~~ - removed: <reason>` and allocate new IDs above the previous maximum. `NFR-NNN`, `C-NNN`, `A-NNN`, and `Q-NNN` are optional and appear only when a downstream artifact consumes them.

## Planning and Research

Plans live in `thoughts/plans/`, use `<NNN>-<type-letter>-<kebab-title>.md`, and share their ticket number. They translate ticket intent into concrete implementation steps.

Before writing a plan, `/plan` loads applicable memories and separates repository-answerable unknowns from product decisions. Simple work stays inline. When material unknowns exist, derive at most three independent tracks and dispatch isolated read-only researchers when available. Researchers cite `file:line`, preserve conflicts and unanswered questions, state confidence, do not read sibling reports, and never plan or edit.

Persist at most one synthesis at `thoughts/designs/<NNN>-research.md` with `Ticket-Hash`, `Baseline`, per-track `Evidence Paths`, findings, conflicts, remaining unknowns, confidence, and a cross-track synthesis. A ticket change invalidates all tracks. Otherwise reuse tracks whose evidence paths are untouched by `Baseline..main` plus relevant primary-checkout dirt; refresh only affected or unverifiable tracks and regenerate the cross-track synthesis.

Every plan includes:

- `Source Ticket Hash: sha256=<hex>` in frontmatter;
- `Current-State Findings`, with evidence and planning implications;
- `Approval Attention`, listing external, destructive, schema, public-API, configuration, or protected-file operations, or `None`;
- implementation steps with immutable numbers and exact `Covers:`, `Files:`, `Depends on:`, and `Parallelizable:` fields;
- Verification mapping every live acceptance criterion to an exercise;
- a visible `Plan Critique` section.

An active step follows this shape:

```md
### Step 2 - Apply validated filters

Covers: AC-001, AC-002
Files:
- src/example.ts
Depends on: step 1
Parallelizable: no

<instructions and validation expectations>
```

An enabling-only step may say `Covers: none - <reason>`, but every live AC still needs implementation and Verification coverage. Removed steps remain visible with a reason; step numbers are never reused. Dependencies must resolve and remain acyclic.

Before the plan reaches `Status: review`, an independent `plan-reviewer` performs one full read-only critique against ticket intent, AC coverage, research, repository evidence, dependencies, file scope, Verification, and Approval Attention. Findings use stable `PC-NNN` IDs and remain visible. Corrected blockers may receive one re-check scoped only to those IDs; there is never a third pass. Any unresolved blocker must be fixed or human-waived with a reason in both the plan and epic notes before approval.

## Approval and Amendments

`/approve` is a human gate and the gate-commit transaction. It validates `ready_for_approval`, creates or synchronizes the spec-linked Beads epic and step issues, validates the whole dependency graph, commits only the associated gate artifacts, appends the approval record, reruns doctor, and pushes Git and Beads where configured.

An approved-plan edit is an amendment. Preserve issue identities and step numbers; update open issue descriptions, added/removed steps, dependencies, spec IDs, and metadata; commit the amended gate artifacts; append a new approval record and summary note. A running implementation re-derives work from Beads and canonical main on every iteration.

Git and Beads are not one transaction. Approval is idempotent: reruns reuse existing objects, complete a commit missing its approval note, and never stage unrelated dirt.

## Implementation

`/implement` runs doctor/hash preflight before claiming; the claim is its first mutation. It requires `healthy`, creates `.worktrees/<plan-name>` through Beads, publishes the branch, and rechecks canonical approval at the start of every execution iteration.

Implementer subagents receive the canonical ticket/plan paths from the primary checkout, the approved plan hash, and one Beads step. They work in dependency order with file-overlap exclusion, commit once per step, push before closing it, and close only after configured quality gates pass. A blocking decision becomes a dedicated human gate. Memory discoveries become `memory-candidate:` notes on the epic; implementation never promotes or forgets memories.

`/next` preserves implement-first, plan-second priority and executes only one transition. Its snapshot is read-only. Only `healthy` plans are implementation candidates; drift, legacy artifacts, conflicting claims, orphan recovery, merge-slot contention, and declared-file overlap are surfaced rather than bypassed. A dedicated gate removes its blocked child from ready work without freezing unrelated ready children; a plan with only gated work stays in the human queue.

## Reviews

One full automated review phase runs at the end of implementation, never after each step. Required reviewers are selected from Project Configuration and all inspect the same clean code SHA. Every Beads read they make is `bd --readonly`.

Reviewers receive absolute canonical ticket/plan paths and the approved plan hash. They stop if main no longer matches that hash. MUST FIX findings use stable reviewer-scoped IDs such as `MF-backend-001`. On round two or later, each reviewer first verifies every prior finding as `fixed` or `persists`, then performs a complete fresh review of the new HEAD for regressions and new findings.

An approving component with no MUST FIX includes **Clean-Pass Evidence** covering ticket intent and ACs, plan steps/deviations, canonical repository conventions, tests/failure paths, and applicable risk surfaces. There is no obligation to invent a finding; an approval without this evidence is malformed.

Each completed round persists one aggregate artifact at `thoughts/reviews/<NNN>-round<n>.md` with this identity header:

```md
# Automated Review - 023 round 2
Reviewed code SHA: <sha>
Approved plan SHA256: <hex>
Approved plan commit: <main-sha>
Reviewers: backend-code-reviewer
```

Component reports are embedded verbatim in deterministic reviewer-name order. `## Overall` ends the file and contains exactly these structured controls before reviewer summaries:

```md
## Overall

Scope-Check: PASS - unplanned=none
AC-Coverage: PASS - verified=AC-001,AC-002; missing=none
Fix-Disposition: fixed=MF-backend-001; persists=none; new=none

- backend-code-reviewer: APPROVED

Verdict: APPROVED
```

Round one uses `Fix-Disposition: N/A`. `Verdict:` is the final standalone line. The parent validates component findings, IDs, dispositions, AC/scope controls, approved-plan identity, and the exact code SHA before recording `review: APPROVED sha=<artifact-commit> code-sha=<reviewed-code-sha> plan-sha256=<hex> plan-commit=<main-sha> rounds=<n>` on the epic.

After a blocked round, fixes invalidate all prior approvals and the entire required reviewer set reruns. If the aggregate MUST FIX count does not decrease, persist the artifact, label the epic `human`, and stop. A decreasing positive count may continue within the three-round plan cap or two-round chore cap. A malformed same-HEAD retry does not consume a round.

`/review` and its Beads access are read-only. `/land` refuses a review bound to another code SHA, plan hash, or plan commit.

## Landing and Memory

`/land` is the human merge gate. It verifies doctor, current approval identity, exact reviewed HEAD, every component verdict, and main/rebase freshness. With merge slots enabled, it acquires the slot before any main-sensitive operation and never waits silently.

After the squash merge commit exists, `/land` audits relevant memories, evaluates epic candidates against the merged result, promotes only durable high-signal facts, and uses the merge commit as Source provenance. It then pushes Git and Beads, safely removes the worktree through Beads, and releases an enabled merge slot. A memory failure never rewrites the merge; it leaves retry context on the epic before cleanup.

Memory candidates use:

```text
memory-candidate: key=<stable-slug>; tags=<comma-list>; finding=<fact>; why=<reason>; applies=<scope>; source-step=<issue-id>
```

The chore lane follows the same actor, read-only observer, gate, worktree, review-convergence, and post-merge memory contracts.

## Queue and Recovery

`/queue` is mechanically read-only. It shows doctor state and precise recovery actions, including native human gates, Beads-visible worktrees, corroborated stale claims, orphaned issue-referencing commits, approval drift, legacy ownership/artifacts, escalations, and optional merge-slot holder/age. Signals never authorize automatic repair, claim release, issue closure, or forced worktree removal.

## Backward Compatibility

- A plan with `Source Ticket Hash` and a reproducible epic approval record uses this contract; otherwise it is `legacy`.
- Draft/review legacy work gains AC IDs, `Covers:` lines, the source-ticket hash, required plan sections, and critique before approval.
- Approved legacy work with open issues pauses for explicit `/approve` migration while preserving issue IDs and step numbers.
- Approved legacy work whose issues are closed and whose legacy review is valid may land through the compatibility parser with a warning.
- A plan amendment opts the plan into the new contract.
- Old research lacking ticket hash, baseline, or per-track evidence paths is refreshed rather than reused.
- Legacy claims require explicit release/reassignment. Existing step-level `human` labels finish through their legacy path; new questions use gates.
- Existing worktrees may finish only when native discovery and safety checks resolve them. New worktrees and every cleanup use Beads-native commands.

Migration never invents AC IDs, coverage, or waivers without human review.
