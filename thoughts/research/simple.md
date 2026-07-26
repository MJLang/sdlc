# Simplification review of the sdlc workflow

Date: 2026-07-25
Scope: the whole pipeline — `skills/`, `lib/`, `bin/sdlc.mjs`, `template/`, `docs/`.
Method: full read of every skill and the CLI, two deep structural passes over
`lib/`, plus mechanical measurement of the command surface, duplication, and
validation coverage. `thoughts/` deliberately not read. Every claim below cites
`file:line`; the load-bearing ones were re-verified directly.

Baseline: 178 tests pass in 180s.

## Summary

The two-layer split — skills own judgment, the CLI owns deterministic facts — is
right, and the hard parts (hash chain, reproducible approval, actor isolation,
cross-store recovery ordering) are genuinely well built. The complexity is not in
either layer. It is in the seam, and it takes three recurring shapes:

**A. The CLI asks the model for values it already computes, then rejects the
model's copy if it disagrees.** The aggregate review artifact has ~60 distinct
structural failure modes, but the aggregate verdict, the per-reviewer summary
bullets, every MUST FIX count, round-1 `Fix-Disposition`, the `Scope-Check` path
list and the `AC-Coverage` ID set are all derivable — and `doctor.mjs:418-431`
independently recomputes two of them purely to error if the model wrote
something else. That is a validation contract, not an evidence contract.

**B. The same derived fact is computed independently in two to six places, with
predicates that have already drifted.** Six different code paths resolve `NNN` to
its artifacts, and they disagree on real inputs. `warningCode` is byte-identical
in two files. Three different regexes test "is this review approved," none of
them the canonical grammar.

**C. Contracts asserted as prose in N skills instead of enforced once.** The
`BEADS_ACTOR` ceremony appears in five skills — while a fully-built, allowlisted,
actor-enforcing mutation adapter sits in `lib/beads.mjs` with **zero production
callers**.

Findings are ordered by leverage. 1–4 are where the real wins are.

## Measured surface

| Thing | Count |
|---|---|
| Slash commands / CLI subcommands / documented flags | 10 / 11 / 26 |
| Project Configuration keys | 12 |
| Skill prose | 1,118 lines |
| Library code | 4,523 lines |
| Prose describing the system (README + under-the-hood + contract) | 1,176 lines |
| Distinct state vocabularies in `lib/` | 17 |
| Distinct stable-ID namespaces a model must maintain | 10 |
| Distinct verdict grammars | 3 (two parsers, incompatible dash rules) |
| `fail()` sites in `parseReviewArtifact` | 62 |
| Rules in `review.md` + machine rules + doctor cross-checks | ~44 + 60 + ~11 |
| Distinct `NNN` → artifact resolution paths | 6 |

Documentation is ~1:1 with the thing it documents. Concepts, not code, are the
cost centre.

---

## 1. Ship the Beads adapter that already exists

**Highest leverage change in the repo. It is deletion, not construction.**

`lib/beads.mjs` contains a complete mutating adapter: a 14-verb allowlist
(`beads.mjs:36-51`), enforcement that refuses to run without a valid session
actor (`assertMutatingBeadsCommand:384`, applied `:470`), and ten named methods —
`updateSpecIdentity`, `createHumanGate`, `resolveGate`, `createWorktree`,
`removeWorktree`, `addDependencies`, `createMergeSlot`, `acquireMergeSlot`,
`releaseMergeSlot`, `runBatch`.

Verified: **all ten have zero call sites in `lib/` and `bin/`.** Six of the ten
have no test either. Every real mutation in the pipeline is instead shelled out
of skill markdown — `sdlc-approve:63,71,77,91`, `sdlc-implement:31,47`,
`sdlc-chore:44,47,50,54,131,140`, `sdlc-land:54,57,135`, `review.md:71`.

So there are two Beads clients: a JS adapter that is read-only in practice, and a
prose layer that does all the writing. The allowlists document a surface the code
does not exercise. And because the prose layer bypasses the adapter, the actor
invariant is enforced by asking a model to remember shell quoting across a long
procedure — this paragraph appears in five skills verbatim:

