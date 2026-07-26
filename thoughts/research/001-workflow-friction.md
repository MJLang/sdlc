# Research 001 — Workflow friction: complexity, latency, verbosity

Date: 2026-07-25
Scope: `skills/`, `lib/`, `bin/sdlc.mjs`, `template/`
Status: research — no ticket, no plan

## Summary

The pipeline's guarantees are good and worth keeping: hash-bound approvals, human
gates, read-only enforcement, saved review evidence. The problem is that all of
them are applied **uniformly**, at **fixed cost**, and **re-proved from scratch**
on every call.

Three findings, in priority order:

1. **Ceremony is not risk-proportional.** A typo fix pays for a Bead, a worktree,
   a structured multi-reviewer aggregate artifact, a post-merge memory audit, and
   a native worktree teardown. There is no lane below that.
2. **Latency is dominated by re-derivation, not by work.** Every `guard`,
   `doctor`, and `snapshot` call spends ~1.2 s re-probing `bd --help` twelve times
   to re-learn capabilities that cannot change during a session. Measured on the
   live `ftr` project: **`/sdlc-queue` = 15 s per glance**, `guard implement` =
   **11 s**, and a 4-step implement burns **~79 s of pure preflight** before any
   code, test, or model time.
3. **The prose is defensive, and the defensive parts are already enforced in
   code.** 67 KB of skill text and 43 KB of reviewer profiles, containing 108
   instances of "never," much of it re-describing grammar that `lib/` already
   validates mechanically.
4. **Reviews are calibrated for one project stage: late.** The Clean-Pass
   Evidence rule makes *approving* more expensive and riskier than *blocking*,
   nothing in the config can tell a reviewer the stakes are low, and severity is
   assigned by category ("security") rather than by reachability. Early projects
   get more review pressure than mature ones.
5. **Subagent models are hardcoded and not editable.** Three hosts get three
   different answers (Claude `inherit`, Codex a literal `gpt-5.6`, Pi nothing),
   the highest-volume subagents have no profile at all, and `setup --force` —
   the documented upgrade path — silently reverts any model edit the user made.
6. **Worktrees are mandatory but justified only by concurrent in-flight plans** —
   a scenario every *other* primitive in the pipeline (merge slot, Beads server
   mode) treats as opt-in and off by default. Nothing bootstraps a fresh
   worktree, so on a Node project every plan's first gate run fails on a missing
   `node_modules`.

The 0.4 token-savings pass (`thoughts/design/token-savings.md`) fixed
*serialization* — always-loaded contracts dropped 70.8%. It did not reduce the
*number of gates per unit of work*, which is what the remaining friction is.

Section 7 checks all of this against Anthropic's Claude-5 context-engineering
guidance, which independently supports findings 1–3 and adds two concrete items.
Section 8 evaluates and declines Honcho and OpenViking as memory replacements.
Section 9 covers the measurement rig: all wall-clock numbers here come from
`~/development/ftr`, a real project running this pipeline.

**Section 10 diagnoses a defect, not a preference, and now leads the recommended
order:** `/sdlc-implement` stopping mid-plan is a 24-hour staleness timer that
turns any pause into a permanent block requiring manual claim surgery. `ftr` plan
002 is in that state as of this writing.

---

## 1. Ceremony is not risk-proportional

### Evidence

`/sdlc-chore` is the designated lightweight lane. Its skill is **10,680 bytes**,
the third largest in the repo, and for a one-line typo fix it still mandates:

| Step | Cite |
|---|---|
| Unique session actor before first mutation | `skills/sdlc-chore/SKILL.md:29` |
| `bd create` + atomic `bd update --claim` | `:52` |
| `bd worktree create` (raw `git worktree add` forbidden) | `:66` |
| Full configured gate run | `:73` |
| `sdlc review-packet` + derived reviewer set | `:82` |
| Component verdicts with stable `MF-<reviewer>-NNN` IDs | `:92` |
| Persisted `thoughts/reviews/{NNN}-round{n}.md` aggregate | `:99` |
| `review: APPROVED sha=… code-sha=… plan-sha256=N/A …` epic note | `:120` |
| Post-merge memory audit against the merged tree | `:127` |
| `bd worktree remove` + local/remote branch deletion | `:130` |

Meanwhile the lane guard (`:20-24`) refuses anything above ~5 files / 150 lines.
So the lane is: maximum ceremony, minimum permitted scope. That is the inverse of
what a light lane should be.

### The Beads hard dependency compounds it

`bd` is not optional anywhere that matters:

- `sdlc setup` refuses outright without `--skip-beads` (`bin/sdlc.mjs:592-599`).
- `bd` missing → `doctor` exit **1**; `bd` present but < 1.1.0 or missing any of
  10 required capabilities → exit **3** (`lib/beads.mjs:147-150`,
  `lib/doctor.mjs:842,921`).
- Every guard is a projection of doctor, so a bd problem blocks **every
  transition on every ticket in the repo** (`lib/guard.mjs:128`).
- `sdlc review` can't even locate a worktree without bd, because worktrees are
  only discovered via `native.worktrees` (`lib/doctor.mjs:757`,
  `bin/sdlc.mjs:360-365`).

This repo demonstrates the failure mode: there is no `.beads/` directory, it is
not gitignored, and `sdlc guard plan 001` returns
`REFUSED … state=blocked … bd --readonly context --json` failed. **The sdlc repo
cannot run its own pipeline.**

### Recommendation

**R1.1 — Add a real trivial lane.** Below chore: no Bead, no worktree, no
aggregate artifact. Branch + gates + commit + human merge. The audit trail for a
typo is the commit itself. Reserve the review artifact for work that has a plan.

**R1.2 — Make Beads an optional coordination upgrade, not a hard floor.**
Add a `git-only` mode where status lives in frontmatter, the "epic" is a branch,
and approval records live in a committed `thoughts/approvals/{NNN}.md` instead of
epic notes. Beads then buys concurrency and claim safety for teams that need it,
rather than gating single-developer adoption on a 1.1.0-pinned external binary.
The hash-chain guarantee does not depend on Beads — it depends on
`sdlc hash` + git, both of which already work standalone.

**R1.3 — Drop the mandatory worktree below the plan lane.** A worktree per chore
is real filesystem and cognitive overhead; `bd worktree remove` refusing on a
stray dirty file turns a typo fix into a recovery exercise
(`skills/sdlc-chore/SKILL.md:130`).

