# Counterproposal: simplify the work a user has to do

Date: 2026-07-26
Status: proposed backlog
Responds to: `thoughts/research/simple.md`

## Decision

`simple.md` is a useful code review, but code reduction is the wrong success
measure for this effort. A smaller resolver, fewer enums, or fewer lines of skill
prose do not make the product simpler unless a person has less work to do.

For this proposal, simplification means:

- fewer commands between a request and the next genuine human decision;
- less waiting for preflight, gates, and retries;
- no manual editing or low-level Beads surgery for normal transitions;
- no failed run caused only by copying a value or formatting an artifact;
- one executable next action whenever a safe action exists, with a precise
  explanation when it does not;
- safe setup and upgrades without reconstructing configuration by hand.

Human judgment is not friction to remove. Ticket approval, plan approval,
execution-time consent, and landing remain explicit human boundaries.

## What changed after the recheck

The useful parts of `simple.md` are the parts that prevent a user-visible wait,
retry, or recovery exercise. The rest may still be worthwhile maintenance, but
it should not lead this backlog.

| Finding in `simple.md` | Decision | User-facing reason |
|---|---|---|
| Expose the Beads adapter as `sdlc bd` | Replace | A generic proxy still makes the caller choose a low-level verb, actor, target, and transaction order. Add task-level recovery commands instead. |
| Derive review fields | Keep, with a finalization phase | Copied counts, identities, and aggregate verdicts cause avoidable retries. Evidence and PASS/FAIL judgment still belong to the reviewer. |
| Add templates for every artifact | Narrow | Ticket and plan errors should be reported while those artifacts are written. There is no evidence yet that every research artifact needs a public template command. |
| Add a chore guard or fold chore into the main lane | Keep the outcome, reject the zero-step plan model | A chore should be one reliable user invocation. Its internal representation does not need to match a planned lane. |
| One resolver, warning table, and state vocabulary | Implementation detail | Use these refactors inside a user-facing ticket when they make an action reliable. Do not ship them as simplification by themselves. |
| Reduce packet fields and reviewer profile duplication | Defer | `plan.steps[].text` is consumed by JSON review packets, and the complete changed-file inventory is a review safety contract. Measure review cost before removing either. |
| Replace the configuration grammar | Use the existing JSON direction, but improve migration | A denser Markdown mini-grammar is not easier to use. The existing Ticket 002 has the right destination, but asking users to copy twelve settings by hand is unnecessary. |
| Remove optional exports and repeated documentation | Maintenance only | These changes do not reduce commands, decisions, waiting, retries, or recovery work. |

Two claims in `simple.md` also need tighter boundaries:

1. A validator can prove some fields wrong only after reviewer evidence exists.
   The template cannot know those values at generation time. The usable flow is
   generate, fill evidence, finalize, then validate.
2. A single artifact resolver is not automatically one correct applicability
   rule. Doctor, resume, review, and historical inspection intentionally operate
   in different state contexts. Shared resolution is useful only where the
   caller semantics remain explicit.
3. Dropping a retained full-file string from the review packet index saves
   memory, but it does not remove the read while that content is still scanned
   for imports. That is not a user-visible latency win without a measured change
   to the indexing path.

## Current user baseline

Tranche 1 is already committed at `f8ed841`. It added safe claim adoption,
reduced repeated Beads inspection, and reports all guard blockers. The current
uncommitted tranche adds review artifact generation and validation. This
proposal assumes that work lands before the tickets below begin.

The remaining friction is visible at the product surface:

| User task | Current experience | Evidence |
|---|---|---|
| Approve a ticket | Edit `Status: draft` by hand | `README.md`, "Approve the ticket by hand" |
| Resolve a stop | Some queue actions contain `BEADS_ACTOR`, raw `bd`, placeholders, or prose instructions | `lib/snapshot.mjs`, `skills/sdlc-implement/SKILL.md`, `skills/sdlc-chore/SKILL.md` |
| Complete a review | The model copies counts, summaries, identities, and an aggregate verdict into a strict grammar | `lib/review-artifact.mjs`, `skills/sdlc-implement/review.md` |
| Discover a malformed plan | Some structural errors first become visible during approval | `lib/artifacts.mjs`, `skills/sdlc-plan/SKILL.md` |
| Run a step | The default quality gate can be the complete suite every time | `skills/sdlc-implement/SKILL.md`, `lib/gates.mjs` |
| Make a small change | `/sdlc-chore` promises one pass but implements a separate 142-line manual procedure with no chore guard | `skills/sdlc-chore/SKILL.md`, `lib/guard.mjs` |
| Continue unattended work | `/sdlc-next` performs one selected transition and stops, including after its own success | `skills/sdlc-next/SKILL.md` |
| Refresh an installation | `setup --force` overwrites configuration stored in the generated contract | Ticket 002 and `README.md`, "Updating an existing project" |