> Capture the literal and carry it unchanged through this invocation. Per the
> contract actor invariant, prefix every mutation with
> `BEADS_ACTOR="<session-actor>"`; never rely on shell export or an older actor.

**Proposal.** Expose the adapter as `sdlc bd <verb> [args…]`. It resolves the
session actor from the existing registry in `.git/sdlc/actors/`, injects
`BEADS_ACTOR`, and refuses a mutating verb without one.

**What this buys, all at once:**
- Deletes five copies of the actor paragraph and ~20 inline `BEADS_ACTOR="…"`
  prefixes from the skills.
- Converts "the model must remember the prefix on every command" from a hope
  into a mechanism.
- Makes the mutation allowlist mandatory rather than decorative.
- Turns ~150 lines of dead-but-tested code into the actual write path.

This is the rare change that simultaneously removes prose, removes dead code, and
closes a correctness gap.

## 2. Stop asking the model for values the CLI computes

The review artifact is the clearest case. Per round, with N reviewers, the model
must produce 2N + 3 + N + 1 items. Classified by whether the CLI already knows
the answer:

| Item | Derivable? | Enforcement |
|---|---|---|
| Component report prose | **Evidence** | `parseComponents:221-244` |
| `### Clean-Pass Evidence` (5 surfaces) | **Evidence** | `cleanPassSurfaces:207-219` |
| `[fixed]` vs `[persists]` on prior IDs | **Evidence** | `requiresDispositionTag:251` |
| PASS/FAIL judgement in Scope-Check / AC-Coverage | **Evidence** | `:153-162` |
| Component `Verdict:` **counts** | Derivable — must equal the component's own finding IDs | `:411-417`, `:429-434` |
| `Fix-Disposition` in round 1 | Fully derivable (`N/A`) | `:132`, `:146` |
| `[new]` bucket | Fully derivable (current ∖ prior) | `:435-440` |
| `Scope-Check` unplanned path list | **Fully derivable** | `doctor.mjs:426-431` recomputes `changed ∖ declared` and errors on mismatch |
| `AC-Coverage` verified ∪ missing set | **Fully derivable** | `doctor.mjs:418-421` requires equality with live-unwaived ACs |
| `- <reviewer>: <verdict>` bullets | **100% derivable — pure copy** | `:391-401` errors unless verbatim-equal to the component verdict |
| Final aggregate `Verdict:` | **100% derivable** | `aggregateVerdict():39-47` computes it; `:389` rejects anything else |
| Epic note `review: APPROVED sha=… code-sha=… …` | **All 5 fields derivable** | `doctor.mjs:448-455` errors on any disagreement |

Roughly half the model-authored surface is transcription that the CLI verifies
against its own answer. That is where most of the 62 `fail()` sites live, and
every one of them is a round-trip.

**Proposal.** `--template` already fills the identity header. Extend it to fill
everything derivable and have the model supply only evidence:

- Emit `Scope-Check` and `AC-Coverage` with the *sets* pre-filled, leaving the
  model to write PASS/FAIL and justify a FAIL.
- Emit `Fix-Disposition: N/A` directly in round 1.
- Compute the summary bullets and the aggregate `Verdict:` **from the pasted
  component reports** at validate time rather than asking for them.

The rule to apply generally: *if `--validate` can prove a value wrong, the
template should have written it.*

## 3. Extend generate → fill → validate to the other four artifacts

`lib/` mechanically validates six artifact grammars. Only one has tooling:

| Artifact | Parser | `--template` | `--validate` |
|---|---|---|---|
| Review aggregate | `review-artifact.mjs` | ✅ | ✅ |
| Ticket | `artifacts.mjs:69` | ❌ | ❌ |
| Plan | `artifacts.mjs:277` | ❌ | ❌ |
| Plan Critique | `artifacts.mjs:209` | ❌ | ❌ |
| Research synthesis | `artifacts.mjs:442` | ❌ | ❌ |
| Discovery result | `artifacts.mjs:410` | ❌ | ❌ |

For the five unsupported ones the only validation path is `sdlc doctor <NNN>`,
which needs the whole pipeline to exist. So `/sdlc-plan` hand-authors a plan
against ~40 lines of prose spec (`sdlc-plan/SKILL.md:91-137`), including a
critique block enforced by fourteen distinct error branches in `parseCritique` —
and a violation surfaces only when a human later runs `/sdlc-approve`.

