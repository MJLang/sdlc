# SDLC Workflow Contract

The pipeline is `ticket -> plan -> approve -> implement -> land`. Frontmatter
records human-gate state; Beads records live execution. Run each transition
through its owning skill instead of reproducing its procedure here.

## Project Configuration

This section is the configuration authority. Gate commands are opaque shell
strings and run in listed order. Repeat `Target gates` and `Target paths` lines
when needed; target-path overlap deliberately assigns a file to every match.

- **Targets:** `app`
- **Quality gates:**
  - `npm test`
- **Target gates:** <!-- optional: `app -> npm run test:app` -->
- **Target paths:** `app -> **`
- **Reviewers:** `all targets -> backend-code-reviewer`
- **Product docs:** `thoughts/docs/`
- **Frontend constraints:** `none`
- **Beads merge slot:** `off`
- **Beads mode:** `embedded`
- **Review editor:** <!-- optional: `code {worktree}` -->
- **Local preview:** <!-- optional: `npm run dev -- --port {port}` -->
- **Preview URL:** <!-- optional: `http://localhost:{port}` -->

`Quality gates` are global. `Target gates: <target> -> <command>` adds a command
for one configured target. `Target paths: <target> -> <comma-separated globs>`
classifies review lanes; malformed or unknown targets are refused. Keep embedded
Beads for one mutating root plus read-only observers; use server mode only for
genuine concurrent writers. Enable the merge slot only after initializing it
under an authorized actor and documenting stale-holder recovery.

## Authority

| Concern | Authority |
|---|---|
| Ticket, research, and approved plan text | Primary `main` checkout |
| Approved ticket/plan identity | Latest reproducible `approval:` epic note |
| Execution graph, claims, gates, progress, notes | Beads |
| Code and aggregate review artifact | Beads-visible plan worktree |
| Durable project knowledge | Beads memories promoted after merge |

Worktree ticket/plan copies are snapshots, never gate inputs. Do not merge,
copy, or rebase artifact snapshots into a live worktree.

## Universal Invariants

- Beads `>= 1.1.0` and its required native capabilities are mandatory. Do not
  replace native gates/worktrees with labels or raw Git worktree commands.
- Observers use only `bd --readonly`; doctor, snapshot, queue, research,
  critique, and review never repair state.
- A mutating root captures one `sdlc actor <runtime> --new` value. Every Beads
  mutation supplies that exact `BEADS_ACTOR` literal; subagents never infer or
  reuse another session's owner.
- The first implementation mutation is the atomic epic claim. A different
  owner, orphan ambiguity, corroborated stale claim, or unsafe native cleanup
  stops execution for explicit recovery.
- A blocking human decision uses a dedicated gate that blocks the relevant
  issue. The `human` label is only a non-gating escalation.
- Ticket/plan status never means “in progress.” Tickets are
  `draft|approved|implemented|cancelled`; plans are
  `draft|review|approved|merged|cancelled`.
- AC IDs and plan-step numbers are stable after planning. Removed entries stay
  visible with reasons; approval waivers are explicit in both artifacts and
  epic notes.
- Discovery is planned work (`ticket -> plan -> approve -> implement -> review -> land`), not a chore lane. Its result is `thoughts/designs/{NNN}-discovery.md`; either `validated` or `invalidated` may complete it, while inconclusive work remains active behind an amended protocol or human gate.
- Implementation commits and pushes a step before closing its issue. Review
  runs after all active children close and persists one aggregate artifact per
  completed round. Only `/land` merges.

## Human Gates

Humans explicitly approve a draft ticket, invoke `/approve`, invoke `/land`,
authorize destructive cancellation after seeing its blast radius, and resolve
dedicated execution-time gates. `/next` may invoke only `/plan` or `/implement`,
performs one transition, and never crosses these boundaries.

Approval Attention does not itself grant execution-time consent. An item still
marked open at landing requires a resolved dedicated-gate record naming its
`AA-NNN` and decision.

## Integrity and Compact Commands

`sdlc hash <file>` prints the normalized full-file `sha256=<hex>`. Plans pin the
ticket hash; approvals pin ticket hash, plan hash, and a main-reachable commit.
Editing an approved artifact requires amendment approval.

- `sdlc doctor <NNN> --json`: full read-only diagnosis and recovery evidence.
- `sdlc guard <stage> <NNN>`: one-line accepted preflight; on refusal, follow
  its coded recovery and run full doctor only when needed.
- `sdlc snapshot --view=next|queue --json`: the normative read-only transition
  eligibility/dashboard snapshot.
- `sdlc gates [--cwd <worktree>] [--target <target>]`: configured gates with
  terse passes, bounded failures, and full logs outside the worktree.
- `sdlc review-packet <NNN>`: lane-scoped diff plus complete inventory.

## Owning Procedures

Detailed procedures live only in their loaded-when-needed skills:

- `/ticket`: intent artifact and documentation-index lookup;
- `/plan`: targeted docs/memories, optional research, plan, critique;
- `/approve`: first approval, amendment, recovery, graph synchronization;
- `/implement`: claims, step packets/results, gates, aggregate review;
- `/review`: local read-only human inspection;
- `/land`: freshness, merge, memory audit, close/publish/cleanup;
- `/chore`, `/cancel`, `/next`, `/queue`: their named lanes.

Product documentation is indexed by `thoughts/docs/INDEX.md`. Memory bodies are
retrieved only by tag search plus explicit recall; `/plan` owns retrieval and
`/land` owns post-merge audit/promotion.