On this repository, `npm test` passed 178 of 178 tests in 163.2 seconds during
this recheck. A representative 79-test non-native subset took 20.0 seconds with
serial test execution and 53.3 seconds with default concurrency. Those numbers
are a local baseline, not a universal performance claim. They show that the
step feedback path and the pre-land confidence path should not be the same
command by accident.

## Target user journey

For planned work, the system should advance until it reaches a real human
boundary:

```text
describe work
-> approve ticket
-> approve plan
-> resolve an execution-time decision, only when one exists
-> land
```

Planning, implementation steps, review rounds, and routine state checks are
mechanical progress between those boundaries. One top-level
continuation invocation should perform that progress and stop with one exact
next action.

For a bounded chore, one `/sdlc-chore` invocation should either land the change
or stop at a genuine human decision. A crash may require the user to invoke the
reported resume command, but it must not require constructing a Beads mutation.

The release-level measures are:

| Measure | Target |
|---|---|
| Manual edits required for a transition | 0 |
| Raw `bd` commands a user must construct in normal use | 0 |
| Recoverable stops without an executable next command | 0 |
| Review retries caused only by derived-field mismatch or dash choice | 0 |
| Top-level continuation invocations from an approved plan to reviewed code, with no genuine blocker | 1 |
| Top-level chore invocations from a clean checkout to merge, with no genuine blocker | 1 |
| Full-suite runs during each ordinary implementation step | 0 when a fast profile is configured |
| Settings manually copied during a supported configuration migration | 0 |

## Ticket sequence

The identifiers below are proposal labels, not repository ticket numbers.
Allocate the next real `NNN` only when a ticket is accepted. Each ticket has a
standalone user result and acceptance criteria that can be copied into
`thoughts/tickets/`.

| Order | Proposal label | Ticket | Depends on |
|---|---|---|---|
| 1 | UX-01 | Safe configuration migration | None after the current branch lands |
| 2 | UX-02 | Review evidence finalization | None after the current branch lands |
| 3 | UX-03 | Artifact errors at write time | None after the current branch lands |
| 4 | UX-04 | One safe action from every stop | Tranche 1 |
| 5 | UX-05 | Fast status, fast step gates, full boundary gates | UX-01 |
| 6 | UX-06 | A chore that is actually one pass | UX-02, UX-04, UX-05 |
| 7 | UX-07 | Transactional plan approval and amendment | UX-03, UX-04 |
| 8 | UX-08 | Continue until the next human boundary | UX-02, UX-04, UX-05, UX-07 |

UX-01 through UX-05 can be developed independently where their file sets do not
overlap. UX-06 through UX-08 consume the public behavior established by the
earlier tickets and should not invent private alternatives.

## UX-01: Migrate configuration without making the user reconstruct it

User result: refreshing sdlc keeps project settings intact, and an existing
project moves to `.agents/sdlc.json` with one explicit migration command.

Starting point: amend `thoughts/tickets/002-project-config-json.md` and its plan
instead of creating a second configuration design. The ticket is currently
`draft`, while the plan says `approved`, has no Beads epic, and records a
degraded critique. Treat them as proposal artifacts: amend both, run the missing
independent critique, validate them, and take them through approval together.

Scope:

- Keep `.agents/sdlc.json`, the restricted local overlay, field validation,
  source reporting, a shipped example, and a complete configuration reference.
- Add `sdlc config migrate` with a read-only preview and an explicit `--write`
  mode. It converts the existing `## Project Configuration` values without
  requiring copy and paste.