**There is already a live bug in this gap.** The plan-critique verdict grammar at
`artifacts.mjs:219` is `/^BLOCKED[ \t]+-[ \t]+([1-9]\d*)[ \t]+MUST FIX$/` —
**ASCII hyphen only**. The review grammar at `review-artifact.mjs:17` accepts
hyphen, en dash, or em dash and normalizes to em dash, and the skills tell
reviewers that "the dash an agent cannot reliably control never halts a review"
(`README.md:266`). A model that internalizes that lesson and writes
`Pass 1 Verdict: BLOCKED — 1 MUST FIX` in a plan gets rejected. Two parsers, one
grammar, opposite tolerances.

**Proposal.** One command:

```bash
sdlc artifact --template ticket|plan|research|discovery|review --number NNN [...]
sdlc artifact --validate <path>
```

`--validate` dispatches on artifact shape, which the repo already treats as its
contract selector (`README.md:387`), and reports every failure with a line
number. Unify the two verdict grammars on `review-artifact.mjs:17` while you are
there.

Removes an estimated 150–200 lines of skeleton prose from `sdlc-ticket`,
`sdlc-plan` and `review.md`, and moves four classes of format failure from
approval-time to write-time.

## 4. Give `/sdlc-chore` a guard, or fold it into the main lane

`skills/sdlc-chore/SKILL.md` is 142 lines re-deriving `/sdlc-implement` +
`review.md` + `/sdlc-land` in paraphrase. Verbatim overlap is only ~3.5% shared
8-grams — which is the problem, not the mitigation. Two independently-worded
copies of one contract drift, and this pair already has:

- **No deterministic preflight.** `GUARD_STAGES` is
  `['plan','approve','implement','review','land']` (`guard.mjs:7`) — no `chore`.
  `doctor.mjs:498-499` explicitly *refuses* chore tickets. The one lane that
  merges to `main` without a plan is the one lane with no mechanical gate; its
  preflight is a prose paragraph telling the model to run `bd --readonly context
  --json` plus "the focused gate, dependency, worktree, stale, orphan, and claim
  checks" by hand (`sdlc-chore:34`).
- **Confirmed drift.** `review.md:79` says "Do not hand-author the format —
  generate, fill, validate." `sdlc-chore:99` still embeds a hand-written
  skeleton. The CLI has supported the chore lane in `--template` all along —
  `CHORE_LANE_SENTINEL` is handled at `review-artifact.mjs:506-511` and derived
  at `bin/sdlc.mjs:411-414`. The in-flight branch added `--validate` to chore but
  not `--template`.
- **The sentinel itself is split three ways:** the constant
  (`review-artifact.mjs:7`), `'N/A'` in the packet (`review-packet.mjs:264-265`),
  and the string re-hardcoded at `review-packet.mjs:407` instead of imported.

**Proposal, increasing ambition:**
- **(a)** Point chore at `sdlc review-artifact --template`. Trivial; fixes an
  active drift on an already-supported path.
- **(b)** Add `chore` to `GUARD_STAGES` and teach doctor the chore shape. Deletes
  chore's bespoke capability-check paragraph.
- **(c)** Model a chore as *a plan with zero steps*. The differences that matter
  are four parameters — no plan artifact, one Bead instead of an epic, two review
  rounds instead of three, invocation implies ticket approval — not a second
  pipeline. `sdlc-chore/SKILL.md` becomes ~40 lines of lane boundary and deltas.

---

## 5. One resolver for `NNN`, one warning table, one verdict test

Six independent code paths turn a ticket number into artifacts, and **they
disagree on real inputs**:

| Path | Plan applicability rule |
|---|---|
| `doctor.mjs:45-61` | excludes merged/cancelled, then falls back to merged when ticket is `implemented` |
| `resume.mjs:29-47` | excludes merged/cancelled, **no fallback**, additionally requires `beadsEpic` |
| `review-packet.mjs:29-35` | **status-agnostic**, throws on ambiguity |
| `snapshot.mjs:16-27` | filename enumeration only |
| `snapshot.mjs:172-187` | chore lane, keyed on branch prefix `NNN-c-` |
| `bin/sdlc.mjs:507` | **string-matches `'Expected at most one applicable plan'` in doctor's English error text** |