**R1.4 — Let the invoker widen the lane explicitly.** `/sdlc-chore --allow-plan-scope`
beats the current "stop without merging, keep the ticket, go create a real plan
for the same NNN" (`:24`), which discards in-flight work at exactly the moment
the human already knows what they want.

---

## 2. Latency is re-derivation, not work

### Evidence

`inspectBeadsInstallation` spawns **13 processes per call** — one `--version` plus
twelve `--help` probes — and does no memoization at any level
(`lib/beads.mjs:105-131`).

Measured two ways. First on this repo, where the bd diagnostics **fail
immediately** (no `.beads/`), so these are close to a floor:

```
12 × bd worktree --help                    →   1.23 s
sdlc guard plan 001                        →   3.58 s
sdlc snapshot --view=queue                 →   3.73 s
```

Then on `~/development/ftr` — a real project using this pipeline, with a live
Beads database, 18 tickets and one active worktree. These are the numbers that
matter:

```
sdlc snapshot --view=queue    →  15.12 s, 15.25 s, 16.97 s
sdlc guard implement 002      →  11.36 s, 11.24 s
sdlc doctor 002 --json        →  11.38 s
```

**A live database costs 4× the floor.** Restating the earlier subprocess
arithmetic in wall-clock, for a 4-step plan:

| Path | Cost |
|---|---|
| `/sdlc-queue` — the "read-only dashboard" | **~15 s per look** |
| `/sdlc-next` — one autonomous iteration | ~15 s before it decides anything |
| 7 × `sdlc guard implement` in the execution loop | **~79 s of pure preflight** |
| Every guard refusal, which adds a full doctor | +11 s each |

None of that includes model time, tests, or the actual work. The implement loop
spends over a minute re-proving invariants, and a dashboard glance costs a
quarter-minute.

Caution for anyone re-measuring: `npx --no-install sdlc …` inside a project that
does not depend on the package **fails in ~1 s** and looks like a fast result.
Time `node <path>/bin/sdlc.mjs` directly.

Per `sdlc guard` call the breakdown is roughly **28 `bd` + ~15 `git` ≈ 45
subprocesses**, of which 13 are pure capability re-discovery. The
`/sdlc-implement` contract for a 4-step plan requires 7 guard calls
(`skills/sdlc-implement/SKILL.md:12,18,57,139`) — call it **~25 s of preflight**,
≈315 subprocesses, ≈91 of them `bd --help`. Any refusal adds a full `sdlc doctor`
at identical cost.

Gates have no caching of any kind. `runGates` rebuilds the command list every
invocation, re-proves the log directory writable with a probe file, creates a run
dir, and prunes to 10 runs — every time (`lib/gates.mjs:32-41,158-162`). Execution
is serial with fail-fast (`:165-172`), so a failing *target* gate re-runs all
preceding *global* gates on retry. The implement contract calls gates per step,
again before review, and again after every review round
(`skills/sdlc-implement/SKILL.md:82,141,213`) — `npm test` runs N+1+rounds times
per plan. The pre-review run at `:141` is frequently the **same tree** as the
step-N run at `:82`.

### Recommendation

**R2.1 — Memoize the capability probe. Highest impact-to-effort ratio in the
repo.** Cache `inspectBeadsInstallation` in-process, and across processes in a
file keyed on `bd --version` output + the binary's mtime. Capabilities cannot
change mid-session. Saves ~1.2 s × ~15 calls per plan for roughly 20 lines of
code. Do this first.

**R2.2 — Let the implement loop pass its snapshot forward.** The per-iteration
guard re-collects *global* Beads diagnostics five times to check facts that only
change when the loop itself mutates them — and the loop knows exactly what it
mutated. Add `sdlc guard implement {NNN} --since <state-hash>` that re-verifies
only the delta, and full-collects only when the hash doesn't match.

**R2.3 — Cache gate results by (tree-hash, command).** `git rev-parse HEAD^{tree}`
plus the opaque command string is a sound key. A clean skip prints the cached
summary and exits 0. This alone removes the duplicate pre-review run.

**R2.4 — Parallelize independent spawns.** The ~15 git calls in a guard
(`lib/doctor.mjs:38-39,354-361,178-184`) are independent; so are the 12 help
probes while they exist. Serial `execFileSync` is the default here for no
particular reason.

**R2.5 — Consider one batched Beads read.** Nine diagnostic queries plus an N+1
per gate is a lot of process spawns for facts that a single richer bd call could
return. Worth raising upstream rather than working around locally.

---

## 3. The prose is defensive where the code already is

### Evidence

| Surface | Bytes |
|---|---|
| Always-loaded (`AGENTS.root.md` + `thoughts/AGENTS.md`) | 7,564 |
| All ten skills | 66,908 |
| Four reviewer profiles | 43,370 |

The reviewer profiles were cut only **7.4%** in the 0.4 pass
(`thoughts/design/token-benchmarks.md`) and are now the single largest payload —
loaded per reviewer, per round.

Prohibition density across skills: **108 uses of "never"**, concentrated in
`sdlc-implement` (16), `sdlc-approve` (11), `sdlc-land` (9). Sample from one
skill: "Never fall back to raw `git worktree add`," "never equate a shared OS/Git
identity with ownership," "never rely on shell export or an older actor,"
"Never merge main." Each of these is either (a) already mechanically enforced, or
(b) unenforceable by prose against an agent that isn't reading carefully — which
is the only agent the prohibition is aimed at.

The clearest case of prose duplicating code: `skills/sdlc-implement/SKILL.md:159-208`
spends ~50 lines describing the aggregate artifact grammar — verdict lines, MF-ID
reconciliation, `Scope-Check`/`AC-Coverage`/`Fix-Disposition` controls, final-line
placement. All of it is already parsed and validated in `lib/review-artifact.mjs`.

### The em-dash is a live fragility

```js
// lib/review-artifact.mjs:1
export const VALID_REVIEW_VERDICT =
  /^(?:APPROVED(?: — [1-9]\d* NIT)?|BLOCKED — [1-9]\d* MUST FIX)$/;
```

That is a literal U+2014, with exactly one space on each side, required. A hyphen
or en-dash fails validation. The cost of failing it: one same-HEAD retry, then
the epic is labelled `human` and unattended review **stops**
(`skills/sdlc-implement/SKILL.md:171`).