- Make migration recoverable. If a value is ambiguous or invalid, report every
  problem and write nothing. On `--write`, persist and validate the JSON before
  removing the legacy value block, record the phase under the Git common
  directory, and make a rerun finish an interrupted migration.
- After a successful migration, `setup --force` replaces the generated contract
  while leaving both configuration files byte-identical.
- Keep the old Markdown reader only inside the migration path. Runtime stages
  read JSON and refuse a remaining legacy configuration block.
- Store gates under a `full` profile in the first JSON shape. UX-05 can add an
  optional `fast` profile later without forcing users through another format
  migration.
- Drop the unconsumed role-to-tier-to-model policy from this ticket. JSON can
  gain that optional block when a command actually uses it.

Acceptance criteria:

- AC-001: `sdlc config migrate` shows the source values, proposed JSON, target
  path, and contract edit without changing the repository.
- AC-002: `sdlc config migrate --write` converts every currently supported
  setting, including repeated target gates and paths, with no manual value entry.
  Existing quality gates become the `full` profile, and the legacy value block
  is removed only after the JSON passes validation.
- AC-003: Invalid or ambiguous legacy values produce all field-specific errors
  and leave both files byte-identical.
- AC-004: A successful migration is recoverable through Git and does not replace
  an existing `.agents/sdlc.json`.
- AC-005: Fault injection after each file operation leaves either the original
  state or a resumable migration. Rerunning the same command completes without
  losing or duplicating a setting.
- AC-006: Two subsequent `sdlc setup --force` runs leave shared and local
  configuration byte-identical.
- AC-007: Missing, unknown, and invalid JSON values block a stage before work
  starts and name the file, field, value, and corrective command.
- AC-008: A local overlay can change only machine settings. Attempts to weaken
  gates, targets, reviewers, Beads mode, or merge-slot policy are refused by
  field name.
- AC-009: Gate commands containing backticks, pipes, semicolons, and `->`
  round-trip and execute without rewriting.
- AC-010: The shipped example, schema, and reference cover the same keys under
  an automated drift check.
- AC-011: The migration fixture covers a real generated 0.5.1 contract and
  completes with one user command plus the documented setup refresh.

Out of scope: model selection policy, changes to gate semantics, and a second
configuration syntax.

## UX-02: Let reviewers write evidence, then derive the aggregate

User result: review does not stop because an agent copied a count, identity,
summary, path set, or aggregate verdict incorrectly.

Scope:

- Extend the in-flight `review-artifact --template` work with a finalization
  operation. A concrete surface is
  `sdlc review-artifact --finalize <draft> --output <artifact>`.
- Prefill values known before review: artifact identity, reviewer set, changed
  path set for scope judgment, live acceptance-criterion IDs, and round-one
  `Fix-Disposition: N/A`.
- Keep reviewer-authored evidence, finding severity, PASS/FAIL judgments,
  dispositions, and clean-pass evidence as reviewer decisions.
- During finalization, derive component finding counts, reviewer summary lines,
  aggregate verdict, finding buckets, and the review note payload.
- Use the same path in planned and chore reviews. Remove chore's hand-authored
  aggregate skeleton.
- Preserve the current saved artifact grammar so doctor and existing artifacts
  remain compatible.

Acceptance criteria:

- AC-001: A reviewer draft containing all required evidence can omit every
  mechanically derived field and still finalize into a valid aggregate.
- AC-002: Finalization derives the same aggregate verdict and finding counts as
  the validator for approved, blocked, nit-only, and multi-reviewer fixtures.
- AC-003: Scope paths and live AC IDs come from the reviewed code and approved
  ticket. The reviewer supplies the judgment and explanation, not the set.
- AC-004: Missing evidence and contradictory reviewer judgments are reported
  together with reviewer, section, and line information.
- AC-005: Hyphen, en dash, and em dash input produce the same canonical output
  and never consume a review retry by themselves.
- AC-006: `/sdlc-implement` and `/sdlc-chore` use template, fill, finalize, and
  validate. Neither skill asks the model to assemble the final aggregate.
- AC-007: A fixture reproducing a copied-count mismatch, a stale summary, and a
  wrong aggregate verdict completes without human escalation.
- AC-008: Existing valid review artifacts parse unchanged, and no reviewer,
  changed-file inventory, acceptance criterion, or required evidence surface is
  removed.

