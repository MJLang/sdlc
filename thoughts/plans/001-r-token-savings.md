---
Status: draft
Tags: [cli, skills, tokens, performance, contracts]
Type: refactor
Target: sdlc
Ticket Origin: thoughts/tickets/001-token-savings.md
Source Ticket Hash: sha256=6655bc5855de2a57ebfaa7cd3efefe35841748f59439837871d5c266f8413d29
Source Design Hash: sha256=ebe6ecbe448709c66427f97271fe4ec87d5966ce7b310426345a2c6d72c85354
Beads Epic:
---

# Plan 001 - Token-savings implementation

## Context

Implements ticket `thoughts/tickets/001-token-savings.md`, which carries the converged recommendations of [thoughts/design/token-savings.md](../design/token-savings.md) as stable acceptance criteria. The design hash is recorded above as additional provenance only; the ticket is the governing artifact. Mapping from the design's priorities to the ticket's ACs:

- **AC-001** - deterministic snapshot replaces the `/next`/`/queue` subagent (design §1 / TS-1)
- **AC-002** - terse per-stage precondition guards (design §2 / TS-2)
- **AC-003** - quality-gate wrapper with bounded output (design §2 / TS-2)
- **AC-004** - shrink always-loaded instruction text (design §3 / TS-3)
- **AC-005** - targeted context packets for steps and reviews (design §4 / TS-4)
- **AC-006** - memories and prime on demand (design §3, §6 / TS-6)
- **AC-007** - benchmark measurement gates the release (design §Measurement)

Narrower later review rounds (design §5 / TS-5) and TOON encoding are explicitly out of scope (design §Recommended rollout, items 6-7). They require the benchmark data this plan produces.

## Relevant Memories

None found - this repository has no Beads memory store.

## Current-State Findings

| Area or path | Finding | Evidence | Implication |
|---|---|---|---|
| `skills/next/SKILL.md`, `skills/queue/SKILL.md` | Spawn a `pipeline-snapshot` model agent that shepherds ~12 `bd --readonly` JSON queries plus per-number `sdlc doctor --json` | `skills/next/SKILL.md:19-27`, `skills/queue/SKILL.md:11-33` | An entire model context plus raw payload ingestion is paid per invocation, including idle loop iterations |
| `lib/beads.mjs`, `lib/doctor.mjs` | Native diagnostics are already collected deterministically; doctor imports `collectNativeDiagnostics` and exposes `inspectDoctor` | `lib/doctor.mjs:5`, `lib/doctor.mjs:555` | A snapshot command can be composed from existing collectors; per-number doctor runs can share one inspection context |
| `lib/doctor.mjs` | Doctor already machine-validates review artifacts: grammar, round caps, contiguity, AC coverage, note/artifact SHA reconciliation, HEAD binding | `lib/doctor.mjs:416-491` | Stage guards can project these checks, but skills also enforce stage invariants doctor does not prove (see Step 4) |
| `lib/doctor.mjs:210-228` | `projectBeadsConfig()` parses only Beads mode and merge-slot state; Project Configuration has no grammar for gate commands or target-to-path mapping | critique evidence (PC-003, PC-005) | The gate wrapper and lane-scoped review packets need explicit new configuration schemas |
| `template/thoughts/AGENTS.md` + `template/AGENTS.root.md` | 24.5 KB / 3,491 words always loaded (`thoughts/CLAUDE.md → AGENTS.md` symlink, `bin/sdlc.mjs:336`); transition procedures duplicated between contract and owning skills; `BEADS_ACTOR` capture paragraph appears near-verbatim in 7 files | `wc` measurements; `thoughts/AGENTS.md:57`, `skills/{implement,land,approve,chore,cancel,next}/SKILL.md` | Every root session and every subagent touching `thoughts/` ingests duplicated text |
| `skills/implement/SKILL.md:50` | Full `sdlc doctor {NNN} --json` re-runs at the top of every execution-loop iteration | skill text | Iteration checks need only state + hashes + blockers, a one-line guard |
| `skills/implement/SKILL.md:61` | Quality gates run after every step with unconstrained log output | skill text | Successful test/build logs enter context at full size per step |
| `template/agents/*.md` | Reviewer profiles are 10.7-17.1 KB each, direct a full-diff read, and backend/frontend frontmatter descriptions carry long `<example>` blocks | `wc` measurements; profile Phase 2 text | Every reviewer spawn ingests the full profile and full mixed diff; lane scoping must change the profiles too |
| `template/AGENTS.root.md:3` | Every session is told to run `bd --readonly prime`; memories load into every prime; no project prime configuration is installed | file text; setup installs no `.beads/PRIME.md` | Prose alone cannot prevent prime cost - a verified Beads mechanism is required (AC-006) |