For an `implemented` ticket with one `merged` plan: doctor resolves it, resume
refuses it, review-packet resolves it. Plus 8 independent `padStart(3,'0')` sites.

Other confirmed multiples:

- **`warningCode` is byte-identical** in `guard.mjs:32-42` and
  `snapshot.mjs:62-72` — verified by diff. Nine regex→code mappings, twice.
- **Three "is the review approved" tests**: `/^APPROVED/` (`snapshot.mjs:103`),
  `/^APPROVED/` (`:144`), `/^APPROVED(?:\b|\s|—)/` (`guard.mjs:242`). The
  canonical grammar at `review-artifact.mjs:17` is used by none of them.
- **`gitResult`/`git` byte-identical** in `doctor.mjs:24-36` and
  `working-tree.mjs:5-17`; three primary-checkout resolvers, and
  `gates.mjs:17-20` tries them in a different order so it diverges on failure.
- **`healthValid` has two definitions**: native health severity
  (`doctor.mjs:880-887`) vs "any context error at all" (`snapshot.mjs:280`).
- **`snapshot.mjs:91,157` regex-match doctor's English error prose**
  (`/stale in-progress.*corroborated/i`) to recover a boolean doctor already
  computed at `doctor.mjs:824`.
- **Ready-children computed three times**: `guard.mjs:91-98`, inlined identically
  at `snapshot.mjs:81-86`, and a third variant at `doctor.mjs:806-807`.
- **Doctor's two internal passes use divergent predicates**: epic-blocking gates
  are counted in `errors` (`:803-804`) but omitted from `result.beads.openGates`
  (`:855`).

**Proposal.** Extract a `resolve.mjs` (number → ticket/plan/epic/worktree, one
applicability rule, one `padStart`) and a `codes.mjs` (the warning table, the
verdict test). Move the Beads field accessors `issueId`/`issueStatus`/
`gateBlockedId` out of `doctor.mjs:277-305` into `beads.mjs` where they belong —
they are why `snapshot`, `guard`, `resume` and `review-packet` all import doctor.

## 6. Seventeen state vocabularies with colliding tokens

`lib/` defines 17 distinct enums. The overlaps are the expensive part:

- **Seven identical strings appear in both guard refusal codes and snapshot
  rejection reasons** — `foreign-claim`, `orphan-recovery`, `human-escalation`,
  `reapproval-required`, `legacy`, `gated`, `no-ready-work` — computed by
  separate code and never cross-validated.
- **`worktree-dirty` means three different things**: a guard refusal
  (`guard.mjs:187`), a warning code (`guard.mjs:34`), and a resume error that
  actually means "tree could not be inspected" (`resume.mjs:70`).
- **`merge-slot-held`** is a warning, a human-queue code, and a hard error.
- **`unpushed-commits`** is a warning in snapshot, a hard error in resume.
- **Inverse-polarity pairs**: guard `review-not-approved` ↔ snapshot
  `review-approved`; guard `children-open` ↔ snapshot `implementation-complete`.
- **`review` appears in four vocabularies**: plan Status, guard stage, guard
  implement-mode, and guard review-mode.
- Near-synonyms for "stale": `stale-unconfirmed`, `stale-candidate`, and doctor's
  prose distinction between candidate and corroborated.

Also: **`GUARD_ACCEPTANCE_MATRIX` (`guard.mjs:9-30`) is never read by any code.**
It is a hand-maintained table asserted against in `test/guard.test.mjs`,
duplicating the logic in `evaluateGuard:145-257` with no mechanical link — so it
can drift from the behaviour it documents without failing anything.

**Proposal.** One shared code table; make `GUARD_ACCEPTANCE_MATRIX` the thing
`evaluateGuard` actually dispatches on, so the doc table and the logic cannot
diverge.

## 7. The review packet does expensive work and discards it

