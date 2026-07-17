---
name: plan
version: 0.5.0
description: Research and write a traceable implementation plan for an approved ticket, then run the bounded independent plan critique. Use when an approved ticket needs a concrete plan before implementation.
argument-hint: <ticket number, e.g. 003>
---

Write the plan for ticket `$ARGUMENTS` under `thoughts/AGENTS.md`. Research is an adaptive substage of this transition, never a separate pipeline state.

## Preconditions

Run `sdlc guard plan {NNN}`. The `new-plan` matrix row accepts only
`ready_for_planning` and returns the canonical ticket path/hash; any other mode
refuses. When its coded recovery is insufficient, run
`sdlc doctor {NNN} --json` once for full diagnostics. Confirm the returned hash
with `sdlc hash <absolute-ticket-path>`; never reproduce the hash algorithm.

## Evidence and memories

1. Read the canonical ticket and `thoughts/docs/INDEX.md`. Load the overview plus target/tag-matched documents, expand only on ambiguity, and record the used documents under **Documentation Sources**. Then read Project Configuration, relevant source/tests, and repository instructions.
2. Retrieve candidates for every ticket tag with `bd --readonly memories "tag:<tag>" --json`; deduplicate keys and use `bd --readonly recall <key>`. Apply a memory only when its `Applies when` overlaps the ticket, and verify it against current code.
3. If frontend work is plausible, honor the configured design-system constraints and design skill and record their effect.

Every Beads command in planning, research, or critique must include `--readonly`. Planning never mutates Beads.

Relevant memories use this durable format; do not load or enumerate unrelated
memory bodies:

```text
Tags: <2-5 stable tags>
Index: tag:<tag> tag:<tag>
Finding: <durable fact>
Why: <why it matters>
Applies when: <scope>
Source: <plan/commit provenance>
```

## Adaptive research

Separate repository-answerable unknowns from product or priority decisions requiring a human. Derive zero to three independent research tracks.

- If the current code and docs answer the material questions directly, research inline and put the evidence in **Current-State Findings**. Do not create a research artifact.
- If material unknowns remain, persist exactly one `thoughts/designs/{NNN}-research.md` synthesis. Use one isolated read-only subagent per independent track when available, with at most three concurrent tracks. Each receives only its question, ticket context, allowed scope, and the output contract below. It must not edit, plan, read sibling reports, or use Beads without `--readonly`.
- Require each track to cite `file:line`, enumerate Evidence Paths, preserve conflicts and unanswered questions, and declare `Confidence: low | medium | high`. Never resolve conflicts by guessing or omit an unanswered track question.

Use this synthesis frontmatter and sections:

```md
---
Ticket: thoughts/tickets/{ticket-file}
Ticket-Hash: sha256=<ticket hash>
Baseline: <current main SHA>
Generated-At: <ISO-8601 UTC>
Tracks: <1-3>
---

# Research Synthesis - Ticket {NNN}

## Track R1 - <name>
Question: <one answerable question>
Evidence Paths:
- path/to/evidence
Findings:
- <finding with file:line>
Conflicts:
- None.
Remaining Unknowns:
- None.
Confidence: high

## Cross-Track Synthesis
- Planning implications: ...
- Preserved conflicts: ...
- Remaining unknowns: ...
```

### Targeted reuse

Reuse an existing synthesis only after checking it:

1. Refresh every track if `Ticket-Hash` differs, `Baseline` is missing, or the baseline is not an ancestor of current main.
2. Otherwise collect both sides of renames plus adds/deletes/modifications from `git diff --name-status --find-renames <baseline>..HEAD`, and relevant dirty primary-checkout paths from Git status.
3. Intersect changed paths with each track's Evidence Paths. Reuse an empty-intersection track; refresh only an intersecting track.
4. Conservatively refresh a track whose Evidence Paths are missing or too vague to test.
5. After any refresh, update the baseline, timestamp, and affected track, then regenerate Cross-Track Synthesis while preserving unchanged tracks.

An unrelated landing must not invalidate untouched tracks. A changed ticket invalidates all tracks.

## Write the plan

Write `thoughts/plans/{NNN}-{type-initial}-{kebab-title}.md` with:

```yaml
---
Status: review
Tags: [<ticket and useful planning tags>]
Type: <ticket type>
Target: <ticket target>
Ticket Origin: <repository-relative ticket path>
Source Ticket Hash: sha256=<doctor ticket hash>
Beads Epic:
---
```

The body must contain:

- **Context** - ticket link, current code, and research-synthesis link when one exists;
- **Relevant Memories** - only used keys and their effect, or `None found`;
- **Documentation Sources** - only the indexed documents that informed the plan;
- **Current-State Findings** - a table with `Area or path | Finding | Evidence | Implication`; cite `path:line`;
- **Implementation Steps** - immutable numbered steps using the exact shape below;
- **Quality Gates** - Project Configuration gates plus target test/typecheck/build commands;
- **Verification** - map every live AC to a concrete exercise and expected outcome;
- **Approval Attention** - a table with `ID | Operation or decision | Why attention is required | Timing | Status`, or `None`;
- **Open Questions** - include research unknowns and human decisions, or `None`;
- **Plan Critique** - the visible critique record described below.

For `Type: discovery`, also include **Discovery Protocol** with non-empty fields: `Question and Hypothesis`, `Experiment Matrix`, `Versions and Environment`, `Success and Invalidation Thresholds`, `Expected Evidence Paths`, `External Resources` (costs, credentials, and Approval Attention), `Retained Probe Code`, `Cleanup Procedure`, and `Follow-up Disposition`. Define both validation and invalidation outcomes; discovery is complete with evidence and a decision, never an inconclusive final outcome.

```md
### Step 2 - Apply validated export filters

Covers: AC-001, AC-002
Files:
- src/server/routes/export.ts
- src/server/services/export-service.ts
Depends on: step 1
Parallelizable: no

<implementation and validation instructions>
```

Every active step declares `Covers`, `Files`, `Depends on`, and `Parallelizable`. A pure enabler may use `Covers: none - <reason>`, but every live AC must be covered by at least one active step and by Verification. Reference only ticket IDs. Make dependencies acyclic and parallelize only disjoint file sets. Disclose destructive, external, schema, public-API, configuration, and protected-file operations in Approval Attention. Include decisions, risks, rollback, documentation impact, or broader impact sections only when material.

## Independent critique

Before stopping, run one independent `plan-reviewer` or an isolated generic fallback with the same read-only contract. Give it the canonical ticket, synthesis if present, plan, repository scope, and ask it to check ticket intent, every AC, evidence and unknowns, conventions, dependencies, file overlap, Verification, Approval Attention, and excess scope.

Record stable `PC-NNN` findings in the plan:

```md
## Plan Critique

Pass 1 Verdict: BLOCKED - 1 MUST FIX
- PC-001 [fixed]: <finding and disposition>

Scoped Re-check Verdict: APPROVED
```

- Run exactly one full pass.
- Correct blocking findings when possible. If any were corrected, run at most one re-check scoped only to those IDs; never a third pass.
- Leave unresolved blockers visible. `/approve` must refuse until a human corrects or explicitly waives each one with a recorded reason.
- If the named reviewer is unavailable, mark the isolated fallback. If no independent context is available, record a degraded critique instead of inventing approval.

Stop at `Status: review`. Do not create Beads issues, worktrees, or code. Report the plan and optional synthesis paths and direct the human to `/approve {NNN}`.