## Implementation Steps

### Step 1 - Benchmark protocol and completed baseline

Covers: AC-007
Files:
- thoughts/design/token-benchmarks.md
Depends on: none
Parallelizable: no

Write the measurement protocol and **capture the baseline before any optimizing change lands** - completed, persisted baseline measurements are this step's exit condition, and every optimization step below depends on it.

1. Scenarios: the seven from the design (idle `/next`; `/queue` with several active plans; plan without research; plan with research tracks; four-step implement with clean review; implement with one blocked round; land with and without rebase).
2. Pinned conditions recorded with the results: fixture-project commit, sdlc commit, runtime and version, model ID, cache state assumptions, Beads version, and repetition count per scenario.
3. Metrics: uncached/cached input tokens, output tokens, model and subagent call counts, tool-output bytes, wall time, retries/malformed outputs, and incorrect transition decisions. Primary fallback metrics when the host runtime does not expose per-agent token counts are declared **now**: tool-output bytes and model/subagent call counts.
4. Record the baseline table in `thoughts/design/token-benchmarks.md`.

### Step 2 - `sdlc snapshot --view=next|queue --json`

Covers: AC-001
Files:
- lib/snapshot.mjs
- lib/doctor.mjs
- lib/index.mjs
- bin/sdlc.mjs
- test/snapshot.test.mjs
Depends on: step 1
Parallelizable: no

Add a deterministic, mechanically read-only snapshot command:

1. Refactor `inspectDoctor` to optionally accept a shared immutable inspection context - primary checkout resolution, Beads installation, configuration, adapter, and native diagnostics - so one collection pass is shared across all active numbers (no behavior change to plain `sdlc doctor`).
2. `lib/snapshot.mjs` enumerates active numbers from `thoughts/tickets/` and `thoughts/plans/`, collects Beads installation/context/health, ready work, gates (with the per-gate blocked-edge dependency query), worktrees, stale candidates, orphans, cycles, escalation labels, and merge-slot state (only when configured) exactly once, then runs the per-number artifact inspection against that shared context.
3. **The snapshot is the single normative implementation of transition eligibility.** `--view=next` returns the ordered candidate list with explicit eligibility and rejection reason codes per plan (e.g. `unhealthy`, `foreign-claim`, `gated`, `file-overlap:<path>`, `stale-candidate`), plus the human queue. `/next` consumes the result; it does not reimplement selection (see Step 3). `--view=queue` returns the dashboard sections (needs-you, in-flight, ready, drafts, recently-landed) with corroborating Git evidence per worktree.
4. Output is compact deterministic JSON: stable key order, empty fields omitted, no pretty-printing on the model-facing path. A fixture test asserts schema stability.
5. The command never claims, resolves, repairs, or mutates. The atomic Beads claim remains the mutation-time safety boundary.
6. Fixture tests cover: idle result, one implementable plan, each rejection reason code, overlap skip with evidence, open gate, stale candidate with and without Git corroboration, and merge-slot disabled vs enabled.

### Step 3 - Rewire `/next` and `/queue`; retire `pipeline-snapshot`

Covers: AC-001
Files:
- skills/next/SKILL.md
- skills/queue/SKILL.md
- template/agents/pipeline-snapshot.md
- bin/sdlc.mjs
- README.md
Depends on: step 2
Parallelizable: no

`/next` runs `sdlc snapshot --view=next --json` directly, verifies the snapshot is fresh (its reported HEAD/state matches a quick re-check only when the snapshot is stale by its own timestamp), takes the first candidate, and relies on the atomic epic claim as the mutation boundary - a claim race ends the invocation as today. When no candidate exists it reports idle plus the human queue and stops: no subagent, no further fact-gathering tool calls. `/queue` becomes formatting over `--view=queue`. The skills keep only interpretation guidance that maps reason codes to human recovery commands; eligibility rules move out of the skill text entirely (single normative home, per PC-008). Delete `template/agents/pipeline-snapshot.md`, remove it from the setup installer's agent list, and drop its mentions from README and both skills.