Out of scope: reducing the reviewer set, dropping complete change inventory,
removing relevant plan-step text, or changing review convergence policy.

## UX-03: Report artifact errors while the artifact is being written

User result: a person never reaches approval only to learn that the ticket,
plan, or critique has a mechanical formatting error.

Scope:

- Add `sdlc artifact --validate <path> [--json]` for ticket, plan including its
  critique, research synthesis, and discovery result shapes already parsed by
  `lib/artifacts.mjs`.
- Detect the artifact type from its existing shape and report all errors with a
  field or line. Do not require the rest of the pipeline to exist.
- Make `/sdlc-ticket` validate before reporting a draft ready for review.
- Make `/sdlc-plan` validate the plan and critique before setting
  `Status: review`.
- Apply one tolerant input rule for verdict dash variants and write one
  canonical form.
- Add template generation only for a shape whose authoring fixtures still fail
  after write-time validation. Do not add a public template merely to complete a
  matrix.

Acceptance criteria:

- AC-001: Each shape can be structurally validated without Beads, Git history,
  or live pipeline state. Plan and discovery semantic checks load only their
  referenced ticket or plan when those cross-artifact checks apply.
- AC-002: One invocation reports all independently actionable errors, including
  duplicate IDs, unknown coverage, invalid dependencies, malformed critique
  verdicts, and missing verification coverage.
- AC-003: Every error names a line or stable field and a correction a writer can
  apply without running doctor.
- AC-004: `/sdlc-ticket` cannot report success with an invalid draft, and
  `/sdlc-plan` cannot reach review status with an invalid plan or critique.
- AC-005: The known plan-critique dash variants validate identically.
- AC-006: Doctor uses the same parser result, so write-time and approval-time
  validation cannot disagree on the same bytes.
- AC-007: Existing valid artifacts remain valid without rewriting.

Out of scope: changing ticket or plan content requirements, auto-writing
research conclusions, or removing human review.

## UX-04: Give every stop one safe, executable next action

User result: `/sdlc-queue`, a guard refusal, and a stopped lane never require the
person to invent a `bd` command, actor value, issue ID, or mutation order.

Scope:

- Define one action object used by snapshot, guard, resume, and user-facing
  skills. It includes a stable code, complete command, human-decision flag,
  reason requirement, and the state fingerprint on which the action was based.
- Add task-level commands for the current recovery inventory. At minimum:
  `sdlc ticket approve <NNN>`, `sdlc gate resolve <NNN> <gate-id> --reason`,
  `sdlc escalation resolve <NNN> <issue-id> --reason`,
  `sdlc resume <NNN>`, and `sdlc merge-slot init`.
- Render mutating actions with `--if-state <fingerprint>`. A command that needs
  a human reason may prompt on an attached terminal; non-interactive callers
  must provide `--reason`.
- Add a read-only `sdlc recover <NNN>` action for an orphan or ambiguous case.
  It gathers the relevant commit, issue, gate, and ownership evidence. It emits
  a mutation command only when the safe operation is determined.
- Resolve and mint the session actor inside each task-level mutation after the
  human invokes it. Verify that the object belongs to the stated line of work.
- Refuse a stale action when its fingerprint no longer matches. Return the new
  safe action rather than applying an old mutation.
- Reuse the existing Beads adapter behind these commands where it fits. Do not
  expose a general `sdlc bd` passthrough.

Acceptance criteria:

- AC-001: Every non-empty `Needs you now`, `Drafts`, guard refusal, and stopped
  lane item carries exactly one complete command or a terminal explanation that
  no safe mutation exists.
- AC-002: No supplied action contains raw `bd`, `BEADS_ACTOR`,
  `<new-session-actor>`, an unspecified issue ID, or an instruction to edit
  frontmatter by hand.
- AC-003: `sdlc ticket approve` changes only the selected draft ticket status,
  validates the result, and is idempotent on replay.
- AC-004: Gate and escalation resolution require a non-empty human reason,
  verify line ownership, append one audit record, and do not affect another
  ticket.
- AC-005: Resume and merge-slot actions preserve their current safety
  preconditions and report all blockers at once.
- AC-006: A command generated before a competing state change refuses without a
  mutation and returns a refreshed action.
