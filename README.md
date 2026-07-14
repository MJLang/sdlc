# sdlc

**Ticket -> plan -> implement -> land.** An agentic software-development pipeline packaged as [agent skills](https://skills.sh), with reproducible human gates, Beads-native coordination, isolated Git worktrees, and persisted review evidence.

You describe work as tickets. The pipeline plans it, implements it in an isolated worktree, reviews it with evidence, and merges it — while a human explicitly approves every irreversible step. Everything the pipeline decides is written down: tickets and plans are reviewable Markdown, approvals are content-hashed and committed, reviews are persisted artifacts, and live execution state is queryable.

## How it works

Four stores, each authoritative for one thing:

| Store | Holds |
|---|---|
| `thoughts/` on `main` | Canonical ticket, plan, and research text — committed at approval |
| [Beads](https://github.com/gastownhall/beads) | Live execution state: issues, dependencies, claims, gates, notes |
| A per-plan Git worktree | Code changes and the persisted review artifacts |
| Epic approval notes | The hash chain binding approved artifacts to a `main` commit |

Worktree copies of tickets and plans are snapshots — canonical text is always read from `main`. `/next` performs exactly one legal transition at a time and never crosses a human gate.

## Requirements

- **Git** — branches, commits, and worktrees; a remote is strongly recommended
- **[Beads](https://github.com/gastownhall/beads) `>= 1.1.0`** (`bd`) — issues, dependencies, atomic claims, gates, worktree safety, and recovery signals
- **Node.js 18+** — the setup, hashing, doctor, and local-review CLI
- An agent that supports skills — built for Claude Code and Codex, installable anywhere the skills CLI reaches

## Install

Run full setup inside your project. Choose an agent target; no target keeps the Claude Code-compatible default:

```bash
npx @mlangroman/sdlc setup --claude
npx @mlangroman/sdlc setup --codex
```

Setup does six things:

1. Initializes Git when necessary.
2. Creates `thoughts/{tickets,plans,designs,docs,reviews}/`, the workflow contract (`thoughts/AGENTS.md`), and `CLAUDE.md -> AGENTS.md` symlinks.
3. Creates a starter root `AGENTS.md`, preserving an existing root instruction file unless `--force` is used.
4. Installs all ten skills into `.agents/skills/` and symlinks the same copies for Claude Code.
5. Installs the five bundled read-only agent profiles for Claude Code and/or Codex.
6. Verifies Beads `>= 1.1.0` and its required capabilities, then initializes Beads when needed.

Flags: `--claude` (default), `--codex` (pass both to install both), `--force`, `--skip-skills`, `--skip-agents`, `--skip-beads`. Note that `--skip-beads` is a scaffolding escape hatch only — it does not make the Beads-backed transitions executable or healthy.

To install only the skills for another supported agent:

```bash
npx skills add MJLang/sdlc
npx skills add MJLang/sdlc --skill ticket --skill plan
```

## Configure your project

Edit the single configuration block in the generated `thoughts/AGENTS.md`:

```md
- **Targets:** `app`
- **Quality gates:** `npm test`
- **Reviewers:** all targets -> `backend-code-reviewer`
- **Product docs:** `thoughts/docs/`
- **Frontend constraints:** none
- **Beads merge slot:** `off`
- **Beads mode:** `embedded`
- **Review editor:**
- **Local preview:**
- **Preview URL:**
```

- **Targets** — the areas of your repo work can land in (e.g. `cms | jobs | web` for a monorepo).
- **Quality gates** — commands that must pass after every implementation step.
- **Reviewers** — map targets to the bundled specialists; unmapped lanes use `general-code-reviewer`.
- **Beads mode** — keep `embedded` for one mutating session plus read-only observers; select `server` only for genuinely concurrent mutating root sessions.
- **Beads merge slot** — keep `off` until you have multiple concurrent landers and a proven stale-holder recovery procedure.

Then drop product or vision docs into `thoughts/docs/` — tickets ground their summaries there.

## Use the pipeline

The full lane, step by step:

**1. Create a ticket.**

```text
/ticket Add CSV export with filter validation
```

Writes `thoughts/tickets/{NNN}-*.md` with a Summary, Scope, and stable acceptance criteria (`AC-001`, `AC-002`, …). The ticket stays `draft`.

**2. Approve the ticket — by hand.** Read it, edit `Status: draft` to `Status: approved`. That deliberate edit *is* the first human gate.

**3. Plan.**

```text
/plan 024
```

Researches the repository (spawning up to three isolated read-only research tracks when there are material unknowns), then writes `thoughts/plans/024-*.md`: numbered steps with `Covers:`, `Files:`, `Depends on:`, and `Parallelizable:` fields, Current-State Findings, Approval Attention (risky operations), and a Verification section mapping every AC. The bundled `plan-reviewer` then runs one critique pass (plus at most one re-check scoped to corrected blockers), and the plan stops at `Status: review`.

**4. Approve the plan.** Read it, then:

```text
/approve 024
```

Creates the Beads epic and step issues with dependencies, commits the ticket, plan, and research synthesis to `main`, and records the approval hash chain on the epic. From here, approval is *reproducible* — editing an approved artifact makes implementation illegal until you re-run `/approve 024` to sync the amendment.

**5. Implement.**

```text
/implement 024
```

Verifies the approval hashes, claims the epic under a session-unique actor, creates a Beads-managed worktree, executes steps in dependency order (one commit per step, pushed as each closes, quality gates after every step), and finishes with the aggregate code review. Blocking questions become Beads gates for you to resolve; nothing merges.

**6. Inspect locally (optional).**

```text
/review 024
```

or from a terminal: `sdlc review 024` (`--editor`, `--artifact`, `--diff`, `--preview`). Resolves the worktree, canonical ticket/plan, diff, review artifact, and doctor summary — read-only, records no approval.

**7. Land.**

```text
/land 024
```

Verifies the reviewed code SHA and approved-plan identity, squash-merges to `main`, audits and promotes project memory from the merged result, closes the epic, and cleans up the worktree and branch. This is the final human gate.

**Small changes** skip the plan: `/chore fix the typo in the export header` runs ticket -> worktree -> gates -> review -> merge in one human-invoked pass, under the same safety and review contracts.

**Autonomy:** `/next` performs exactly one legal transition (implement an approved plan, else plan an approved ticket, else idle) and queues everything needing a human. Pair it with your agent's loop feature (e.g. `/loop /next` in Claude Code) to keep the pipeline moving unattended — it can never approve, land, or cancel.

**Status and recovery:** `/queue` is a mechanically read-only dashboard — what needs you, what is in flight, what is stale or drifted, and the exact recovery command for each. `/cancel 024` cancels a line of work (or `/cancel 024 plan` to re-plan against the same ticket).

## Core rules

- **Artifacts over chat.** Tickets define what and why; plans define how. Stable AC IDs link intent to plan steps and final verification.
- **Humans hold the gates.** Ticket approval is a deliberate edit. `/approve`, `/land`, `/chore`, and `/cancel` never run autonomously.
- **Frontmatter records gates; Beads records reality.** There is no `in progress` artifact status — live progress is a Beads query.
- **Main is canonical for ticket and plan text.** Worktree copies are snapshots; implementers and reviewers receive absolute canonical paths and the approved plan hash.
- **Approval is reproducible.** `/approve` commits the gate artifacts and binds their normalized hashes to a reachable `main` commit in an append-only epic note.
- **Worktrees isolate code.** Each plan gets its own branch and Beads-managed worktree; a step is pushed before its issue closes, so a crashed session strands nothing.
- **Reviews are evidence.** A persisted aggregate artifact binds the exact code SHA and approved-plan identity; `/land` rejects stale review evidence.
- **Memory follows merge.** Implementation stages candidates; `/land` audits and promotes only facts that survive in the merged result.

The complete generated project contract is [`template/thoughts/AGENTS.md`](template/thoughts/AGENTS.md).

## The CLI

### `sdlc hash <file>`

```bash
sdlc hash thoughts/plans/024-f-csv-export.md
# sha256=<hex>
```

One shared implementation used by every skill and check: full-file UTF-8 (frontmatter included), CRLF and lone-CR normalized to LF, exactly one terminal newline for hashing, lowercase hex. Shell `shasum` variants are not part of the contract.

### `sdlc doctor <NNN> [--json]`

```bash
sdlc doctor 024
sdlc doctor 024 --json
```

Deterministic, read-only integrity diagnosis for one line of work: canonical artifacts and hashes, approval history, Git, Beads mappings/dependencies/health, native gates and worktrees, stale-claim and orphan signals, optional merge-slot state, and the latest review. It reports one state:

| State | Meaning | Exit |
|---|---|---|
| `ready_for_planning` | Approved ticket is valid and has no active plan | 0 |
| `ready_for_approval` | Review-state plan is structurally valid and awaits the human gate | 0 |
| `healthy` | The approved hash chain and live execution/review state agree | 0 |
| `reapproval_required` | Ticket or plan drifted, or no approval record can be reproduced | 2 |
| `legacy` | The artifact predates the contract and needs explicit migration | 2 |
| `blocked` | A structural or native coordination invariant makes the next transition unsafe | 3 |

Exit `1` means an invalid invocation or a completely unavailable dependency. Text output is for humans; skills consume `--json`. Models never author or persist a parallel JSON sidecar. (Beads 1.1 embedded mode does not implement JSON `bd doctor`, so embedded health uses guarded context plus focused native checks; server mode runs both agent and server doctor profiles.)

### `sdlc actor <runtime> [--new]`

```bash
sdlc actor claude --new
# sdlc:claude:<session-id>
```

Mints (`--new`) or rehydrates the session-scoped identity used as `BEADS_ACTOR`. Unique actors are what keep two agent sessions under the same OS/Git user from silently sharing a Beads claim. Skills capture the printed literal once at a root boundary and prefix every mutating Beads command with `BEADS_ACTOR="<session-actor>"` — never relying on a shell `export` surviving or on a latest-actor lookup.

### `sdlc review <NNN>`

Local human inspection of an implemented plan (see step 6 above). Optional actions are explicit flags; only `--preview` starts a process.

## Reference

### Tickets and acceptance traceability

Every ticket carries stable acceptance criteria:

```md
## Acceptance Criteria

- AC-001: A user can export the selected records.
- AC-002: Invalid filters use the repository-standard validation response.
```

IDs are never reassigned once a plan exists; removed criteria stay visible as `~~AC-NNN~~ - removed: <reason>`. Plan steps declare `Covers: AC-001, AC-002` (or `Covers: none - <reason>` for pure enabling steps), and the Verification section maps every live AC to an exercise. Doctor refuses missing or unknown coverage unless a human waiver with a reason exists in both the plan and the epic notes (`waiver: id=AC-NNN; reason=...`).

### Reproducible approval

Plans record `Source Ticket Hash: sha256=<hex>`. After `/approve` commits the gate artifacts, the epic receives an append-only record:

```text
approval: plan-sha256=<hex> ticket-sha256=<hex> commit=<main-sha>
```

The latest *reproducible* record wins — its commit must be reachable from `main` and its hashes must match that commit's bytes. Later malformed or unreproducible notes are warnings, never authority.

### Adaptive research

Research is a bounded substage of `/plan`, not another pipeline state. Simple work stays inline. Material repository unknowns become at most three independent, read-only research tracks; researchers cite `file:line`, preserve conflicts and unanswered questions, report confidence, and never plan or edit. At most one synthesis persists at `thoughts/designs/{NNN}-research.md`, pinned to the ticket hash and a Git baseline — so a ticket edit invalidates everything, an unrelated landing invalidates nothing, and only tracks whose cited evidence paths changed are refreshed.

### Review convergence

Three code-reviewer profiles ship (backend, frontend, and a stack-neutral general fallback); the required set is derived from the changed lanes, and mixed diffs run every mapped specialist against the same clean HEAD. Each reviewer verifies the canonical plan against its approved hash before reviewing, uses stable reviewer-scoped IDs (`MF-backend-001`), and on later rounds verifies every prior finding first — a fix that cannot be verified `persists`; uncertainty never clears a blocker — then runs a complete fresh review of the new HEAD.

There is no must-invent-a-finding rule: an approval must instead carry Clean-Pass Evidence covering ticket/AC intent, plan conformance, repository conventions, tests and failure paths, and applicable risk surfaces. An unsupported clean pass is malformed.

One aggregate Markdown artifact per round persists under `thoughts/reviews/`. Its `## Overall` carries strict machine-checked controls, and `Verdict:` is always the final line:

```md
## Overall

Scope-Check: PASS - unplanned=none
AC-Coverage: PASS - verified=AC-001,AC-002; missing=none
Fix-Disposition: fixed=MF-backend-001; persists=none; new=none

- backend-code-reviewer: APPROVED

Verdict: APPROVED
```

Round one uses `Fix-Disposition: N/A`. Any code change invalidates all prior approvals. If a round's MUST FIX count does not decrease, the artifact is persisted, the epic is labeled `human`, and unattended review stops immediately. Plans cap at three rounds, chores at two; malformed same-HEAD retries do not consume a round. An approved aggregate is committed before the epic receives its binding note (`review: APPROVED sha=... code-sha=... plan-sha256=... plan-commit=... rounds=<n>`), and `/land` reproduces every identity in it.

### Native Beads safety

The workflow uses selected Beads primitives without turning Beads into a second workflow engine:

- Unique session actors (`BEADS_ACTOR=sdlc:<runtime>:<session-id>`) keep concurrent sessions from sharing claims.
- Research, critique, code review, snapshots, `/queue`, `/review`, and doctor invoke Beads with native `--readonly` enforcement — prompts are not the boundary.
- A blocking implementation question becomes a dedicated human gate that blocks the step; resolving the gate never closes unfinished work. The `human` label stays a non-gating escalation signal.
- Worktrees are created, discovered, and safely removed through `bd worktree`; dirty files, unpushed commits, or stashes prevent normal cleanup.
- Doctor and `/queue` surface health, dependency cycles, gates, candidate stale claims (corroborated against Git activity), and orphaned issue-referencing commits — as recovery evidence, never as authority for autonomous repair.
- Merge slots (serialized landing) and Dolt server mode are opt-in and conservative by default; `bd batch` is used only for amendment subsets that fit its transactional grammar and never presented as Git/Beads atomicity.

### Bundled agents

- **plan-reviewer** — bounded pre-approval critique with stable `PC-NNN` findings
- **backend-code-reviewer** — backend correctness, plan conformance, repository-grain review
- **frontend-code-reviewer** — UI/design-system, WCAG, responsive, performance, plan conformance
- **general-code-reviewer** — stack-neutral fallback for unmapped lanes
- **pipeline-snapshot** — mechanically read-only facts for `/next` and `/queue`; never chooses a transition

All five are read-only. `setup --claude` installs Claude Code definitions; `setup --codex` renders the same bodies into sandboxed read-only Codex profiles. A missing required reviewer fails closed.

### Tagged project memory

Tickets carry two to five stable retrieval tags. Planning recalls only memories whose stated scope applies. Implementation never writes durable memory — it appends structured `memory-candidate:` notes to the epic, and after the squash merge exists, `/land` audits and promotes only candidates still true in the merged result, with the merge SHA as provenance. Cancelled work never institutionalizes its candidates.

### Migrating pre-0.3.0 work

Artifact shape selects the contract — there is no hidden version file:

- A plan with `Source Ticket Hash` and a reproducible `approval:` record uses the current contract; missing either is `legacy`.
- Draft/review legacy work gains AC IDs, `Covers:`, the source hash, required sections, and a critique before approval.
- Approved legacy work with open issues pauses in `/queue` for an explicit `/approve` re-sync that preserves step and issue IDs.
- Already-complete legacy work with a valid legacy review may land through the compatibility parser, with a prominent warning.
- Legacy shared-identity claims require explicit reassignment; existing step-level `human` labels finish through their legacy path.

Migration never invents semantic AC coverage or waivers without human review.

## Releasing

Skill frontmatter versions align with `package.json`; bump them together:

```bash
npm run bump:patch
npm run bump:minor
```

## Repository layout

```text
skills/                 the ten transition skills installed by the skills CLI
template/
  thoughts/AGENTS.md    generated project workflow contract
  AGENTS.root.md        starter root instructions
  agents/               plan/code reviewers and pipeline snapshot
lib/                    hash, Beads adapter, artifact, review, and doctor logic
bin/sdlc.mjs            setup, hash, doctor, actor, and local-review CLI
test/                   unit and fixture-repository integration tests
scripts/                release-version helpers
```

## Acknowledgements

The RPI loop — the research -> plan -> implement contracts this pipeline adopts (bounded research tracks, hash-bound approvals, plan critique, review convergence) — builds on workflows contributed by [Southpaw17](https://github.com/Southpaw17) and [JeffBNimble](https://github.com/JeffBNimble).

## License

MIT