### Step 4 - `sdlc guard <stage> <NNN>` stage guards with acceptance matrices

Covers: AC-002
Files:
- lib/guard.mjs
- lib/index.mjs
- bin/sdlc.mjs
- test/guard.test.mjs
Depends on: step 2
Parallelizable: no

Guards are **per-stage validators with explicit acceptance matrices**, not a bare field projection (PC-002). For each stage (`plan`, `approve`, `implement`, `review`, `land`):

1. Define the acceptance matrix: which doctor states, modes (first-approval vs amendment vs no-op; normal vs post-merge recovery), and warning classes the stage accepts or refuses. Encode the stage-specific invariants the skills currently check beyond doctor - e.g. `land`: every active child closed, no open dedicated gate, every consent-requiring Approval Attention item has a matching resolved gate record; `implement`: claim-owner compatibility and ready-work existence; `approve`: mode detection and its legality.
2. Success prints exactly one line with the fields that stage's caller consumes plus `warnings=<code-list|none>` using stable warning/error codes; failure prints the failing state, relevant errors with codes, and the recovery action, preserving doctor's exit-code semantics (0/2/3, 1 for invalid invocation).
3. Each accepted and refused mode gets a fixture test before any skill preflight is replaced.
4. Full `sdlc doctor --json` remains unchanged for diagnostics and external consumers.

Where a skill invariant cannot be proven deterministically (e.g. semantic judgment about a warning), the guard reports the code and the skill retains the judgment - the guard never silently absorbs a check it cannot prove.

### Step 5 - `sdlc gates` quality-gate wrapper with an explicit gate schema

Covers: AC-003
Files:
- lib/config.mjs
- lib/gates.mjs
- lib/index.mjs
- bin/sdlc.mjs
- template/thoughts/AGENTS.md
- test/gates.test.mjs
Depends on: step 1
Parallelizable: no

1. **Gate schema first** (PC-003): extend Project Configuration with an explicit ordered grammar for gates - a global `Quality gates` list plus optional `Target gates: <target> -> <command>` lines - and implement its parser in `lib/config.mjs` with fixtures for parsing, ordering, quoting/shell semantics, and unknown-target refusal. `sdlc gates [--cwd <worktree>] [--target <t>]` runs exactly the configured commands for the scope; additional ad-hoc commands must be passed explicitly and are reported as such.
2. **Log placement** (PC-004): logs are written under the Git common directory (`git rev-parse --git-common-dir`, e.g. `.git/sdlc/logs/<run>/`), never inside the worktree, so gate runs cannot dirty it and no ignore-rule migration is needed. Owner-only permissions (0700 dir / 0600 files), per-run directory, retention of the last 10 runs with older runs pruned, and a per-log size cap with explicit truncation markers. When the Git common directory is unwritable, fall back to an owner-only OS temp location (`$TMPDIR/sdlc-gates-<repo-fingerprint>/` with the same permissions, retention, and caps) so a failure always reports a full-log path per AC-003; if the fallback is also unwritable, refuse with a clear error **before running any gate**. Fixture tests cover the unwritable-common-dir fallback and the both-unwritable refusal.
3. On success print one line per command: command, duration, and a parsed count summary where available (e.g. `node --test` pass/fail counts). On failure print a bounded excerpt (the failing test/error block) plus the full log path. Exit non-zero when any gate fails; never swallow a non-zero exit.

### Step 6 - Skills adopt guards and gate wrapper

Covers: AC-002, AC-003
Files:
- skills/plan/SKILL.md
- skills/approve/SKILL.md
- skills/implement/SKILL.md
- skills/chore/SKILL.md
- skills/land/SKILL.md
- skills/review/SKILL.md
Depends on: step 4, step 5
Parallelizable: no