- **Every changed file's full blob is read from git and then thrown away.**
  `readChangedFile:74-84` runs `git show <head>:<path>` for every changed file
  with `maxBuffer: 64MB`, and a second `git show` on the base for deletions.
  Verified: **`record.contents` is never read by any consumer.** The text is
  materialized into a `Map` held for the whole call solely so two regexes in
  `textualReferences:63-72` can run over it. Stream the regexes; keep the
  references; drop the text.
- **The complete changed-file inventory is copied into every packet**
  (`:232-238`, rendered `:385`) — N reviewers × M files, plus an identical static
  explanatory note in each.
- **Cross-lane interface files duplicate diff hunks 2–3×.** The neighbour
  relation is symmetric and unweighted (`:101-105`), so a shared utility or
  barrel file pulls itself into essentially every lane.
- **`plan.steps[].text` carries every lane step's full body** (`:144`) into the
  JSON, and `formatReviewPacket:387` never prints it.
- **`priorFindings` (`:148-160`) is a fourth independent parse of the review
  artifact** — a raw line scan, not `parseReviewArtifact`. It matches `NIT-` as
  well as `MF-`, so non-blocking findings enter the inventory reviewers are told
  to classify, and it captures whole matched lines as "evidence", frequently
  grabbing a `Fix-Disposition:` control line rather than the finding text.
- The cost is already acknowledged in-tree: `reviewerNamesFor:166-169` exists
  specifically to avoid "the per-file blob reads, interface graph and lane diffs
  a full `createReviewPackets` pays for and would then discard."

## 8. Reviewer profiles paraphrase one contract three times

505 lines across four profiles. Measured line-level similarity (backend's 78
substantive lines): **50 have a ≥0.45 paraphrase twin in frontend; 32 have one in
both siblings.** Section-level Jaccard: Phase 0 "Resolve the work" b~f **0.92**;
Phase 1 "Verify prior findings" f~g **0.93**; Clean-Pass Evidence block b~g
**0.97**. Exact string matches are only 22 lines — the files say the same thing
in different words, which understates the duplication and maximizes drift risk.

Genuinely lane-specific: frontend ≈35–40 of 143 lines, backend ≈10 of 133,
general ≈20 of 140. Everything else — read-only constraint, `bd --readonly`
rule, canonical-inputs paragraph, hash verification, prior-finding
classification, packet-consumption phases, stable-ID allocation, Clean-Pass
template, verdict grammar, return-format sentence — is shared contract restated
four times (`bd --readonly` alone: `backend:23`, `frontend:23`, `general:31`,
`plan-reviewer:25`).

**Proposal.** Inject a shared preamble at render time. The renderers already
inject a per-runtime constraints block (`bin/sdlc.mjs:692`), so the mechanism
exists; each profile keeps only its lane checklist. Also collapse
`renderCodexAgent`/`renderPiAgent` (`bin/sdlc.mjs:678-746`) into one renderer
with a per-target frontmatter map — they differ by frontmatter shape and one
string replacement, ~60 lines of near-identical code.

## 9. Config: five keys expressing one idea

`Targets`, `Quality gates`, `Target gates`, `Target paths`, `Reviewers` are five
separately-parsed, separately-validated keys jointly answering one question, and
they force the reader to join three repeated-line grammars by target name:

