# Design — Workflow simplification

Date: 2026-07-25
Supersedes: the 24-item recommended order in `thoughts/research/001-workflow-friction.md`
Status: design — no ticket, no plan

## Premise

Three constraints, given:

1. The pipeline exists to make research → plan → implement good.
2. Some modes must be runnable in an agentic loop.
3. A hard dependency on Beads is acceptable.

Constraint 3 removes the largest item in the research doc (R1.2, git-only mode)
and most of the argument for R6.1. What remains is not an adoption problem. It is
that **resuming your own work costs a manual repair every time.**

## What the dogfooding shows

Measured on `~/development/ftr`, run entirely by hand — no loop has ever run.

Plan 002 is finished and permanently stuck:

| Fact | Value |
|---|---|
| Steps closed | 7 / 7 |
| ACs covered | 7 / 7 |
| Worktree | clean, 0 unpushed |
| `guard implement 002` / `guard review 002` | `REFUSED state=blocked` |
| Claim recoveries in epic notes | **6** |
| `approval:` records (2 amendments) | 3 |
| Review artifacts ever persisted | **0** |

The two blockers are the epic's own `in_progress` claim, flagged stale, and a
`human` label. Guard printed only the first — clear it and you hit a second wall
you were never told about.

Commit cadence: steps 1–3 on Jul 18, steps 4–7 on Jul 21. Two sessions, three
days apart.

## Root cause

**The pipeline models a session as a transaction. It is used as a bookmark.**

Every invocation mints a new actor; Beads claims are leases held by that actor.
So every resumption — working manually, that is every session — presents as a
foreign or stale claim and requires `bd update` surgery. The epic makes it
permanent, because it is `in_progress` by design for the plan's whole life and
therefore always eventually "stale."

The clearest form of the bug is `lib/doctor.mjs:812-816`, which reads *clean tree
+ old commit* as evidence of abandonment. Those same facts are equally evidence
that **resuming is safe** — clean and pushed means there is nothing to lose. Same
inputs, opposite conclusion.

Everything else follows: 6 recoveries, the permanent block, and the "it randomly
stops" report. It does not stop randomly. It stops every time you come back.

## Latency, corrected

One `guard implement` on `ftr` = 11.7 s = **31 `bd` + 94 `git`** spawns.

The git calls are spawned **by `bd` itself** (~3 per invocation), so sdlc cannot
memoize them. The only lever is fewer `bd` calls, and 20 of 31 are removable:

| Waste | Count | Why it is safe to remove |
|---|---|---|
| `--help` capability probes (`lib/beads.mjs:105-130`) | 12 | capabilities cannot change mid-session |
| per-child `show --long` (`lib/doctor.mjs:693,705`) | 8 | `list --parent --all --json` returns **identical keys** and is already fetched |

31 → 11 `bd` calls. The research doc's R2.1 was half the story; the N+1 is the
larger half.

---

## Tranche 1 — working-tree resolver, staleness, mechanicals

One piece of work. These touch the same lines; splitting them means writing
`doctor.mjs:812` twice.

### T1.1 `resolveWorkingTree(plan) → { mode, path, git }`

Single resolution point for where a plan's code lives.

- `mode` is **detected, not declared**: `worktree` iff `.worktrees/<plan-name>`
  exists and is Beads-visible; otherwise `branch`.
- `path` is that worktree, or the primary checkout.
- `git` carries `branch, head, dirty, unpushed, stashes, upstream, lastCommitAt`.

Downstream invariants operate on the resolved tree and stop caring which it is.
This collapses the 42 scattered `worktree` references in `doctor.mjs` (286 across
the repo) into one helper, and makes `snapshotMatchesApprovedPlan`
(`doctor.mjs:765-775`) worktree-only — it is meaningless when there is no second
copy of `thoughts/`.

Detection beats declaration because it cannot drift: there is no third state
where config and disk disagree.

### T1.2 `Isolation:` declares intent, never authority

- New optional plan frontmatter field: `Isolation: branch | worktree`.
- **Absent or unset ⇒ `branch`. Always.** Every existing plan keeps working and
  silently gets the cheaper mode.
- `/sdlc-implement {NNN} --worktree` overrides at runtime with **no amendment**.
  Escalating `branch → worktree` is strictly more isolated, so there is no safety
  argument for gating it behind re-approval.
- doctor never reads the field. It only tells `/sdlc-implement` what to create.

Rejected: `Isolation: main`. A branch costs a `checkout -b` and a squash merge —
that is not what makes light work heavy. The weight is the Bead, the review
packet, the aggregate artifact and the memory audit, none of which isolation
touches. `main` would also delete the land gate, turning review-then-merge into
merge-then-review. Lightening trivial work is a lane fix in `/sdlc-chore`, not an
isolation mode.

Rejected: hash-binding the field as authoritative. Changing your mind would trip
`reapproval_required` — the ceremony that charged `ftr`'s `cdaa0df` a full
amendment for two changed lines.

### T1.3 Canonical text at the approval commit

In `branch` mode the primary checkout sits on the plan branch, so on-disk
`thoughts/` is the branch copy.

**Mostly already built**: `commitFile(root, commit, path)` at `lib/doctor.mjs:131`
already reads canonical ticket and plan text from the approval commit. Remaining
work is to confirm every canonical read routes through it rather than the
filesystem, and to add `sdlc hash <path> --rev <commit>` so implementer and
reviewer subagents can verify identically.