Replace a skill's doctor/preflight usage with `sdlc guard <stage> {NNN}` **only where Step 4's matrix provably covers every invariant that skill enforced**; each replacement cites the matrix entry. Implement's per-iteration check (`skills/implement/SKILL.md:50`) becomes a guard call. Each skill keeps one instruction to run full `sdlc doctor {NNN} --json` when a guard refuses and its output is insufficient. Replace inline quality-gate invocation with `sdlc gates` in implement, chore, and land (post-rebase). In `/land` and `/review`, where the guard's review checks reproduce doctor's artifact validation, instruct reading only the aggregate artifact's identity header and `## Overall` block instead of the full artifact.

### Step 7 - Slim always-loaded instructions, deduplicate skills, minimal prime

Covers: AC-004, AC-006
Files:
- template/thoughts/AGENTS.md
- template/AGENTS.root.md
- template/beads/PRIME.md
- bin/sdlc.mjs
- skills/ticket/SKILL.md
- skills/plan/SKILL.md
- skills/approve/SKILL.md
- skills/implement/SKILL.md
- skills/review/SKILL.md
- skills/land/SKILL.md
- skills/chore/SKILL.md
- skills/cancel/SKILL.md
- skills/next/SKILL.md
- skills/queue/SKILL.md
- template/agents/backend-code-reviewer.md
- template/agents/frontend-code-reviewer.md
- template/agents/general-code-reviewer.md
- template/agents/plan-reviewer.md
- test/setup.test.mjs
Depends on: step 3, step 6
Parallelizable: no

One normative home per rule:

1. Cut `template/thoughts/AGENTS.md` to Project Configuration, the authority table, universal invariants (including a single short actor-capture rule), human-gate boundaries, the hash/doctor contract summary, and pointers to owning skills - target under 1,000 words. Remove the transition walkthroughs whose full text lives in the owning skills.
2. In the seven files repeating the `BEADS_ACTOR` capture paragraph, keep the command and captured-literal requirement (skills must stay self-contained for non-Claude targets) but cut each to two sentences referencing the contract invariant.
3. `template/AGENTS.root.md`: remove the duplicated Quality Gates block (Project Configuration is authoritative) and move the full memory format/audit procedure into `/plan` and `/land`, leaving a two-line pointer.
4. **Prime mechanism, not prose** (PC-007): ship a minimal project prime via a setup-installed `.beads/PRIME.md` (template at `template/beads/PRIME.md`) or the installed Beads version's supported compact-prime configuration - verify the mechanism against Beads `>= 1.1.0` during implementation and fall back to the documented supported alternative if `PRIME.md` is not honored. Setup installs/updates it idempotently; README documents migration for existing projects. Root instructions scope priming to mutating root sessions; read-only observers and subagents do not prime. Memory bodies load only via `bd --readonly memories "tag:<tag>"` + `recall`. A fixture test verifies a fresh-session prime with 10 memories emits no memory bodies.
5. Shorten backend/frontend agent frontmatter descriptions (drop the `<example>` blocks); trim review-procedure prose that repeats what the aggregate contract in `/implement` owns (verdict grammar stays in the reviewer profiles - they are standalone emitters).
6. Verify no skill or agent references removed contract text; each procedure remains fully specified in exactly one loaded-when-needed file.

### Step 8 - Targeted context packets

Covers: AC-005
Files:
- lib/config.mjs
- lib/review-packet.mjs
- lib/index.mjs
- bin/sdlc.mjs
- template/thoughts/AGENTS.md
- template/thoughts/docs/INDEX.md
- skills/ticket/SKILL.md
- skills/plan/SKILL.md
- skills/implement/SKILL.md
- skills/chore/SKILL.md
- template/agents/backend-code-reviewer.md
- template/agents/frontend-code-reviewer.md
- template/agents/general-code-reviewer.md
- test/review-packet.test.mjs
- test/setup.test.mjs
Depends on: step 7
Parallelizable: no