- AC-007: Replaying any completed action produces no duplicate gate resolution,
  note, claim adoption, configuration primitive, or status edit.
- AC-008: `/sdlc-queue` renders the command byte-for-byte from the action object
  rather than recreating it from a reason code.
- AC-009: Integration fixtures cover draft approval, clean claim adoption,
  unresolved consent, reviewer escalation, merge-slot initialization, orphan
  inspection, stale actions, and foreign ownership.

Out of scope: automatic consent, automatic orphan closure without proof,
general Beads access, and destructive cancellation.

## UX-05: Make status responsive and use the full suite at boundaries

User result: queue and guard checks return promptly, implementation steps get
fast feedback, and review and landing still require the complete configured
suite.

Scope:

- Record five-run warm baselines for `snapshot --view=queue`, an accepted
  `guard implement`, and `/sdlc-next` selection on the same real project used
  for the Tranche 1 measurements.
- Share one collected diagnosis within a command invocation. Recollect after a
  mutation or expired state fingerprint, not because a formatter needs another
  projection of the same facts.
- Optimize remaining Beads and Git process work only from the measured trace.
  Immutable capability caching and independent read parallelism are allowed;
  live issue, gate, claim, and Git state may not be served from an old snapshot.
- Extend the UX-01 JSON shape with an optional `fast` gate profile for global
  and target gates. The existing `full` profile remains authoritative; when no
  fast profile is declared, step execution also uses `full`.
- Add `sdlc gates --profile fast|full`.
- Run `fast` after an implementation step. Run `full` before review and after a
  landing rebase. Review and land refuse a summary from the wrong profile.
- Bind a gate summary to profile, code tree, command list, target, and config
  digest.
- Within one top-level continuation invocation, reuse a passing summary only
  when all bindings match and the tree is clean. Never reuse a failure, a result
  from before a rebase, or a result from another profile.
- Give this repository a real fast test script that excludes native Beads and
  end-to-end fixtures but leaves `npm test` complete.

Acceptance criteria:

- AC-001: On the same host and project, the median warm accepted implement guard
  is at or below 4 seconds across five runs. Queue snapshot and next-selection
  medians each improve by at least 35 percent from the recorded ticket baseline.
- AC-002: A trace attributes the before and after wall time and process count to
  concrete calls. No acceptance claim is based on a failing `npx` lookup or a
  fixture that bypasses native Beads.
- AC-003: A state mutation, expired fingerprint, or changed Git HEAD forces a
  fresh diagnosis before another action is selected.
- AC-004: Existing configuration has unchanged safety: every current gate still
  runs at each point where it runs today until a fast profile is explicitly
  configured.
- AC-005: A configured implementation step runs only the ordered fast global and
  target gates.
- AC-006: Review and land require a passing full summary bound to their current
  code state, target, commands, and configuration.
- AC-007: Changing code, gate configuration, target, command text, or profile
  invalidates reuse. A dirty tree is never eligible.
- AC-008: A duplicate pre-review request in the same continuation invocation
  reuses the exact matching pass and reports that fact.
- AC-009: `npm test` still runs every test. On the same host used for the
  baseline, the repository fast suite has a median wall time at or below 25
  seconds across three clean runs.
- AC-010: Gate output states profile, executed count, reused count, duration,
  code identity, and log location without printing unbounded logs.
- AC-011: Step, review, land, target-profile, expired-snapshot, and
  post-mutation recollection behavior have fixture-level
  integration tests.

Out of scope: silently classifying user commands as fast, cross-session gate
caching, skipping full pre-land confidence, and removing slow tests.

## UX-06: Make `/sdlc-chore` a reliable one-pass path

User result: a bounded change completes from one `/sdlc-chore` invocation, or
stops once with the exact human action needed to continue.

Scope:

- Add a deterministic `chore` guard and a state-aware chore snapshot. The skill
  no longer reproduces doctor checks from prose.
- Let the runner select isolation. Use a branch in the primary checkout when it
  is clean and available; use a worktree when isolation is required or
  requested. The user does not need to choose for the normal case.
- Support an optional machine-local worktree bootstrap command. Run it before
  editing when a new worktree needs dependencies or generated state, with the
  same bounded logs as a gate.
