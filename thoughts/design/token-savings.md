# Token-Savings Recommendations

## Goal

Reduce model input and output tokens across the SDLC workflow without weakening human gates, reproducible approvals, read-only enforcement, review evidence, or recovery safety.

The main principle is: remove repeated model work before optimizing serialization. Deterministic collection, field projection, targeted context, and terse success output should yield substantially more value than replacing JSON with TOON.

## Priorities

| Priority | Recommendation | Expected impact |
|---|---|---|
| 1 | Replace the `/next` and `/queue` snapshot subagent with a deterministic snapshot command | Very high |
| 2 | Add terse success paths for doctor and quality gates | High |
| 3 | Shrink always-loaded workflow instructions | High |
| 4 | Give agents targeted context packets instead of broad files | Medium-high |
| 5 | Scope review inputs and later review rounds more narrowly | Medium |
| 6 | Stop loading every Beads memory at session start | Medium, increasing as memories accumulate |

## 1. Make pipeline snapshots deterministic

### Current cost

`/next` and `/queue` spawn a `pipeline-snapshot` model solely to gather facts. That agent runs `sdlc doctor` for each active number and approximately ten Beads JSON queries covering ready work, claims, gates, worktrees, stale signals, orphans, dependency cycles, context, health, and optional merge-slot state.

This has three recurring costs:

- an additional model context for every dashboard or dispatcher invocation;
- ingestion of multiple raw JSON payloads before returning a compact table;
- repeated global Beads diagnostics for every active ticket or plan.

Doctor already collects many of the same global native diagnostics in `collectNativeDiagnostics()`.

### Recommendation

Add a deterministic, read-only command such as:

```text
sdlc snapshot --view=next --json
sdlc snapshot --view=queue --json
```

It should:

1. collect Beads installation, context, health, ready work, gates, worktrees, stale signals, orphans, cycles, escalations, and merge-slot state once;
2. inspect all active ticket/plan artifacts against that shared snapshot;
3. project only the fields required by `/next` or `/queue`;
4. return per-line state, human-queue entries, overlap evidence, and the first legal transition candidate;
5. remain mechanically read-only and never repair, claim, resolve, or select a mutation by itself.

`/queue` can then become deterministic formatting. `/next` would invoke a model only after the snapshot identifies actual planning or implementation work. An idle `/next` should require no snapshot subagent.

This is the highest-return change because it removes an entire model call and duplicated tool payloads from a frequently repeated path.

## 2. Use terse success paths

### Doctor and integrity checks

Doctor currently emits a full, pretty-printed JSON object. It runs during approval, implementation preflight, every implementation iteration, review, and landing. Most successful calls need only a small set of identities and a pass/fail result.

Add stage-specific guards, for example:

```text
sdlc guard implement 024
OK state=healthy plan=<sha256> approval=<commit> epic=<id> ready=<step-ids>
```

Possible views include `plan`, `approve`, `implement`, `review`, and `land`. On success, emit one compact line containing only values required by the caller. On failure, emit the full relevant errors, warnings, and recovery action. Preserve full `sdlc doctor --json` for diagnostics and external consumers.

Field projection matters more than merely minifying JSON.

### Quality gates and command output

Tests, builds, type checks, and linters can produce large successful logs, and implementation runs them after every step. Add a gate wrapper that:

- captures the complete log;
- emits a one-line PASS with command, duration, and relevant counts;
- emits a focused error excerpt plus the complete log location on failure;
- never hides a non-zero exit code.

The same terse-success convention should apply to routine push, hash, and clean-worktree verification where a full transcript adds no decision value.

## 3. Reduce always-loaded instruction text

The generated root instructions and `template/thoughts/AGENTS.md` currently total approximately 24.5 KB and 3,491 words before a skill, ticket, plan, source file, or diff is loaded. Reviewer profiles add another 11-17 KB each. Several transition procedures appear both in the global workflow contract and their owning skill.

### Recommendation

Keep the always-loaded workflow contract limited to:

- Project Configuration;
- the authority/source-of-truth table;
- a short set of universal invariants;
- human-gate boundaries;
- links to the owning skills and reference documentation.

Move detailed approval, implementation, review, landing, recovery, and memory procedures exclusively into their owning skills or deterministic CLI enforcement. In particular:

- move the full memory format and audit procedure into planning/landing instructions;
- remove duplicated transition walkthroughs from `thoughts/AGENTS.md`;
- remove the duplicate quality-gate declaration from the root instructions when Project Configuration is authoritative;
- shorten the backend and frontend agent-description examples;
- keep reviewer profiles specialist-specific and move mechanical identity/output validation into code.

Rule IDs alone are not a sufficient optimization if agents must load another long document to resolve them. The actual prose and repeated procedures must become shorter or deterministic.

### Beads prime