1. **Docs index:** ship a stub `thoughts/docs/INDEX.md` (title, target, tags, authoritative-section pointers per document) via setup; `/ticket` and `/plan` search the index first, load the overview plus target/tag-relevant documents, expand only on ambiguity, and record which documents informed the artifact.
2. **Step packets:** `/implement` hands each implementer a compact immutable packet - step text, issue ID, `Covers` with the quoted AC text, declared files and dependencies, applicable gates and constraints, plan hash + approval commit, worktree root. Hash verification stays `sdlc hash <canonical-plan>` compared to the supplied literal; the full canonical plan remains available but is no longer a mandatory per-step read.
3. **Compact implementer results:** require the `status=/commit=/files=/gates=/memory-candidates=/blocker=` result contract; the parent consumes only these handoff facts.
4. **Lane map schema** (PC-005): extend Project Configuration with an explicit `Target paths: <target> -> <glob-list>` schema parsed by `lib/config.mjs`, with deterministic precedence (most-specific glob wins) and defined overlap behavior (a path matching two targets belongs to both lanes). When `Target paths` is absent, lane classification stays with the model and the review packet says so - no silent heuristic in the CLI.
5. **Review packets:** `lib/review-packet.mjs` composes, per reviewer: ticket intent + live AC text, approved plan identity and the steps covering the reviewer's lane, changed-file classification from the lane map, the **complete changed-file inventory for every reviewer** (safeguard), the reviewer's lane-scoped diff plus cross-lane interface files, gate summaries from `sdlc gates`, and the prior-finding inventory on later rounds. **Cross-lane interface inclusion is defined stack-neutrally** (PC-005): scan the **complete contents** of every changed file (not only its diff hunks), in **both directions** - a changed cross-lane file is included in the lane packet when a changed lane file references it **or** it references a changed lane file. A reference is a textual import/require/include specifier that resolves to the other changed file after lexical normalization only: repository-relative specifiers match directly; relative specifiers (`./`, `../`) are joined to the referencing file's directory and normalized purely lexically, compared with and without extension - no filesystem probing or language-specific module resolution. Files that are unreadable or binary, and references that produce no computable match, fall back to inventory-only inclusion, stated explicitly in the packet; reviewers may read specific files themselves (the inventory tells them what exists). Update the three code-reviewer profiles' Phase 2 to consume the packet: full read of the lane-scoped diff, inventory awareness of the rest, light correctness pass on cross-lane interfaces - and to state when they exceeded the packet. Fixture tests cover packet composition per lane, the overlap case, the direct and relative-specifier matches, an unchanged import line inside a changed file, the reverse-consumer case, the unreadable/binary fallback, and the no-match fallback.

### Step 9 - Re-measure, document, release