- Create or resume the existing chore by ticket and Beads identity. A rerun with
  the reported number cannot create a duplicate ticket, issue, branch, or
  worktree.
- Use UX-04 actions for claims, gates, escalations, merge-slot setup, and
  recovery.
- Use the fast profile while editing and the full profile before review and
  after any rebase.
- Use UX-02 review finalization. Keep evidence and review, and allow merging only
  from the explicit human `/sdlc-chore` invocation. Remove aggregate-format
  construction from the skill.
- Keep the existing chore scope policy for this ticket. A request that is
  clearly outside it refuses before mutation and supplies the planned-work
  command.

Acceptance criteria:

- AC-001: From a clean checkout, an in-scope chore with passing gates and review
  reaches merged state from one top-level `/sdlc-chore` invocation.
- AC-002: A dirty or occupied primary checkout selects a safe worktree without
  asking the user to diagnose isolation.
- AC-003: A selected worktree runs its configured bootstrap before editing.
  Bootstrap failure preserves the worktree and returns its bounded log and rerun
  action.
- AC-004: Interruptions after ticket creation, issue claim, branch or worktree
  creation, code commit, review, merge, Git push, and Beads push are each
  resumable without duplicate state.
- AC-005: Every human stop contains one UX-04 action. No chore recovery output
  contains a raw Beads command or actor placeholder.
- AC-006: A gate failure preserves the work and returns the log plus the exact
  rerun command.
- AC-007: A review-format or mechanically derived-field error never becomes a
  human escalation.
- AC-008: Out-of-scope input refuses before issue, branch, or worktree creation
  and points to the planned lane with the original request preserved.
- AC-009: The skill contains lane policy and judgment only. Chore state checks,
  mutations, artifact finalization, and recovery are invoked through the public
  CLI surfaces from earlier tickets.
- AC-010: End-to-end fixtures cover a clean branch run, automatic worktree
  selection, crash resume, foreign claim, gate failure, reviewer escalation,
  review fix round, and post-merge recovery.

Out of scope: representing a chore as a zero-step plan, adding a third "trivial"
lane, weakening full review, or automatically widening chore scope.

## UX-07: Make plan approval and amendment one resumable transaction

User result: `/sdlc-approve` either completes or can be rerun. A person never
repairs a partial Git and Beads approval by hand.

Scope:

- Move deterministic approval work from the skill procedure into two CLI
  phases: `sdlc approval manifest <NNN> [--json]` and
  `sdlc approval apply <NNN> --manifest <digest>`.
- The manifest covers canonical artifact hashes, allowed Git paths, epic and
  child create/update/close operations, dependency changes, waivers, approval
  notes, commit intent, and push intent.
- Bind the manifest to current Git, artifact, and Beads fingerprints.
- The explicit human invocation reviews the concise manifest and applies it.
  The model still handles plan judgment, critique dispositions, and waiver
  content before this point.
- Persist enough phase state under the Git common directory to resume after any
  Git, Beads, or push boundary without treating the two stores as atomic.
- Use UX-04 task-level mutations and actions. Do not expose transaction ordering
  to the user.

Acceptance criteria:

- AC-001: First approval and amendment each produce a deterministic manifest
  whose operations are stable on a second read of unchanged state.
- AC-002: Apply refuses when any bound artifact, Git, or Beads fingerprint
  changed after the manifest was produced and returns the command to regenerate
  it.
- AC-003: The approval commit contains only the canonical allowlist and does not
  consume unrelated staged or dirty changes.
- AC-004: Interrupting immediately after each mutation, commit, approval note,
  Git push, and Beads push can be recovered by rerunning `/sdlc-approve`.
- AC-005: Replay creates no duplicate issue, dependency, commit, approval note,
  waiver note, or push-side effect.
- AC-006: Amendments preserve stable step numbers and closed work, and show
  additions, removals, changed instructions, and dependency changes before
  apply.
- AC-007: Unresolved critique blockers, open questions, uncovered ACs, or
  unrecorded waivers prevent manifest apply. The command never invents the
  human decision.
- AC-008: A successful run ends with a healthy approval guard and reports plan
  identity, commit, Beads mapping, and independent push states.
- AC-009: The user-facing skill contains the human gate and concise result, not
  raw `bd` or Git transaction instructions.