```md
- **Targets:** `cms | jobs | web`
- **Target gates:** `web -> npm run test:web`
- **Target paths:** `web -> src/web/**`
- **Reviewers:** `web -> frontend-code-reviewer`
```

One block per target says the same thing in one grammar, and the "unknown
target" error class disappears because a target cannot be referenced before it is
declared:

```md
- **Target `web`:** paths `src/web/**`; gates `npm run test:web`; reviewer `frontend-code-reviewer`
```

Note also that glob matching is implemented **four** times: `pathMatchesScope`
(`doctor.mjs:364-383`), `declaredScopeOverlap` + `staticPrefix`
(`snapshot.mjs:29-41`, which re-strips backticks before delegating), and
`classifyTargetPath`/`globSpecificity` (`config.mjs:190-208`, which takes
`matchesGlob` as an injected parameter rather than importing the existing one).

## 10. Optional machinery with unconditional cost

- **Merge slots.** `off` by default, and the README tells you to leave it off
  (`README.md:88`). It still costs a paragraph in `sdlc-land`, another in
  `sdlc-chore`, a mention in `sdlc-queue`, branches in doctor and snapshot, four
  `bd merge-slot` invocations, and three adapter methods with zero callers. Move
  the protocol to an extension doc; leave one conditional line in the skill.
- **Two working-tree modes.** `Isolation: worktree` vs branch, both fully
  described (`sdlc-implement:38-53`) with a `--worktree` runtime override that
  bypasses re-approval. Reasonable, but it is the third-largest section of the
  implement skill.
- **`lib/index.mjs`** re-exports all 12 modules and **has no in-repo consumer** —
  every caller imports deep paths, which `package.json:24-38` enumerates
  separately. It is a published barrel duplicating the subpath map, with no guard
  against a name collision (`gitCommonDirectory` is already defined twice —
  exported from `gates.mjs:22`, private at `beads.mjs:293` — and would collide if
  the second were ever exported).

## 11. Two doc surfaces restating the skills

`README.md` (428) and `docs/under-the-hood.md` (636) both narrate the full
lifecycle; `template/thoughts/AGENTS.md` (112) narrates it a third time as the
contract. Under-the-hood's "lifecycle from ticket to merge" (413–515) restates
each skill's procedure in the skills' own order. It is well written, and it is
already stale: it opens with "the machinery behind sdlc 0.4" while the package is
0.5.1.

Let README own *what and why*, under-the-hood own *the mechanisms not visible in
the skills* (hash chain, actor registry, log storage, cross-store recovery
ordering), and delete the per-skill procedure narration. The skills are the spec.

---

## Not worth simplifying

- **The hash/approval chain.** Reproducible approval with no sidecar is the core
  value proposition, and it is implemented tightly.
- **The doctor/guard/snapshot split.** One collection
  (`createDoctorInspectionContext:534`), three projections. Correct factoring —
  though guard and snapshot should consume doctor's *result*, not its
  non-enumerable private `inspection` payload (`doctor.mjs:914-927`), which they
  currently reach into at 17 sites.
- **Session actors and worktree isolation.** The reasoning at
  `under-the-hood.md:179` is sound: ambient OS/Git identity does not prove
  ownership.
- **Human gates on ticket approval, `/sdlc-approve`, `/sdlc-land`.** The product
  is the gates.
- **Bounded gate logs with protected permissions.** Small, self-contained,
  correct.

## One operational note

`npm test` takes 180s and is the configured default quality gate, so it runs
after every step commit and again after every rebase during landing. On a
five-step plan that is 15+ minutes of gate time in the inner loop. Splitting a
fast default gate from a slower pre-land gate would do more for perceived
workflow speed than any prose reduction here.

## Suggested order

| # | Change | Effort | Removes |
|---|---|---|---|
| 1 | Point `/sdlc-chore` at `review-artifact --template` | trivial | an active drift |
| 2 | Unify the two verdict grammars on `review-artifact.mjs:17` | trivial | a latent rejection bug |
| 3 | Drop `record.contents` retention in the packet builder | trivial | full-blob reads of every changed file |
| 4 | `sdlc bd` over the existing adapter | small | 5 prose copies, ~150 dead lines, a failure class |
| 5 | Template fills every derivable review control | medium | ~half the artifact round-trips |
| 6 | `resolve.mjs` + `codes.mjs` | medium | 6 resolvers → 1; 2 warning tables → 1 |
| 7 | `sdlc artifact --template/--validate` for the other four | medium | 150–200 lines of prose; 4 failure classes move earlier |
| 8 | `chore` guard stage + doctor support | medium | chore's bespoke preflight |
| 9 | Shared reviewer preamble; one agent renderer | small | 4-way contract drift; ~60 lines |
| 10 | One-line-per-target config grammar | small | 4 grammars → 1 |
| 11 | Merge-slot protocol to an extension doc; cut lifecycle narration | small | ~25 skill lines; a third copy of the spec |

1–4 are independent and each land in well under a day. 5 and 7 are the largest
payoff and should not be rushed — 7 adds a new public CLI surface. 8 follows
naturally from 1.