This is strictly more correct than today: it reads the *approved* commit rather
than whatever `main` has since drifted to.

### T1.4 Staleness becomes resumable

At `lib/doctor.mjs:812-816`:

- Exclude the **epic** from the staleness intersection. The epic is plan state,
  not worker state; its liveness is tracked by approval plus child status.
- Drop the `!worktree` disjunct, which corroborates instantly with no threshold.
  A missing tree is its own condition, not laundered staleness.
- A claim held by the **current session actor** is never stale.
- Staleness never becomes a hard error while the resolved tree is clean and
  pushed. Warning only.

### T1.5 `sdlc resume {NNN}`

The verb that replaces six hand-run recoveries.

- **Preconditions**: resolved tree clean, nothing unpushed, no merge slot held by
  another holder.
- **Action**: adopt the epic under a fresh actor, reset orphaned step claims to
  `open`, append one `resume:` note for audit.
- **Refuses, with reasons**, when the tree is dirty or unpushed — that is the
  genuine conflict case, and the only one the lease model was ever protecting.

### T1.6 Print every blocking error

`refusal()` at `lib/guard.mjs:61-70` builds a one-element array and every caller
passes `diagnosis.errors[0]`. Carry the full list. `formatGuard`
(`guard.mjs:280-282`) already loops, so only the producer changes.

Without this, each resumption costs a round trip per hidden blocker — which is
exactly what `ftr` 002 does today.

### T1.7 Latency

- Memoize `inspectBeadsInstallation` (`lib/beads.mjs:105-130`), keyed on
  `bd --version` plus binary mtime.
- Remove the per-child `showIssue` N+1 (`lib/doctor.mjs:693,705`); reuse the
  `list --parent --all --json` result already fetched.

### Acceptance

`ftr` plan 002 reaches `mode=review` with **no hand-run `bd` mutations**, and
`guard implement` drops from 11.7 s to under ~4 s.

---

## Tranche 2 — finish the lane

**Spec: `thoughts/design/tranche-2-spec.md`**

Review has never completed once; that is a hole in goal 1.

- `sdlc review-artifact --template {NNN} --round {n}` and `--validate <path>`.
  `lib/review-artifact.mjs` already validates this format — it should emit it.
  ~17 of ~19 structured formats in the skills duplicate a validator in `lib/`.
- Accept `[-–—]` in the verdict grammar, normalize on write. `review-artifact.mjs:1`
  requires literal U+2014 while `:216` already accepts both; the strictness is
  inconsistent, not principled, and failing it can halt the pipeline.
- Split `sdlc-implement/SKILL.md`: lines 110–231 (53%) are review contract,
  irrelevant until `mode=review`.
- **Then** reconsider whether `implement` still needs full `healthy`
  (61 `errors.push` sites, `guard.mjs:169-170`). T1.4 and T1.6 may have already
  removed the pain — measure before projecting invariants.

## Tranche 3 — stop hand-driving the mechanical parts

**Spec: `thoughts/design/tranche-3-spec.md`**

- `sdlc ticket approve {NNN}`. The **first** human gate is a manual file edit,
  and `lib/snapshot.mjs:140` already emits the exact mutation it wants.
- `sdlc amend {NNN}`: mechanize hash update, Beads child reconciliation, approval
  record and gate commit. The human decision is "this amendment is right";
  everything downstream is deterministic.

## Tranche 4 — actually deliver goal 2

**No spec yet, deliberately.**

`/sdlc-next` covers 2 of 5 transitions and stops even on its own success
(`SKILL.md:8-10`). It is a one-shot dispatcher named like a loop. A real loop
chains implement → review and stops at the human gates. Tranche 1 is a hard
prerequisite: a loop that cannot resume is worse than no loop.

It is not specced because its entire contract is defined by surface Tranche 1
creates and Tranche 2 measures: the semantics of `sdlc resume`, whether a loop may
invoke it unattended, and whether `implement` still requires full `healthy`
(T2.4). Writing it now would mean specifying against an invented interface.

Two questions to answer with Tranche 1 in hand, before speccing:

1. **May an unattended loop call `sdlc resume`?** It adopts claims. Under manual
   use the human is the evidence that the prior session is dead; a loop has no
   such witness. This is the central safety question and it has no answer yet.
2. **Where does the loop stop?** Certainly at approve and land. Whether it stops
   at a `human` escalation label or attempts to continue past it determines
   whether the loop can strand work the way `ftr` 002 is stranded today.

## Deferred, with reasons

| Item | Why not now |
|---|---|
| Reviewer calibration (research R4.1–R4.5) | **Zero reviews have completed.** Tuning strictness before observing one real review is speculation. Fix reachability, run three, then calibrate on evidence. |
| `.agents/sdlc.json` role→tier→model (R5.1) | Real, but cost control, not friction. |
| Trivial lane (R1.1) | Only meaningful once the main lane is smooth. |
| Prose reduction (R3, R7) | 105 "never"s and 5 duplicated invariant blocks; ongoing cleanup, not a blocker. |
| Beads-optional (R1.2) | Out of scope per constraint 3. |

## Immediate unblock for `ftr` 002

Until T1.4 lands, plan 002 needs the `human` label removed and the epic claim
adopted under a fresh actor. That is the seventh manual recovery on this plan,
and the reason Tranche 1 leads.
