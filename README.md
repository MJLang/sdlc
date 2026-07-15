# sdlc

Turn a ticket into reviewed, merged code without giving an agent control of the gates.

sdlc packages an agent-driven software development workflow as [agent skills](https://skills.sh). It uses Beads for coordination, gives each plan its own Git worktree, and saves the evidence from every review. A person must approve each irreversible step.

Tickets and plans are Markdown files you can inspect and edit. Approvals are tied to committed content hashes, reviews are saved as artifacts, and the current execution state is available through the CLI.

See [How sdlc works under the hood](docs/under-the-hood.md) for the implementation and recovery model.

## How it works

The workflow keeps each kind of information in one place:

| Store | What it contains |
|---|---|
| `thoughts/` on `main` | The canonical ticket, plan, and research text, committed when the plan is approved |
| [Beads](https://github.com/gastownhall/beads) | Live issues, dependencies, claims, gates, and notes |
| One Git worktree per plan | Code changes and saved review artifacts |
| Epic approval notes | The hash chain that connects approved artifacts to a commit on `main` |

Copies of tickets and plans inside a worktree are snapshots. The canonical text always comes from `main`. `/next` performs one valid transition at a time and stops at every human gate.

## Requirements

- Git for branches, commits, and worktrees. A remote is strongly recommended.
- [Beads](https://github.com/gastownhall/beads) `>= 1.1.0` (`bd`) for issues, dependencies, atomic claims, gates, worktree safety, and recovery signals.
- Node.js 18 or newer for setup, hashing, snapshots, guards, gates, context packets, and local review.
- An agent that supports skills. sdlc is built for Claude Code and Codex, but you can install it anywhere supported by the skills CLI.

## Install

Run setup inside your project and choose an agent target. If you omit the target, setup uses the Claude Code-compatible default.

```bash
npx @mlangroman/sdlc setup --claude
npx @mlangroman/sdlc setup --codex
```

Setup performs these seven tasks:

1. Initializes Git if needed.
2. Creates `thoughts/{tickets,plans,designs,docs,reviews}/`, a compact workflow contract, a documentation index, and `CLAUDE.md -> AGENTS.md` symlinks.
3. Creates a starter root `AGENTS.md`. An existing root instruction file is preserved unless you pass `--force`.
4. Installs all ten skills in `.agents/skills/` and symlinks the same copies for Claude Code.
5. Installs four read-only reviewer profiles for Claude Code, Codex, or both.
6. Checks for Beads `>= 1.1.0` and the required capabilities, then initializes Beads if needed.
7. Installs or updates `.beads/PRIME.md`, a small project prime that does not inject memory bodies.

Available flags are `--claude` (the default), `--codex`, `--force`, `--skip-skills`, `--skip-agents`, and `--skip-beads`. Pass both agent flags to install support for Claude Code and Codex. `--skip-beads` only skips scaffolding; transitions backed by Beads will not run or report healthy without it.

To install only the skills for another supported agent:

```bash
npx skills add MJLang/sdlc
npx skills add MJLang/sdlc --skill ticket --skill plan
```

## Configure a project

Edit the configuration block in the generated `thoughts/AGENTS.md`:

```md
- **Targets:** `app`
- **Quality gates:**
  - `npm test`
- **Target gates:** `app -> npm run test:app`
- **Target paths:** `app -> src/**, test/**`
- **Reviewers:** `all targets -> backend-code-reviewer`
- **Product docs:** `thoughts/docs/`
- **Frontend constraints:** none
- **Beads merge slot:** `off`
- **Beads mode:** `embedded`
- **Review editor:**
- **Local preview:**
- **Preview URL:**
```

| Setting | Purpose |
|---|---|
| `Targets` | Lists the parts of the repository where work can land, such as `cms | jobs | web` in a monorepo. |
| `Quality gates` | Defines ordered global commands for `sdlc gates`. Shell quoting is preserved exactly. |
| `Target gates` | Adds a command for one target. Repeat `Target gates: <target> -> <command>` as needed. Unknown targets are rejected. |
| `Target paths` | Maps a target to review paths. Repeat `Target paths: <target> -> <glob-list>` as needed. More specific matches come first, and an overlapping path belongs to every matching lane. |
| `Reviewers` | Maps targets to bundled reviewers. Unmapped lanes use `general-code-reviewer`. |
| `Beads mode` | Use `embedded` for one mutating session with read-only observers. Use `server` only when multiple root sessions must mutate state concurrently. |
| `Beads merge slot` | Leave this `off` until you have concurrent landers and a tested way to recover a stale holder. |

Add product and vision documents to `thoughts/docs/INDEX.md`. Ticket and plan creation reads the overview and rows that match the current targets or tags. It opens more documents only when the indexed material leaves an ambiguity.

## Run the pipeline

### 1. Write a ticket

```text
/ticket Add CSV export with filter validation
```

This creates `thoughts/tickets/{NNN}-*.md` with a summary, scope, and stable acceptance criteria such as `AC-001` and `AC-002`. New tickets have `Status: draft`.

### 2. Approve the ticket by hand

Read the ticket, then change `Status: draft` to `Status: approved`. That deliberate edit is the first human gate.

### 3. Write the plan

```text
/plan 024
```

The planner researches the repository. When the work has material unknowns, it may start up to three isolated, read-only research tracks. It then writes `thoughts/plans/024-*.md`. Each numbered step has `Covers:`, `Files:`, `Depends on:`, and `Parallelizable:` fields. The plan also includes `Current-State Findings` and an `Approval Attention` section for risky operations. Its `Verification` section maps every acceptance criterion to an exercise.

The bundled `plan-reviewer` runs one critique. If the planner fixes a blocker, the reviewer may run one more check limited to that correction. The plan then stops at `Status: review`.

### 4. Approve the plan

```text
/approve 024
```

Approval creates a Beads epic and its dependent step issues. It commits the ticket, plan, and research synthesis to `main`, then records their approval hash chain on the epic. If you edit an approved artifact, implementation stops until `/approve 024` records the amendment.

### 5. Implement the plan

```text
/implement 024
```

Implementation first runs the compact `implement` guard. It claims the epic with an identity unique to the current session, creates a Beads-managed worktree, and works through dependency-ordered step packets. Each step returns a fixed handoff, runs `sdlc gates`, and commits and pushes before its issue closes.

When the steps are done, sdlc builds review packets for each lane and includes a complete list of changed files. Blocking questions become Beads gates for a person to resolve. `/implement` never merges the work.

### 6. Inspect the work locally

This step is optional.

```text
/review 024
```

You can also run `sdlc review 024` in a terminal with `--editor`, `--artifact`, `--diff`, or `--preview`. The command locates the worktree, canonical ticket and plan, diff, review artifact, and doctor summary. It is read-only and does not record approval.

### 7. Land the change

```text
/land 024
```

Landing checks the reviewed code SHA and the identity of the approved plan. It squash-merges the work into `main`, audits and promotes project memory from the merged result, closes the epic, and removes the worktree and branch. Landing is the final human gate.

### Small changes

`/chore fix the typo in the export header` skips the plan. In one human-invoked pass, it creates a ticket, opens a worktree, runs the gates and review, then merges under the same safety and review contracts.

### Autonomous progress

`/next` reads one compact, deterministic `sdlc snapshot`. It performs the first selected transition, preferring implementation over planning, or reports that the queue is idle. An idle run starts no subagent and gathers no more facts. You can pair `/next` with your agent's loop feature to keep work moving, but it can never approve, land, or cancel anything.

### Status and recovery

`/queue` is a read-only dashboard for work that needs a person, work in progress, and stale or drifted state. It includes the exact recovery command for each problem. Use `/cancel 024` to cancel a line of work or `/cancel 024 plan` to discard the plan and plan the same ticket again.

## Core rules

- Tickets explain what to build and why. Plans explain how to build it. Stable acceptance criterion IDs connect the ticket to plan steps and final verification.
- People control the gates. Ticket approval requires a deliberate edit, and `/approve`, `/land`, `/chore`, and `/cancel` never run autonomously.
- Frontmatter records gates; Beads records current activity. Artifacts do not have an `in progress` status.
- Ticket and plan text on `main` is canonical. Worktree copies are snapshots, and implementers and reviewers receive absolute canonical paths plus the approved plan hash.
- `/approve` commits the gate artifacts and appends their normalized hashes, along with a reachable `main` commit, to the epic.
- Every plan uses a separate worktree. Each step is pushed before its issue closes, so a crashed session does not strand unpushed work.
- A saved aggregate review binds the exact code SHA to the approved plan. `/land` rejects review evidence after it becomes stale.
- Implementation stages memory candidates. `/land` promotes only facts that remain true in the merged result.

The full generated project contract is in [`template/thoughts/AGENTS.md`](template/thoughts/AGENTS.md).

## CLI reference

### `sdlc hash <file>`

```bash
sdlc hash thoughts/plans/024-f-csv-export.md
# sha256=<hex>
```

Every skill and check uses the same hash function. It reads the full file as UTF-8, including frontmatter; converts CRLF and lone CR line endings to LF; and hashes the content with exactly one final newline. The output is lowercase hexadecimal. Shell variants of `shasum` are not part of this contract.

### `sdlc doctor <NNN> [--json]`

```bash
sdlc doctor 024
sdlc doctor 024 --json
```

`doctor` is a deterministic, read-only integrity check for one line of work. It verifies the canonical artifacts, hashes, and approval history. It then compares Git with the Beads mappings, dependencies, health, native gates, and worktrees. The report also covers stale claims, orphan signals, the newest review, and merge-slot state when that feature is enabled.

It returns one of these states:

| State | Meaning | Exit |
|---|---|---|
| `ready_for_planning` | The approved ticket is valid and has no active plan. | 0 |
| `ready_for_approval` | The plan is structurally valid, has review status, and is waiting for a person. | 0 |
| `healthy` | The approved hash chain agrees with the current execution and review state. | 0 |
| `reapproval_required` | The ticket or plan changed, or no approval record can be reproduced. | 2 |
| `legacy` | The artifact predates the current contract and needs an explicit migration. | 2 |
| `blocked` | A structural or native coordination invariant makes the next transition unsafe. | 3 |

Exit `1` means the invocation is invalid or a required dependency is completely unavailable. People can read the text output; skills use `--json`. Models never write or save a parallel JSON sidecar.

Beads 1.1 in embedded mode does not implement JSON output for `bd doctor`. In that mode, sdlc uses guarded context and focused native checks. Server mode runs both the agent and server doctor profiles.

### `sdlc snapshot --view=next|queue --json`

`snapshot` collects the Beads installation, context, health, and ready work. It records gate dependency edges and worktrees, then checks for stale claims, orphans, cycles, and escalations. It also includes Git corroboration, optional merge-slot state, and one diagnosis for every active artifact. The `next` view returns ordered candidates, stable rejection codes, and the selected transition. The `queue` view returns the five dashboard sections. Output is compact JSON with stable keys, and the command is mechanically read-only.

### `sdlc guard <stage> <NNN>`

Valid stages are `plan`, `approve`, `implement`, `review`, and `land`. An accepted guard prints one `OK` line. That line contains only the caller's identity and state fields plus stable warning codes. A refusal prints coded errors and a recovery command while preserving the doctor exit meanings: `2` for drift or legacy data, `3` for a blocker, and `1` for invalid input or an unavailable dependency. Use `sdlc doctor --json` for the full diagnosis.

### `sdlc gates [--cwd <worktree>] [--target <target>]`

`gates` runs the configured global commands, followed by commands for the selected target. Add a deliberate one-off command by repeating `--command <cmd>`; it receives the label `ad-hoc`. Successful runs print one line with duration and counts. A failure returns a bounded excerpt and the full log path without hiding the failing exit code.

Logs have owner-only permissions. sdlc keeps ten runs, caps each log with a truncation marker, and stores them under the common Git directory. If that location is unavailable, it uses an owner-only, repository-specific temporary directory. If neither location is safe, it refuses to run the commands.

### `sdlc review-packet <NNN>`

`review-packet` creates one deterministic packet per configured reviewer. Use `--reviewer` to select one reviewer. The `--base`, `--head`, and `--json` flags control the projection. A packet contains the current ticket intent and acceptance criteria, approved identity, and relevant plan steps. It also contains every changed file, the lane diff, lexical cross-lane interfaces in both directions, the latest gate summary, and earlier findings.

Without `Target paths`, the model classifies changes. The CLI does not apply a silent heuristic.

### `sdlc actor <runtime> [--new]`

```bash
sdlc actor claude --new
# sdlc:claude:<session-id>
```

`actor` creates or restores the session identity used for `BEADS_ACTOR`. Unique actors prevent two agent sessions under the same OS and Git user from sharing a Beads claim. At the root boundary, a skill captures the printed value once and prefixes every mutating Beads command with `BEADS_ACTOR="<session-actor>"`. It does not depend on a shell `export` surviving or look up the most recent actor.

### `sdlc review <NNN>`

This command opens a local inspection of an implemented plan, as described in step 6. Every optional action requires an explicit flag, and only `--preview` starts a process.

## Reference

### Tickets and acceptance traceability

Every ticket has stable acceptance criteria:

```md
## Acceptance Criteria

- AC-001: A user can export the selected records.
- AC-002: Invalid filters use the repository-standard validation response.
```

Once a plan exists, criterion IDs are never reassigned. Removed criteria stay in the ticket as `~~AC-NNN~~ - removed: <reason>`. Each plan step declares `Covers: AC-001, AC-002`, or `Covers: none - <reason>` for a purely enabling step. The Verification section maps every active criterion to an exercise.

Doctor rejects missing or unknown coverage unless a person records the same reasoned waiver in both the plan and the epic notes: `waiver: id=AC-NNN; reason=...`.

### Reproducible approval

Plans record `Source Ticket Hash: sha256=<hex>`. After `/approve` commits the gate artifacts, it appends this record to the epic:

```text
approval: plan-sha256=<hex> ticket-sha256=<hex> commit=<main-sha>
```

The newest reproducible record is authoritative. Its commit must be reachable from `main`, and its hashes must match the bytes in that commit. Later notes that are malformed or cannot be reproduced produce warnings but never become authoritative.

### Adaptive research

Research is a bounded part of `/plan`, not a separate pipeline state. Simple work stays in the planning session. Material unknowns in the repository can become up to three independent, read-only research tracks. Researchers cite `file:line`, retain disagreements and unanswered questions, report confidence, and do not plan or edit.

At most one summary is saved to `thoughts/designs/{NNN}-research.md`. It is tied to the ticket hash and a Git baseline. Editing the ticket invalidates all of the research. An unrelated landing invalidates none of it. Only tracks whose cited evidence paths changed need to run again.

### Review convergence

sdlc includes backend, frontend, and stack-neutral code reviewers. The configured `Target paths` determine which reviewers run. Each reviewer receives the diff for its lane, cross-lane interfaces, and a complete changed-file list from the same clean HEAD.

Interface discovery reads the complete contents of changed files in both directions and resolves imports, requires, and includes lexically. Binary, unreadable, and unmatched files remain visible in the inventory without being assigned by a fallback guess. Each reviewer checks the approved plan hash and uses stable IDs scoped to that reviewer, such as `MF-backend-001`. In later rounds, it verifies old findings before reviewing a fresh packet for the new HEAD.

Reviewers do not need to invent a finding. An approval must instead include Clean-Pass Evidence for the ticket and acceptance criteria, plan conformance, repository conventions, tests and failure paths, and any relevant risk surfaces. An unsupported clean pass is malformed.

Each round saves one aggregate Markdown artifact under `thoughts/reviews/`. Its `## Overall` section contains machine-checked controls, and `Verdict:` must be its final line:

```md
## Overall

Scope-Check: PASS - unplanned=none
AC-Coverage: PASS - verified=AC-001,AC-002; missing=none
Fix-Disposition: fixed=MF-backend-001; persists=none; new=none

- backend-code-reviewer: APPROVED

Verdict: APPROVED
```

The first round uses `Fix-Disposition: N/A`. Any code change invalidates earlier approvals. If the number of MUST FIX findings fails to decrease in a round, sdlc saves the artifact, labels the epic `human`, and stops unattended review. Plans allow at most three rounds and chores allow two. A retry for a malformed artifact at the same HEAD does not consume a round.

Before adding its binding note to the epic, sdlc commits the approved aggregate. The note has the form `review: APPROVED sha=... code-sha=... plan-sha256=... plan-commit=... rounds=<n>`. `/land` reproduces every identity in that record.

### Native Beads safety

sdlc uses specific Beads features without asking Beads to act as another workflow engine:

- A session-specific actor, `BEADS_ACTOR=sdlc:<runtime>:<session-id>`, prevents concurrent sessions from sharing claims.
- Research, critique, code review, snapshots, `/queue`, `/review`, and doctor use native Beads `--readonly` enforcement. Prompts are not the security boundary.
- A blocking implementation question creates a dedicated human gate for the step. Resolving the gate does not close unfinished work. The `human` label remains a separate, non-gating escalation signal.
- sdlc creates, finds, and safely removes worktrees through `bd worktree`. Dirty files, unpushed commits, and stashes stop normal cleanup.
- Doctor and `/queue` report health, dependency cycles, gates, possible stale claims corroborated by Git activity, and orphaned commits that refer to issues. These are recovery clues, not permission for an autonomous repair.
- Merge slots, which serialize landing, and Dolt server mode are conservative, opt-in settings. `bd batch` is limited to amendment subsets supported by its transaction grammar and is never presented as atomic across Git and Beads.

### Bundled agents

| Agent | Job |
|---|---|
| `plan-reviewer` | Runs a bounded pre-approval critique with stable `PC-NNN` findings. |
| `backend-code-reviewer` | Checks backend correctness, plan conformance, and repository conventions. |
| `frontend-code-reviewer` | Checks the UI and design system, WCAG, responsive behavior, performance, and plan conformance. |
| `general-code-reviewer` | Provides a stack-neutral fallback for unmapped lanes. |

All four agents are read-only. `setup --claude` installs Claude Code definitions. `setup --codex` renders the same bodies as sandboxed, read-only Codex profiles. Snapshot collection runs in the CLI, not in an agent. If a required reviewer is missing, the workflow stops.

### Tagged project memory

The project prime installed by setup contains workflow pointers but no memory bodies. Each ticket carries two to five stable retrieval tags. Planning searches for exact `tag:<tag>` markers and recalls only applicable keys. Implementation appends `memory-candidate:` notes. After the squash merge, `/land` promotes only facts that are still true and records the merge SHA as provenance. Cancelled work never promotes its candidates.

### Migrate an existing install to 0.4

Run setup again with the required agent target and `--force`. This refreshes the compact contracts, skills, reviewer profiles, and managed prime. Setup creates the documentation index only when it is missing, so it keeps a project-curated index intact. Add the ordered `Quality gates` plus any repeated `Target gates` and `Target paths` lines to Project Configuration. A project without `Target paths` remains safe, but review packets retain the complete diffs so the model can classify them explicitly.

The old `pipeline-snapshot` profile is no longer installed. Remove stale copies from `.claude/agents/pipeline-snapshot.md` and `.codex/agents/pipeline-snapshot.toml`. `/next` and `/queue` now call `sdlc snapshot` directly.

Gate logs can contain sensitive test output. sdlc retains ten owner-only, capped runs in Git common state or the documented temporary fallback, never in the worktree.

Setup manages `.beads/PRIME.md`. If you do not rerun setup, copy `template/beads/PRIME.md` there so new sessions stop injecting memory bodies. Fill in `thoughts/docs/INDEX.md` before depending on targeted document reads.

### Migrate work from before 0.3.0

The shape of an artifact selects its contract; there is no hidden version file.

- A plan uses the current contract when it has both `Source Ticket Hash` and a reproducible `approval:` record. If either is missing, it is `legacy`.
- Before approval, legacy tickets and plans need acceptance criterion IDs, `Covers:` fields, the source hash, all required sections, and a critique.
- Approved legacy work with open issues pauses in `/queue` for an explicit `/approve` resync that preserves step and issue IDs.
- Completed legacy work with a valid legacy review can land through the compatibility parser, which prints a prominent warning.
- A legacy claim that shares an identity must be reassigned explicitly. Existing step-level `human` labels finish through the legacy path.

Migration never invents semantic acceptance coverage or waivers without human review.

## Release

Skill frontmatter versions must match `package.json`. Bump them together:

```bash
npm run bump:patch
npm run bump:minor
```

## Repository layout

```text
docs/                   architecture and implementation guides
skills/                 the ten transition skills installed by the skills CLI
template/
  thoughts/AGENTS.md    generated project workflow contract
  AGENTS.root.md        starter root instructions
  beads/PRIME.md        minimal project-specific Beads prime
  agents/               read-only plan and code reviewers
lib/                    config, diagnostics, snapshots, guards, gates, packets, artifacts
bin/sdlc.mjs            setup and public workflow CLI
test/                   unit and fixture-repository integration tests
scripts/                release-version helpers
```

## Acknowledgements

The research -> plan -> implement contracts in this pipeline draw on the RPI loop contributed by [Southpaw17](https://github.com/Southpaw17) and [JeffBNimble](https://github.com/JeffBNimble). Those ideas include bounded research tracks, hash-bound approvals, plan critique, and review convergence.

## License

MIT