The installed Beads CLI describes full `bd prime` output as roughly 1-2K tokens. This repository already supplies its own workflow contract, so use a minimal/MCP prime mode or a short project-specific `.beads/PRIME.md`. Do not pay for a second full command reference in every session.

## 4. Build targeted context packets

### Product documentation

`/ticket` and `/plan` currently direct the agent toward `thoughts/docs/` broadly. As that directory grows, eager reading becomes increasingly expensive.

Add a small manifest or deterministic index with document titles, targets, tags, and authoritative sections. Agents should:

1. inventory/search the index;
2. load the canonical product overview plus documents relevant to the ticket target and tags;
3. expand only when ambiguity remains;
4. record which documents informed the artifact.

### Implementation steps

Give each implementer a compact, immutable step packet containing:

- the exact step and Beads issue ID;
- relevant acceptance-criterion text, not just IDs;
- declared files and dependencies;
- applicable quality gates and project constraints;
- plan hash and approval commit;
- only the context needed by that step.

Hash verification can be performed by `sdlc hash` without loading the entire plan into the model. The full canonical ticket and plan remain available for exceptional cases, but they should not be mandatory rereads for every step.

Require a compact result from implementer subagents:

```text
status=<pass|blocked>
commit=<sha|none>
files=<paths>
gates=<summary>
memory-candidates=<keys|none>
blocker=<none|specific blocker>
```

Git and test logs retain the detail; the parent needs only the handoff facts.

### Review packets

Generate one deterministic review packet for a code SHA containing:

- ticket intent and active acceptance criteria;
- approved plan identity and relevant steps;
- changed-file classification by configured lane;
- scope/AC mechanical checks;
- quality-gate results;
- prior finding inventory when applicable.

Specialist reviewers should receive their lane's full changes plus cross-lane interfaces that can affect it, rather than every specialist eagerly ingesting the entire mixed-lane diff and all workflow instructions.

## 5. Reduce repeated review context carefully

The existing design already makes two good token-conscious choices: it runs one aggregate review after implementation rather than after every step, and it deduplicates repeated reviewer profiles.

Additional safe reductions include:

- lane-scoped diffs with a complete changed-file inventory;
- compact, fixed evidence fields rather than unconstrained review prose;
- passing only prior findings and changes since the previously reviewed SHA during fix verification;
- reusing the same reviewer context for a later round when the runtime supports it.

The current full-fresh-review requirement catches regressions and should not be removed casually. A safer later-round design is:

1. verify prior findings against the delta;
2. inspect every changed-since-review file and affected interface;
3. run one final full review before approval.

This is a quality tradeoff and should be benchmarked on real blocked-review sequences before changing the convergence contract.

## 6. Retrieve memories on demand

All-memory injection grows indefinitely and duplicates the tag-based retrieval already used during planning and landing.

Prefer:

- a small key/tag index at session start, if any memory context is needed;
- `bd --readonly memories "tag:<tag>" --json` for relevant candidates;
- `bd --readonly recall <key>` only for selected candidates;
- a strict budget of durable, high-signal memories.

Memory bodies should not enter every session. Continue to exclude task state, code-discoverable facts, and product documentation from memory.

## Measurement

Token optimization should be measured by stage and scenario rather than inferred from file size alone.

Record, when the runtime exposes it:

- uncached input tokens;
- cached input tokens;
- output tokens;
- number of model calls and subagent calls;
- tool-output bytes returned to models;
- wall time;
- retries, malformed outputs, and incorrect transition decisions.

Use at least these benchmark scenarios:

1. idle `/next`;
2. `/queue` with several active plans;
3. planning with no research tracks;
4. planning with multiple research tracks;
5. a four-step implementation with a clean first review;
6. an implementation requiring one blocked review and fix round;
7. landing with and without a rebase.

Do not accept a token reduction that increases incorrect state transitions, misses review defects, weakens evidence, or causes more repair loops. Additional reasoning or retries can erase savings from a smaller payload.

## Recommended rollout

1. Add per-stage token and tool-output telemetry where the runtime permits it.
2. Implement the shared deterministic snapshot and remove the snapshot model from `/queue` and idle `/next`.
3. Add terse stage guards and successful-gate output suppression.
4. Slim the generated root and workflow contracts, then measure every agent profile again.
5. Add targeted documentation, step, and review packets.
6. Experiment with later-round delta review only after the lower-risk changes are measured.
7. Benchmark TOON only for any remaining large, uniform model-input payloads.

## Non-goals

These optimizations should not:

- replace Markdown tickets, plans, research, or review artifacts;
- remove human approval, landing, cancellation, or execution-time decision gates;
- weaken canonical hash and approval reproduction;
- turn warnings into implicit repair authority;
- remove the final evidence-bearing aggregate review;
- make TOON a persisted source-of-truth or external CLI contract.

TOON may eventually be useful as an optional encoding at the final model-input boundary. Projection, deterministic orchestration, and avoiding unnecessary model contexts should come first.