So a dash character can halt the pipeline and require human intervention. Note
that `lib/review-artifact.mjs:216` already accepts `[-—]` for the title line — the
strictness is inconsistent, not principled.

### Recommendation

**R3.1 — Normalize the verdict grammar instead of policing it.** Accept
`[-–—]` with flexible whitespace, normalize on write. Keep the *structure*
strict (exactly one verdict line, must be final, counts must reconcile); stop
being strict about a character an LLM has no reliable control over.

**R3.2 — Emit contracts from the CLI; don't describe them in prose.**
`sdlc review-artifact --template {NNN} --round {n}` and
`sdlc review-artifact --validate <path>` replace ~50 lines of skill prose with a
generate-then-check loop. Same for the discovery contract
(`skills/sdlc-implement/SKILL.md:112-137`), the approval record
(`skills/sdlc-approve/SKILL.md:330`), and the memory format
(`skills/sdlc-land/SKILL.md:455-462`). A format that is validated in code should
be *produced* by code.

**R3.3 — Rewrite in a positive register.** "Create the worktree with
`bd worktree create`" is shorter and clearer than the same sentence plus "never
fall back to raw `git worktree add`." Where the prohibition is load-bearing,
enforce it in the guard; where it isn't, delete it. Target: halve the 108.

**R3.4 — Compress the reviewer profiles.** 43 KB across four files, re-read every
round. Move the shared mechanical scaffolding (identity checks, output format,
read-only rules) into one short common preamble the CLI injects into packets, and
leave each profile as only its genuine specialist knowledge.

---

## 4. Reviewers are calibrated for one project stage: late

Every review lands at roughly enterprise/regulated rigor regardless of what the
project actually is. This is not a tone problem that better wording fixes — the
profiles contain an **incentive gradient that makes approving more expensive than
blocking**, plus a persona instruction to maximize findings, plus no input that
could tell a reviewer the stakes are low.

### 4a. Approving costs more than blocking

To approve with zero MUST FIX, a reviewer must produce all five Clean-Pass
Evidence surfaces, including "applicable security, data, performance, and
operational risks considered" — and "an approval without all five evidence
surfaces is **malformed**" (`template/agents/backend-code-reviewer.md:115-126`,
`general-code-reviewer.md:112-131`). A malformed report costs a same-HEAD retry;
a second failure labels the epic `human` and stops unattended review
(`skills/sdlc-implement/SKILL.md:171`).

Compare the two paths available to a reviewer that has found nothing serious:

| Path | Cost |
|---|---|
| Approve | Write five defensible evidence essays, including a security argument, or the report is malformed and may stall the pipeline |
| Raise one MUST FIX | One `file:line` + one sentence. Clean-Pass Evidence is then **not required at all** |

The cheap, safe move is to find something. Repeated across every review, that
is a machine for generating security findings. The rule was written to prevent
lazy rubber-stamping; its actual gradient rewards blocking.

### 4b. No reviewer can learn that the stakes are low

Project Configuration has no stage, maturity, threat-model, or data-class field
(`lib/config.mjs:160-166`, `template/thoughts/AGENTS.md:14-25`). The only
calibration lever in the whole system is `Frontend constraints`, and it is
frontend-only — and it feeds the *blocking* tier, not the permissive one
("UI work that violates a declared frontend constraint … MUST FIX",
`frontend-code-reviewer.md:99`).

So a reviewer on a two-week-old internal tool receives exactly the same context
as one on a payment service, and is told to check eleven risk surfaces
unconditionally: "correctness, error paths, state transitions, resource
lifecycle, concurrency, input/trust boundaries, security, data integrity,
public/API compatibility, material performance, and tests"
(`general-code-reviewer.md:71`).

### 4c. Severity is assigned by category, not by impact

> **MUST FIX** — blocks merge: a correctness, **security**, data-integrity, or
> public-contract defect
> — `general-code-reviewer.md:86`, `backend-code-reviewer.md:90`

Anything a reviewer can *label* security is automatically merge-blocking. There
is no reachability or exploitability qualifier. A hardcoded credential in a
local-only test fixture and a hardcoded credential in a public auth path get the
same tier. Frontend has the same shape: "WCAG AA violations are MUST FIX"
(`frontend-code-reviewer.md:86`), unconditionally — correct for a public product,
overreach for an internal admin prototype.

### 4d. Establishing mode makes early projects noisier, not quieter

> **Establishing mode** — this change is the *first* instance of a pattern
> (common in greenfield repos) … **explicitly flag precedent-setting choices** so
> a human ratifies them — the next reviewer will enforce whatever this change
> establishes.
> — `backend-code-reviewer.md:62`

In an early project *everything* is precedent-setting, so this instruction
maximizes output in exactly the case where the user wants least. Early projects
receive **more** review pressure than mature ones. That is backwards: precedent
in a young repo is cheap to change later, which is an argument for advisory
notes, not merge blocks.

### 4e. It doesn't just add noise — it stalls

Round two's MUST FIX count must *decrease* or the epic is labelled `human` and
review stops (`skills/sdlc-implement/SKILL.md:215`). Combine that with a reviewer
structurally incentivized to keep finding things, and an over-strict review
becomes a **stalled pipeline requiring human rescue**, not merely a verbose one.

### Recommendation

**R4.1 — Declare the stakes in Project Configuration, and put them in the packet.**

```md
- **Review profile:** `prototype | product | regulated`
- **Threat model:** `local-only | internal-trusted | public-untrusted`
- **Data classes:** `none | user-pii | payment | phi`
```

`sdlc review-packet` already classifies every changed path; have it inject these
into each packet. A reviewer can then write "security: N/A — no untrusted input
boundary in this project" *honestly*, instead of manufacturing a finding to avoid
a malformed clean pass.

**R4.2 — Make a clean pass cheap. This is the load-bearing fix.** Have
`review-packet` compute which risk surfaces the diff actually touches (does it
cross a network boundary, build a query, touch auth, alter a migration?) and emit
a `Required-Evidence:` line listing only those. A change touching none of them
needs three lines of evidence, not five essays. Keep the anti-rubber-stamp intent;
remove the gradient that makes blocking the cheap option.

**R4.3 — Gate severity on reachability, not category.** A security or
accessibility finding is MUST FIX only when the reviewer can state a reachable
path *under the declared threat model*. Otherwise it is a NIT. Same code,
different stakes, different tier — which is what "proportionate" actually means.