Out of scope: automatic approval, automatic waiver creation, cross-store
atomicity, and plan-content generation.

## UX-08: Continue until the next human boundary

User result: one `/sdlc-next` invocation advances safe mechanical work until a
person must decide something.

Scope:

- Add `/sdlc-next <NNN> --until=human`, retaining the current one-transition
  behavior behind `--once` for compatibility.
- After each successful transition, collect a fresh snapshot and continue only
  when the selected action is mechanical and bound to the new state.
- Chain planning, implementation steps, gate runs, and review. Stop at draft
  ticket approval, plan approval, execution-time consent, unresolved
  escalation, land, cancel, or unsafe ownership.
- Permit claim adoption only when an explicit numbered invocation includes
  `--adopt`. It may call `sdlc resume` for clean, pushed prior work. Background,
  unscoped, and ordinary numbered runs may not adopt a foreign claim.
- Print compact progress during the run and one UX-04 action when it stops.
- Let ticket and plan approval report
  `/sdlc-next <NNN> --until=human` as their normal follow-up. They may offer a
  human-invoked `--continue` convenience that performs the same operation.

Acceptance criteria:

- AC-001: An approved plan with no human blocker reaches reviewed,
  ready-to-land state from one top-level continuation invocation.
- AC-002: A planning candidate reaches plan-review state and stops for approval
  without starting implementation.
- AC-003: A crash followed by
  `/sdlc-next <NNN> --until=human --adopt` adopts only clean, pushed work and
  resumes without manual claim changes.
- AC-004: A run without `--adopt` refuses to adopt a foreign actor, even when
  the tree is clean.
- AC-005: Ticket approval, plan approval, gate resolution, escalation
  resolution, landing, cancellation, destructive cleanup, and ambiguous orphan
  recovery are never crossed automatically.
- AC-006: Each loop iteration uses a fresh snapshot. A changed head or state
  fingerprint causes re-selection rather than execution of a stale action.
- AC-007: A refusal does not fall through to another ticket. It reports the
  selected line, completed transitions, blocker, and exact next command.
- AC-008: `--once` preserves the current one-transition contract.
- AC-009: End-to-end fixtures cover plan creation, full implementation and
  review, safe resume, a dedicated human gate, reviewer escalation, approval
  stop, land stop, stale snapshot, and competing ownership.

Out of scope: a background daemon, automatic human decisions, automatic land,
and running a different ticket after the selected one stops.

## Work that should not become simplification tickets

The following changes can be made inside the tickets above when they reduce
risk or make the implementation easier to maintain. They are not user outcomes
and should not occupy backlog slots on their own:

- one global resolver or state enum;
- warning-code table deduplication;
- moving Beads field accessors between modules;
- reviewer-profile source deduplication;
- deleting package exports or `lib/index.mjs`;
- deleting prose to meet a line-count target;
- replacing chore with a zero-step plan;
- a generic `sdlc bd` proxy;
- a compact one-line configuration grammar;
- removing plan-step text or the complete changed-file inventory from review
  packets;
- generating templates for every parsed artifact before a real authoring
  failure is observed.

Documentation changes belong to the ticket that changes the user journey. The
test is whether a user can complete that journey from the README alone, not how
many descriptions of the internals remain.

## Release proof

The backlog is complete only when a fixture repository demonstrates all of the
following without test-only state edits:

1. Install 0.5.1-style configuration, migrate it, refresh with `--force`, and
   retain every setting.
2. Create and approve a ticket without editing frontmatter.
3. Produce a plan whose structural errors are caught before human approval.
4. Approve the plan, interrupt the transaction at every phase, and resume it.
5. Continue the approved plan through fast step gates, full boundary gates, and
   finalized review evidence in one invocation.
6. Resolve a dedicated human gate from the exact queue action, then continue.
7. Stop at ready-to-land state without merging.
8. Complete an in-scope chore in one invocation and resume the same chore after
   an injected crash.
9. Show that every refusal either supplies one executable high-level command or
   explains why no safe mutation exists.

That sequence measures simplification where the user feels it. Internal code may
grow to support it. The proposal succeeds when the workflow asks less of the
person while preserving the existing approval and review guarantees.