Covers: AC-007
Files:
- thoughts/design/token-benchmarks.md
- README.md
- package.json
- skills/*/SKILL.md (frontmatter versions via bump script)
Depends on: step 3, step 6, step 7, step 8
Parallelizable: no

Re-run the Step 1 protocol under the same pinned conditions; record per-scenario deltas next to the baseline. Any scenario that regresses on correctness signals (incorrect transition decisions, missed review defects, extra repair loops) blocks release per the design's acceptance rule and the ticket's AC-007. Update README (new CLI commands, removed `pipeline-snapshot` agent, new configuration lines, prime migration, and a migration note for existing installs) and release with `npm run bump:minor`.

## Quality Gates

- `npm test` (`node --test` over `test/*.mjs`) after every step
- Fixture-repository integration tests for every new CLI command and configuration schema (steps 2, 4, 5, 8)

## Verification

| ID | Exercise | Expected outcome |
|---|---|---|
| AC-001 | Run `/next` on an idle fixture pipeline; inspect the session | One `sdlc snapshot` call, no subagent spawn, idle report with human queue |
| AC-001 | Run `/queue` with two active plans, one gated | Dashboard renders from one compact snapshot JSON; gate shows blocked step + resolution command; rejection reason codes present |
| AC-002 | `sdlc guard <stage> 001` per stage on healthy and each refused-mode fixture | Exactly one `OK ...` line with stable codes on success; refusal prints state + coded errors + recovery, exits 2/3; every matrix row tested |
| AC-003 | `sdlc gates` with a passing and a failing suite, in a worktree | One-line PASS with counts; failure shows bounded excerpt + log path; worktree stays clean (`git status`); logs pruned to last 10 runs |
| AC-004 | `wc -w` on generated `thoughts/AGENTS.md` | Under 1,000 words; each moved rule findable in exactly one owning skill |
| AC-005 | Four-step fixture implement with a mixed-lane diff | Each implementer receives a step packet and returns the compact result contract; each reviewer receives a lane-scoped packet including the complete changed-file inventory |
| AC-006 | Fresh session in a fixture project with 10 memories | Prime output contains no memory bodies; planning retrieves only tag-matched memories |
| AC-007 | Step 1 baseline exists before the first optimizing commit; Step 9 table complete | Idle `/next` and four-step-implement scenarios show reduced uncached input + tool-output bytes vs baseline under pinned conditions, with no correctness regressions |

## Approval Attention

| ID | Operation or decision | Why attention is required | Timing | Status |
|---|---|---|---|---|
| AA-001 | New public CLI surface: `sdlc snapshot`, `sdlc guard`, `sdlc gates` | External contract; consumers may script against it | Steps 2, 4, 5 | open |
| AA-002 | Removal of the `pipeline-snapshot` bundled agent | Breaking for existing installs whose skills reference it; needs README migration note | Step 3 | open |
| AA-003 | Rewrite of the generated `thoughts/AGENTS.md` contract | Adopting projects regenerate on setup; existing projects keep their old contract until re-run | Step 7 | open |
| AA-004 | Reviewer input narrowed to lane-scoped diffs | Review-contract change; complete changed-file inventory retained as safeguard; reviewer profiles updated in the same step | Step 8 | open |
| AA-005 | Gate logs persisted under the Git common directory | Retention (last 10 runs), owner-only permissions, size caps, and possible sensitive content in logs | Step 5 | open |
| AA-006 | New Project Configuration schemas: `Target gates`, `Target paths` | Configuration contract addition for adopting projects; parser refusal behavior on malformed lines | Steps 5, 8 | open |
| AA-007 | Setup-installed project prime (`.beads/PRIME.md` or equivalent) | Changes every fresh session's startup context in adopting projects; migration for existing installs | Step 7 | open |

## Open Questions

- The ticket is `Status: draft`; its human approval (the status edit) changes the ticket file's hash, so `Source Ticket Hash` above must be re-recorded immediately after approval and before `/approve 001`. This is a consequence of retrofitting the ticket after planning and does not recur in normal pipeline order.
- Step 1's token telemetry depends on the host runtime; the declared fallback (tool-output bytes + call counts) is the committed primary metric if per-agent token counts are unavailable.

## Plan Critique

Pass 1 Verdict: BLOCKED - 8 MUST FIX

### MUST FIX

- PC-001 [fixed] - the plan was not executable under the repository's own artifact contract (no ticket, `Source Design Hash` in place of `Source Ticket Hash`, `TS-*` coverage IDs unknown to `lib/artifacts.mjs`).
  Disposition: created `thoughts/tickets/001-token-savings.md` with AC-001..AC-007; frontmatter now records `Ticket Origin` and `Source Ticket Hash` (sha256=6655bc58...); every `Covers:` and Verification row uses ticket AC IDs; the design hash is retained as provenance only. Draft-status hash caveat recorded in Open Questions.

- PC-002 [fixed] - `sdlc guard` as a bare doctor projection would drop stage-specific safety decisions the skills currently make.
  Disposition: Step 4 rewritten around explicit per-stage acceptance matrices covering modes (first-approval/amendment/no-op, normal/post-merge recovery), warning policy with stable codes, skill-invariant encoding (children-closed, AA-gate resolution, claim compatibility), per-mode fixture tests, and the rule that a guard never silently absorbs a check it cannot prove; Step 6 permits replacement only where the matrix provably covers the skill's invariant.

- PC-003 [fixed] - the gate wrapper assumed a Quality-gates parser that does not exist; `projectBeadsConfig()` parses only Beads mode and merge-slot state.
  Disposition: Step 5 now defines an explicit ordered gate grammar (`Quality gates` + `Target gates`) with a parser in `lib/config.mjs`, fixtures for parsing/ordering/shell semantics/unknown-target refusal, and explicit-only ad-hoc commands. AA-006 added.

- PC-004 [fixed] - `.sdlc/logs/` inside the worktree would dirty existing installs and retain unbounded/sensitive logs.
  Re-check: Git-common placement, permissions, retention, and caps fix the normal path, but the unwritable-location fallback says to run with bounded stdout and no durable log. That contradicts AC-003's unconditional requirement that a failure include a full-log location. Use a secure outside-worktree fallback (with the same permissions/retention/caps) or refuse before running; test the unwritable-common-dir case.
  Disposition (post-re-check): Step 5 now falls back to an owner-only OS temp location with identical permissions/retention/caps so a full-log path is always reported, refuses before running any gate when both locations are unwritable, and adds fixture tests for both cases.

- PC-005 [fixed] - lane classification assumed a target-to-path map that configuration does not define, and Step 8 left the full-diff-reading reviewer profiles unchanged.
  Re-check: `Target paths`, reviewer-profile edits, and the complete inventory repair most of the finding. Step 8 still promises deterministic inclusion of files "imported by or importing" lane files without defining a stack-neutral resolver or a conservative fallback when no resolver exists. Define that boundary and test it. Also list `test/setup.test.mjs` in Step 8 because the step changes setup-installed `thoughts/docs/INDEX.md`; every modified file and setup integration test must be in scope.
  Re-check of correction: `test/setup.test.mjs` is now in scope, but the textual rule scans only one direction and only changed diff text. It therefore misses an unchanged import line inside a changed file and a changed cross-lane file that imports the lane file; direct repository-relative matching also misses ordinary relative specifiers. Scan the complete contents of changed files in both directions, lexically normalize relative specifiers against the importing file, retain an explicit unsupported/unreadable fallback, and fixture-test unchanged-specifier and reverse-consumer cases.
  Disposition (final): Step 8 now scans the complete contents of changed files in both directions, lexically normalizes relative specifiers against the referencing file's directory (compared with and without extension, no filesystem probing), retains the explicit unreadable/binary and no-match fallbacks, and adds fixture tests for the unchanged-import-line and reverse-consumer cases alongside the existing ones.

- PC-006 [fixed] - the baseline could have been filled after optimizing commits changed the measured behavior.
  Disposition: Step 1 now has completed, persisted baseline measurements as its exit condition with pinned fixture/sdlc commits, runtime, model, cache assumptions, Beads version, and repetitions; fallback metrics are declared before execution; Steps 2 and 5 (and transitively all optimization work) depend on Step 1.

- PC-007 [fixed] - prose telling observers not to prime cannot prevent host hooks from injecting default prime output.
  Disposition: Step 7 ships a setup-installed minimal project prime (`template/beads/PRIME.md` → `.beads/PRIME.md`, verified against the installed Beads version with a documented supported fallback), idempotent install/update, README migration, and a fixture test that a fresh-session prime with 10 memories emits no memory bodies. AA-007 added.

- PC-008 [fixed] - transition eligibility existed in two normative places (CLI advisory + skill rules) and snapshot JSON compactness was unspecified.
  Disposition: Step 2 makes the snapshot the single normative eligibility implementation returning ordered candidates with explicit eligibility/rejection reason codes; Step 3 strips eligibility rules from the skill, which consumes the result and relies on the atomic claim as the mutation boundary; output is compact deterministic JSON with a schema-stability fixture test. The corresponding Open Question is resolved and removed.

### Advisory dispositions

- Step 7 now depends on Step 3 (and Step 6) explicitly.
- Step 8 `Files:` now lists the reviewer templates, packet library, and tests.
- Step 2 shares a full immutable inspection context (checkout, installation, configuration, adapter, native diagnostics), not only the diagnostics object.
- Approval Attention extended with AA-005 (log retention/security), AA-006 (new configuration schemas), and AA-007 (prime migration).

Scoped Re-check Verdict: APPROVED

Post-re-check corrections: PC-004 and PC-005 are corrected as recorded in their dispositions above. All exchanges after Pass 1 stayed scoped to the original eight IDs; no new finding was introduced.

### Original critique evidence

Preserved from Pass 1 (reviewer: GPT Sol): design identity re-hashed and matching; artifact contract checked via `lib/artifacts.mjs:3,277-369` and a direct `parsePlan()` of this file; doctor coverage via `lib/doctor.mjs:555-842`; configuration and setup via `lib/doctor.mjs:210-228`, `bin/sdlc.mjs:36-53,447-533`; gate/worktree cleanliness via `lib/doctor.mjs:370-380,727-730` and the absence of a `.sdlc/` ignore rule; reviewer full-diff behavior via all three code-reviewer templates; `node --test` passing before critique.