**R4.4 — Invert establishing mode.** In establishing mode, precedent-setting
observations go to `Notes` as ratifiable advisories, capped in number. Reserve
MUST FIX for defects that are wrong at any stage.

**R4.5 — Retire the "hyper-critical" persona.** "You are hyper-critical and you
hold a high bar" (`backend-code-reviewer.md:10`, `frontend-code-reviewer.md:10`)
is a direct instruction to maximize findings. Replace with an explicit bar tied
to the declared review profile.

---

## 5. Subagent model selection is hardcoded, host-inconsistent, and not editable

There is no way to say "reviewers get the frontier model, step implementers get
the cheap one." The policy exists in the source — it just isn't configurable, and
it is expressed differently for each of the three hosts.

### 5a. Three hosts, three different answers

| Host | Model | Reasoning effort | Where |
|---|---|---|---|
| Claude | `model: inherit` — all four reviewers get the session model | not set | `template/agents/*.md:4` |
| Codex | `gpt-5.6` hardcoded for all four | `high` for all four | `bin/sdlc.mjs:46-58` |
| Pi | **nothing emitted at all** | nothing | `renderPiAgent`, `bin/sdlc.mjs:574-586` |

The intent is already written down as a code comment:

> `// Code review benefits from the frontier model's deeper reasoning.`
> — `bin/sdlc.mjs:47`

That is a policy statement. It is hardcoded for one host, absent for the other
two, and unreachable for the user. It is exactly the kind of thing that belongs
in configuration.

Two further consequences: the literal `"gpt-5.6"` ships inside a published npm
package, so it goes stale on every model release and needs a package release to
change; and Pi reviewers silently run on whatever that host defaults to.

### 5b. `setup --force` destroys local model edits

Today the only way to change a model is to edit the installed profile. That
survives until the next upgrade:

```js
// bin/sdlc.mjs:684-688  (identical shape for Codex :699-703 and Pi :713-717)
if (existsSync(dest) && !force) { skip(`${file} exists (use --force to overwrite)`); continue; }
cpSync(join(agentsDir, file), dest);
```

And `--force` is precisely what the documented upgrade path tells you to run
(`README.md:337,341`: "Run setup again with the required agent target and
`--force`"). So the supported way to upgrade silently reverts every model choice
the user made. Setup already knows how to preserve user-owned files — it leaves
`thoughts/docs/INDEX.md` alone when it exists (`README.md:341`) — the reviewer
profiles just don't get that treatment.

### 5c. The subagents that do the most work have no profile at all

Only the four reviewers are profiled. The higher-volume subagents are spawned
ad-hoc from skill prose with no model control whatsoever:

| Subagent | Count on a typical 4-step plan | Cite |
|---|---|---|
| Step implementer | 4 | `skills/sdlc-implement/SKILL.md:64` |
| Research track | 0–3 concurrent | `skills/sdlc-plan/SKILL.md:103` |
| Generic critique fallback | 0–1 | `skills/sdlc-plan/SKILL.md:197,213` |
| Reviewers (profiled) | 1–3 per round | `skills/sdlc-implement/SKILL.md:146` |

So the pipeline is configurable exactly where the calls are fewest, and fixed
where they are most numerous — and step implementers are the clearest candidates
for a cheaper tier, since they execute an already-reviewed, file-scoped
instruction rather than exercising judgment.

### Recommendation

**R5.1 — Add `.agents/sdlc.json`, keyed by role, with model IDs behind tiers.**

```json
{
  "version": 1,
  "models": {
    "defaults": { "tier": "balanced", "effort": "medium" },
    "roles": {
      "plan-reviewer":          { "tier": "frontier", "effort": "high" },
      "backend-code-reviewer":  { "tier": "frontier", "effort": "high" },
      "frontend-code-reviewer": { "tier": "frontier", "effort": "high" },
      "general-code-reviewer":  { "tier": "frontier", "effort": "high" },
      "research-track":         { "tier": "balanced", "effort": "medium" },
      "step-implementer":       { "tier": "cheap",    "effort": "low" }
    },
    "tiers": {
      "claude": { "frontier": "inherit", "balanced": "sonnet", "cheap": "haiku" },
      "codex":  { "frontier": "gpt-5.6", "balanced": "gpt-5.6", "cheap": "gpt-5.6-mini" },
      "pi":     { "frontier": "…",       "balanced": "…",       "cheap": "…" }
    }
  }
}
```

`.agents/` is the right home because it is *already* the canonical host-neutral
root — "Skills live canonically in `.agents/skills/` for every target"
(`bin/sdlc.mjs:639`), and `.claude/`, `.codex/`, and `.pi/` are rendered from it.
Model policy has exactly that shape: one canonical declaration, three rendered
host-specific forms. It also avoids inventing a fourth top-level dot-directory.

Namespacing the models block under a `models` key leaves room for later
host/runtime settings without another new file.

The tier indirection is the load-bearing design choice. The **role policy**
("review deserves the best model available") is stated once and is portable
across hosts; the **model IDs**, which are the part that goes stale, live in one
small per-host map. That kills the hardcoded-`gpt-5.6` staleness problem and
gives Pi somewhere to declare models it currently cannot.

**R5.2 — Not in `thoughts/AGENTS.md`.** Every other setting lives in Project
Configuration, but this one shouldn't: it is host/runtime configuration consumed
by `setup` and by skills at spawn time, not workflow semantics a human needs in
front of them each session. Putting a model table in the always-loaded contract
would re-inflate the payload that the 0.4 pass just cut 70.8%. The split is
clean and already implied by the layout: `thoughts/` is *what the project is
building*, `.agents/` is *how the agents are wired to build it*.
`lib/config.mjs` can still expose it via a separate reader so there is one code
path.

**R5.3 — Make it survive `--force`.** Treat `.agents/sdlc.json` the way setup
already treats `thoughts/docs/INDEX.md`: create when missing, never overwrite.
Setup then renders each host's profile *from* it, so `--force` refreshes reviewer
prose while preserving model choices. This is a bug fix, not just a feature.

Note that `.agents/` placement makes this fix structurally sounder than a
per-host edit ever was: the model choice now lives *outside* every directory
setup rewrites, so there is nothing for `--force` to clobber in the first place.

**R5.4 — Expose it to skills as CLI output, not prose.** Add
`sdlc models <role> [--host <h>] [--json]` returning the resolved model and
effort. Skills spawning an unprofiled subagent read one deterministic line
instead of interpreting a config table — consistent with this repo's existing
direction of moving decisions out of prose and into the CLI. `sdlc doctor` can
then warn on an unknown role or a tier with no mapping for the active host.

**R5.5 — Compose it with the review profile from R4.1.** A declared `prototype`
project can map its reviewers to `balanced` instead of `frontier`; a `regulated`
one pins them to `frontier` with `high` effort. That makes "proportionate review"
a cost lever as well as a rigor lever, and it is the natural place for the two
recommendations to meet.

---

## 6. Worktrees are mandatory but justified by only one scenario

"Every plan uses a separate worktree" (`README.md:176`) is stated as an axiom.
It is worth asking what it actually buys, because it is the single most expensive
structural commitment in the pipeline.

### 6a. What they genuinely buy

Three arguments, in descending strength:

1. **Concurrent in-flight plans.** Two plans implemented at once without checkout
   thrash. The design clearly anticipates this — `sdlc snapshot` emits
   `file-overlap:<path>` rejection codes to keep concurrent plans off the same
   files.
2. **A long-running agent doesn't occupy your checkout.** An autonomous
   `/sdlc-implement` holds a working tree for a long time. With a worktree, a
   human can still use the primary checkout meanwhile. This is the strongest
   *single-developer* argument and it is a real one.
3. **Canonical text stays readable while implementing.** Primary main stays on
   `main`, so implementers and reviewers can read canonical ticket/plan paths
   from disk.

Argument 3 is weaker than it looks — see 6c.

### 6b. What they cost

**The environment problem, which nothing handles.** `bd worktree create` is a
plain `git worktree` plus a `.gitignore` entry — it copies nothing:

```
This command:
1. Creates a git worktree at ./<name> (or specified path)
2. Adds the worktree path to .gitignore (if inside repo root)
```

A fresh worktree therefore has **no `node_modules`, no `.venv`, no build cache,
and none of your gitignored `.env` files**. Then the contract immediately runs
`sdlc gates --cwd <worktree> --target <target>` (`skills/sdlc-implement/SKILL.md:82`),
which runs the configured `npm test`.

A grep across `skills/`, `lib/`, `template/`, and `bin/` for any dependency or
env bootstrap returns **nothing**. So on a Node project, every plan's first gate
run fails with a missing-module error — and the skill tells the agent to "fix any
failure using the bounded excerpt/full-log path before closing the issue"
(`:82-84`), pointing it at the code rather than at the uninstalled tree. The
recovery is undocumented and the agent has to invent it. Gitignored `.env` files
are worse: they never appear at all, so the failure looks like a config bug.

Confirmed in `ftr`: the live worktree does have `node_modules`, so the install
happened — manually, off-contract, and at **847 MB**. `.wrangler` (a build cache
present at the root) did not make the trip. The gap is real; it is currently
absorbed by hand.

The rest of the bill:

| Cost | Cite |
|---|---|
| Worktrees are *why* Beads is a hard dependency in implement/chore/land/cancel — raw `git worktree add` is forbidden | `sdlc-implement/SKILL.md:47`, `sdlc-chore/SKILL.md:66` |
| `bd worktree remove` refuses on dirty files, unpushed commits, or stashes — a typo fix becomes a recovery exercise | `sdlc-chore/SKILL.md:130` |
| ~7 git spawns per guard call just for worktree state | `lib/doctor.mjs:354-361` |
| `sdlc review` hard-fails with no Beads-visible worktree | `bin/sdlc.mjs:360-365` |
| Full working copy per plan on disk. Measured in `ftr`: **847 MB** of `node_modules` in the one live worktree, against 81 MB at the root | — |
| IDE/LSP/watchers/dev servers pointed at the wrong directory | — |

### 6c. The canonical-text argument doesn't require a second checkout

Argument 3 above is the only one that looks structural, and it dissolves. The
plan branch is created from main *at approval time*, so it already contains the
approved text; drift happens only on amendment, which doctor already detects as
`reapproval_required`. And the approval record already pins the exact commit:

```text
approval: plan-sha256=<hex> ticket-sha256=<hex> commit=<main-sha>
```

So `git show <approval-commit>:thoughts/plans/NNN-*.md` reads canonical text
correctly from a single checkout — and reads it from the *approved* commit rather
than from whatever main happens to be now, which is strictly more correct than
the current filesystem read. The implementation cost is a `--rev` flag on
`sdlc hash`.

### 6d. The design is internally inconsistent about concurrency

Every *other* concurrency primitive in this pipeline is opt-in and off by
default. Merge slots:

> Leave this `off` until you have concurrent landers and a tested way to recover
> a stale holder. — `README.md:88`

Beads `server` mode is likewise "only when multiple root sessions must mutate
state concurrently" (`README.md:87`).

So the pipeline makes the *coordination* primitive for concurrency opt-in, while
making the *isolation* primitive for the same scenario mandatory. Single-developer
users — the overwhelmingly common case, and the default configuration this repo
ships — pay the full worktree cost for a concurrency guarantee they have
explicitly not enabled.

### Recommendation

**R6.1 — Make isolation a configured mode, defaulting to `branch`.**

```md
- **Isolation:** `branch | worktree`
```

`branch`: implement on the plan branch in the primary checkout; read canonical
text via `git show <approval-commit>:<path>`; land by merging as today. No
`node_modules` rebuild, no `.env` gap, no `bd worktree` dependency, no removal
refusals. `worktree`: today's behavior, for genuine concurrency or when you want
an autonomous agent kept out of your checkout.

Pair it with the merge slot the way the README already pairs slot with concurrent
landers — same trigger, same opt-in, stated once.

**R6.2 — If worktrees stay for a project, bootstrap them.** Add a configured
hook run once after `bd worktree create`:

```md
- **Worktree bootstrap:** `npm ci`
- **Worktree carry:** `.env, .env.local`
```

Copy the listed gitignored paths and run the bootstrap command before the first
gate. This is the missing step that currently makes every plan's first gate run
fail on a Node project.

**R6.3 — Decouple `sdlc review` from worktree discovery.** It should resolve a
branch when there is no worktree, rather than exiting 1 (`bin/sdlc.mjs:360-365`).

---

## 7. Against Anthropic's Claude-5 context-engineering guidance

Source: ["The new rules of context engineering for Claude 5 generation
models"](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models).
Headline data point: Anthropic removed **over 80% of Claude Code's system
prompt** for advanced models with **no performance loss** — "we can delete many
of them and let the model use surrounding context and judgement instead."

Applied here, most of it lands. But it needs one correction first, because
adopting it naively would damage this repo.

### 7a. The tension, and the resolution

The post's core move is *trust the model's judgment instead of constraining it
with rules*. This pipeline's entire reason to exist is the opposite: gates that
hold **regardless** of model judgment.

Both are right, about different things:

| Concern | Who should own it |
|---|---|
| *How* to write the code, structure the step, phrase the finding | Model judgment — delete the rules |
| *What must be true* before a transition is legal | Deterministic CLI — never prose |

The failure mode this repo actually has is **neither** of those: it is
*prohibitions written in prose that the CLI already enforces*. That is the worst
of both worlds — it costs context on every load **and** provides no real
enforcement, since the only agent that would violate it is the one not reading
carefully. So the post doesn't argue for weakening sdlc's gates. It argues for
finishing the migration already begun: rules move **into the CLI or out of
existence**, never into more prose.

That is the same line drawn in section 3; the post is independent evidence for it,
with a much stronger number attached than I had.

### 7b. What it validates

- **Rules → judgment.** The post's own example — "never write multi-paragraph
  docstrings" → "Write code that reads like the surrounding code" — is nearly
  verbatim R3.3. This repo carries **108 "never"s**.
- **Repetition → single authoritative source.** Measured duplication:

  | Instruction | Repeated in |
  |---|---|
  | The actor invariant ("capture the literal … never rely on shell export") | **5 skills**, near-verbatim |
  | `bd --readonly` enforcement | **33 restatements across 11 files** |
  | The verdict grammar block | 2 skills + the reviewer profiles |

- **Examples → interface design.** "Providing tool usage examples actually
  constrains them to a certain exploration space." The skills embed full format
  templates — aggregate artifact, discovery contract, research synthesis
  frontmatter, memory format. That is exactly R3.2: emit them from the CLI as an
  interface, don't narrate them.

### 7c. What it adds that I had missed

**Split the long skills.** The post: "Divide long skills across multiple files
for progressive disclosure." The 0.4 pass applied progressive disclosure at the
*contract* level and stopped there — the skills themselves are now the monolith.
`sdlc-implement` is 230 lines loaded in full at the first guard call, and
**lines 110–230 (52%) are the aggregate-review contract**, which is irrelevant
until every child issue is closed. The execution loop and the review contract are
two different jobs with two different trigger points.

Split it: `SKILL.md` keeps preflight, worktree, and the execution loop;
`review.md` holds the reviewer set, component contract, artifact shape, and
convergence, loaded when the guard returns `mode=review`. Same treatment for
`sdlc-chore` (10.7 KB, its own embedded review contract) and the recovery/legacy
branches in `sdlc-approve` and `sdlc-land`.

**Rich references over specifications.** "Code-based references … provide clear,
high-fidelity instructions." The reviewer profiles already do this well —
"nearest canonical siblings" is exactly the pattern. Plan steps do not: they
describe an implementation in prose where they could cite the canonical sibling
to imitate. A `Pattern:` field on a plan step pointing at a real file would carry
more signal than a paragraph.

### 7d. What does *not* apply

**Auto-memory.** The post recommends replacing manual memory files with automatic
memory. This repo's memory system is Beads-backed and deliberately cross-host —
Codex and Pi have no equivalent. Adopting host-native auto-memory would break the
portability that motivated the design. Keep the current system; the post's advice
here is Claude-specific and this pipeline is not.

Note also that the post's `/doctor` (Claude Code's context-rightsizing command)
is unrelated to `sdlc doctor`. Worth avoiding the collision in future docs.

### Recommendation

**R7.1 — Split skills over ~120 lines by trigger point**, starting with
`sdlc-implement` → `SKILL.md` + `review.md`. Highest-value single application of
the post, and it compounds with R3.2.

**R7.2 — Deduplicate the five repeated invariant blocks.** State the actor
invariant and the `--readonly` rule once in `thoughts/AGENTS.md`; delete the
restatements. Better still, make the guard reject a wrong-actor mutation so the
prose is unnecessary — it already does (`lib/guard.mjs:174-175`, `foreign-claim`).

**R7.3 — Treat the 108 prohibitions as a work-list**, not a style question. For
each: enforce in the CLI, or delete. Do not rewrite it as a gentler prohibition.

---

## 8. Memory: Honcho and OpenViking evaluated, both declined

Question raised: keep Beads (which is earning its place) but move *memory* to a
purpose-built layer. Both candidates are real and were checked against current
docs rather than recollection.

### What sdlc's memory actually is

Not conversational memory. It is **verified claims about a codebase, pinned to a
merge commit**: `Tags / Index / Finding / Why / Applies when / Source: plan NNN,
merge commit <sha>`. Written as `memory-candidate:` notes during implementation,
promoted by `/sdlc-land` **only after a merge commit exists** and only if still
true in the merged tree, with `keep / refresh / merge / forget` conservatism where
"uncertainty means keep." Cancelled work never promotes. Retrieval is exact:
`bd --readonly memories "tag:<tag>"` then explicit `recall <key>`.

### Honcho — wrong problem

`/plastic-labs/honcho`. Its object model is *peers*: `save_memory("alice", "I
love hiking in the mountains", "user", "session-1")`, then
`query_memory("alice", "What are my hobbies?")` → a synthesized natural-language
answer. Its headline differentiator is that it **reasons about** stored data —
"Compounding Insights … user profiles become increasingly accurate and rich over
time."

That is the opposite of what this pipeline needs. sdlc's memory value comes from
a fact being *checked against a merged tree and pinned to a SHA*; a layer whose
selling point is inferring new claims beyond what was written would inject
underived assertions into the one subsystem built entirely around provenance. And
a synthesized prose answer cannot be hash-pinned, diffed, or audited — the
`/sdlc-land` audit has nothing to operate on. Honcho models people; sdlc models
repositories.

### OpenViking — right idea, wrong layer

`/volcengine/openviking`: "an open-source context database … using a filesystem
paradigm to unify memory, resource, and skill management with tiered loading and
semantic retrieval." Genuinely well-aimed — deterministic `viking://` paths,
`ls`/`find` navigation "rather than solely relying on vector search," and L0/L1/L2
tiering (`.abstract` ~100 tokens, `.overview` ~2k, full content on demand).

Declined for three reasons:

1. **It is a server.** Docker Compose, port 1933, a persisted volume. sdlc today
   has zero daemons and zero network dependencies; Beads is local and embedded.
   Adding a container to a pipeline whose selling point is deterministic,
   offline, reproducible local runs is a large regression — and section 2 already
   shows the cost of one more service to talk to.
2. **It solves a problem sdlc doesn't have.** The memory pain was *eager loading
   of all bodies at session start*, and the 0.4 pass already fixed that with tag
   search plus explicit recall. Retrieval is not the bottleneck; the 15 s
   snapshot is.
3. **It doesn't absorb the part that's actually hard.** Merge-SHA provenance and
   the post-merge keep/refresh/merge/forget audit are workflow logic living in
   `/sdlc-land`. Swapping the store leaves all of it in place, and adds a second
   coordination system alongside Beads for Claude, Codex, and Pi to agree on.

### The real memory finding

Neither tool addresses the actual weakness, which is that **memory is entirely
prose-enforced**. A grep of `lib/` and `bin/` for memory handling returns a
capability list in `beads.mjs` and one contract string — nothing that parses or
validates a `memory-candidate:` note. Meanwhile the format and audit rules are
restated across 7 instruction files (`sdlc-land` alone mentions memory 12 times).

That is the same pathology as section 3 and section 7b: a mechanically checkable
contract living in prose instead of code.

**R8.1 — Keep Beads for memory. Move the memory *contract* into the CLI.** Add
`sdlc memory candidate --validate` and `sdlc memory audit --json` so the
`memory-candidate:` grammar, tag count, and provenance fields are checked
deterministically, and `/sdlc-land` consumes a validated list instead of
re-deriving one from prose. Steal OpenViking's tiering idea for
`thoughts/docs/INDEX.md` and the R7.1 skill split — where L0/L1/L2 genuinely
applies — without taking the dependency.

---

## 9. Meta-finding: what the dogfooding actually shows

*This* repo is not — no `.beads/`, `guard plan 001` blocked, ticket 001 and plan
001 are prose that never ran through the machinery they describe. But the
pipeline **is** dogfooded, in `~/development/ftr`, and that is where every
wall-clock number in this document comes from.

### What the ftr state does *not* mean

An earlier draft of this section read `ftr`'s artifact counts — 18 tickets with
15 in draft, 0 persisted review artifacts — as a funnel collapsing under the
friction described in sections 1–7. **That inference was wrong**, and it is
recorded here so nobody re-derives it.

The actual explanations are mundane: the drafts are simply work not yet started,
and ticket 001 was cancelled because the change it tested didn't pan out — not
because a gate blocked it. Artifact-status distribution in a young project is a
picture of what its author has gotten around to, not a measure of pipeline
health. There is no adoption-failure signal in these counts.

This matters methodologically: everything else in this document is either a
direct measurement or a citation. That one paragraph was a narrative built on
top of counts, and it was the only thing here that didn't survive contact with
the person doing the work.

### What it does mean

`ftr` is a working measurement rig. It has a live Beads database, a real
worktree, and enough tickets to exercise the snapshot path — which is why the
timings in section 2 are trustworthy and the ones taken against this repo were
4× too low. It also revises the `N/E` benchmark table: `ftr` can supply real
wall-clock numbers for every scenario in
`thoughts/design/token-benchmarks.md`.

**R9.1 — Instrument `ftr`, don't build a new fixture.** Record per-stage timings
from the live repo. The measurements already taken are enough to justify items
1–5 in the order below without further study.

---

## 10. Why `/sdlc-implement` stops mid-plan — diagnosed

Reported symptom: `/sdlc-implement` "randomly stops instead of working through
all steps." It is not random. There are two mechanisms, and the live `ftr` plan
002 is currently sitting in the first one.

### 10a. A pause longer than a day becomes a permanent block

```js
// lib/doctor.mjs:814
const corroborated = !worktree
  || (!worktree.dirty && worktree.lastCommitAt && inspectionNow / 1000 - worktree.lastCommitAt >= 86400);
if (corroborated) errors.push(`Plan has ${stale.length} stale in-progress Beads issue…`);
else warnings.push('Beads reports candidate stale work, but current Git/worktree activity does not corroborate abandonment.');
```

Measured on `ftr` plan 002 right now:

```
last commit:  4 days ago (2026-07-21)
dirty:        0 files
elapsed:      319,034 s   (threshold 86,400 s)
→ guard implement 002 → REFUSED code=wrong-state
   "Plan has 1 stale in-progress Beads issue corroborated by worktree inactivity."
```

The full chain:

1. `/sdlc-implement` claims the epic and its step children — they become
   `in_progress` (`SKILL.md:31,63`).
2. The loop commits only at the **end** of each step (`:85`), so a step in
   progress produces no git activity by design.
3. The session ends for any reason — you stop for the day, context runs out, a
   step blocks, the model errors. **Nothing releases the claims.**
4. 24 h later, with a clean worktree, `doctor.mjs:814` promotes the stale
   *warning* into a hard **error**.
5. Hard error → `invariantErrors` → `state = 'blocked'` (`:840-842`).
6. `guard implement` accepts only `healthy` (`guard.mjs:170`) → refuses.
7. Recovery needs a human running `bd update --status=open --assignee=""` under a
   **fresh actor**. It cannot self-heal.

So any interruption longer than a day converts into a hard block requiring manual
claim surgery. Note the `!worktree` disjunct too: if the worktree isn't
Beads-visible, staleness is corroborated **instantly**, with no threshold at all.

The rule conflates *abandoned* with *paused*, and it never checks who holds the
claim — `doctor.mjs:812` intersects bd's stale list with plan issues and looks at
no actor.

### 10b. Why it also stops *mid-run*

```js
// lib/guard.mjs:169-170
if (stage === 'implement') {
  const refused = wrongDoctorState(stage, diagnosis, ['healthy']);
```

**Implement requires full `healthy`, and `healthy` is a conjunction over ~61
distinct `errors.push` sites in `doctor.mjs`** — every one collapsing to
`blocked`. That guard runs at the top of *every* loop iteration
(`SKILL.md:57-60`). Any one of 61 conditions arising mid-run halts the loop,
including conditions entirely unrelated to the step being executed.

Three specific paths that present as "it just stopped":

| Path | Cite | Looks like |
|---|---|---|
| `no-ready-work` — open children, none ready | `guard.mjs:180` | silent stop with steps remaining |
| `mode = children.open.length ? 'execute' : 'review'` — a prematurely closed child flips mode | `:181` | loop *ends* and jumps to review with work left |
| `foreign-claim` — one missing `BEADS_ACTOR` prefix once the epic is `in_progress` | `:174-175` | stop immediately after a successful step |

The last one is prose-enforced: every mutation *and* every loop guard must be
manually prefixed `BEADS_ACTOR="<session-actor>"` (`SKILL.md:58`). Drop it once
and the run halts.

Compounding all of it, a refusal prints only `diagnosis.errors[0]`
(`guard.mjs:128`). When several invariants fail, the displayed reason may not be
the operative one — which is precisely why the stops feel arbitrary.

### Recommendation

**R10.1 — A claim held by *this* actor is never stale.** Check the holder before
promoting a stale warning to an error at `doctor.mjs:812-815`. Own claim →
resumable, no error. Foreign claim → today's behaviour. This alone un-sticks the
overnight case and is a few lines.

**R10.2 — Release claims on clean exit.** When the loop stops for any
non-crash reason, reset its step claims to `open`. A normal stop should not age
into a block.

**R10.3 — Implement should not require all of `healthy`.** Project the
invariants execution actually depends on — approval identity, epic ownership, no
open gate, ready work — and let unrelated diagnosis errors stay warnings. A
failure in an unrelated invariant should not kill an in-flight loop.

**R10.4 — Print every blocking error, not `errors[0]`.** Keep the one-line
accept; on refusal, list all failing invariants so the operative cause is
identifiable without a follow-up `doctor --json`.

**R10.5 — Raise or configure the 86,400 s threshold**, and drop the `!worktree`
instant-corroboration disjunct. A missing worktree is its own condition
(`worktree-missing`) and shouldn't be laundered into a staleness claim.

Immediate unblock for `ftr` 002, for reference:

```bash
BEADS_ACTOR="sdlc:<runtime>:<new-session>" bd update <step-id> \
  --status=open --assignee="" --append-notes="claim recovery: paused 4 days, not abandoned"
```

---

## Recommended order

| # | Change | Effort | Impact |
|---|---|---|---|
| 1 | R10.1 own-actor claims are never stale | few lines | **stops a 1-day pause from permanently blocking a plan** |
| 2 | R10.4 print all blocking errors, not `errors[0]` | tiny | makes every other stop diagnosable |
| 3 | R2.1 memoize bd capability probe | ~20 LOC | ~1.2 s off every guard/doctor/snapshot |
| 4 | R10.3 implement guard projects only execution invariants | small | stops unrelated errors killing an in-flight loop |
| 5 | R5.3 stop `setup --force` clobbering model edits | tiny | fixes silent data loss on the documented upgrade path |
| 6 | R10.2 release claims on clean exit | small | removes the cause rather than the symptom |
| 7 | R4.1 declare review profile / threat model / data classes | small | the input every other calibration fix needs |
| 8 | R4.2 packet-computed `Required-Evidence:` | small–medium | removes the block-is-cheaper gradient |
| 9 | R6.2 worktree bootstrap + carry | small | fixes first-gate failure on every plan |
| 10 | R5.1 `.agents/sdlc.json` role→tier→model | small–medium | per-role cost/latency control on all subagents |
| 11 | R7.2 deduplicate the 5 repeated invariant blocks | small | 33 `--readonly` restatements → 1 |
| 12 | R8.1 `sdlc memory candidate --validate` | small | memory contract into code, keep Beads |
| 13 | R2.3 gate result cache by tree hash | small | removes duplicate full test runs |
| 14 | R3.1 normalize verdict grammar | tiny | removes a human-escalation failure mode |
| 15 | R4.3–R4.5 reachability severity, quiet establishing mode, persona | small | proportionate reviews |
| 16 | R5.4 `sdlc models <role>` for unprofiled subagents | small | model control where the call volume actually is |
| 17 | R7.1 split skills by trigger point | medium | 52% of `sdlc-implement` loads only when needed |
| 18 | R6.1 `Isolation: branch \| worktree`, default branch | medium | removes the largest structural cost for solo work |
| 19 | R1.1 trivial lane | medium | the actual answer to "restrictive" |
| 20 | R3.2 CLI-emitted contracts | medium | cuts skill prose without losing rigor |
| 21 | R7.3 work the 108 prohibitions: enforce or delete | medium | the post's core move, applied concretely |
| 22 | R2.2 snapshot-passing guard | medium | removes ~4 redundant global collections |
| 23 | R1.2 Beads-optional git-only mode | large | removes the adoption cliff |
| 24 | R3.4 reviewer profile compression | medium | largest remaining payload |

Items 1–16 are independent, low-risk, and touch no contract. They should not wait
on a ticket.

Section 10 now leads the order because it is the only entry that is a **defect
rather than a design preference** — it makes the pipeline unusable after any
pause longer than a day, and it is a few lines to fix. R4.1 + R4.2 remain the
smallest change that fixes the over-strict-review complaint, because they attack
the incentive rather than the wording; R5.1 + R5.5 then turn the same declaration
into a cost lever.

R6.1 and R1.2 are the same bet placed twice: worktrees are the main reason Beads
is mandatory, so `Isolation: branch` is most of the work of a git-only mode.
Sequence them together.

## Explicit non-goals

Nothing here proposes weakening: hash-bound reproducible approvals, the human
gates on approve/land/cancel, read-only enforcement for observers, the saved
aggregate review evidence, or AC traceability. The argument is that these should
be **scoped to work that warrants them** and **proved once per session rather
than once per call** — not that they should be softened where they apply.

Section 4 in particular is not "review security less." A reachable auth bypass is
a MUST FIX in a prototype too. It is: stop making a *reviewer* choose between
writing a security essay and inventing a security finding, and let a declared
`local-only` prototype record an honest `N/A` in one line. The anti-rubber-stamp
intent of Clean-Pass Evidence is right; only its cost curve is wrong.
