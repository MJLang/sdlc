---
Status: approved
Tags: [sdlc, config, setup, cli, contracts]
Type: refactor
Target: sdlc
Ticket Origin: thoughts/tickets/002-project-config-json.md
Source Ticket Hash: sha256=b3b2f22e46e119b2732ac5463652d4255aa47e970974aa2d378c121823d2b686
Beads Epic:
---

# Plan 002 - Move project configuration into `.agents/sdlc.json`

## Context

Implements `thoughts/tickets/002-project-config-json.md` (AC-001..AC-013). The ticket
moves the whole of `## Project Configuration` out of the generated
`thoughts/AGENTS.md` into a structured `.agents/sdlc.json`, adds a Git-ignored
machine-scoped overlay, deletes the Markdown grammar, and pays for the move by
delivering resolved configuration through calls the skills already make.

No research artifact: every material question was answerable from current code,
and the findings below carry the evidence. Grounding documents are
`thoughts/research/001-workflow-friction.md` §5 (R5.1-R5.5) for the
`.agents/` placement and the role->tier->model block, and
`thoughts/design/workflow-simplification.md` for tranche sequencing.

**Tranche placement** (ticket Open Question 2): this is its own tranche, not
growth of tranche 1. It is independent of tranches 2-3 in `lib/` but overlaps
their prose edits in `skills/sdlc-{plan,land,chore,ticket,review}` and
`skills/sdlc-implement/`, so it should land *after* the tranche-2 skill split
that is already in flight on this branch, to avoid rewriting the same lines
twice.

## Relevant Memories

None found - this repository has no Beads memory store. `MEMORY.md` records two
prior plan-level facts (RPI adoption, plan 001 critique state); neither
constrains this work.

## Documentation Sources

None. `thoughts/docs/INDEX.md` does not exist in this repository.

## Current-State Findings

| Area or path | Finding | Evidence | Implication |
|---|---|---|---|
| `lib/config.mjs` | 209 lines of Markdown grammar with two legacy paths: heading-absent whole-document fallback and the literal-line `Target gates:`/`Target paths:` forms | `lib/config.mjs:25-34`, `lib/config.mjs:130-139` | Both paths disappear with the format; nothing else consumes them |
| `lib/config.mjs` | Field splitting rules deliberately disagree: gate mappings must not split on `;`, path mappings must | `lib/config.mjs:60-70` | Correctness depends on the helper a field routes through - the defect class the JSON move removes |
| `lib/config.mjs` | Unknown-target error exists because gates/paths are keyed *beside* targets, not under them | `lib/config.mjs:144-145` | Nesting removes the representable case; AC-005's third clause needs re-siting (see Approval Attention AA-005) |
| `bin/sdlc.mjs` | `thoughts/AGENTS.md` installs with `copyIfMissing`, which overwrites under `--force`; `thoughts/docs/INDEX.md` uses `copyIfAbsent`, which never does | `bin/sdlc.mjs:640-656`, `bin/sdlc.mjs:782-783` | `copyIfAbsent` is the existing, tested treatment AC-002/AC-012 ask for |
| `README.md` | `--force` is the documented upgrade path, followed by "re-add your gates and target paths" | `README.md:377` | Today's upgrade destroys configuration; `.agents/` placement removes the file from every path setup rewrites |
| `lib/doctor.mjs` | Config is collected once into the shared inspection context and exposed as `context.config` | `lib/doctor.mjs:561-565` | One collection point already exists; no new read is introduced by carrying it forward |
| `lib/doctor.mjs` | `inspection` (which holds `context`) is defined **non-enumerable**, so `sdlc doctor --json` carries no configuration at all | `lib/doctor.mjs:914-927` | AC-003 requires an explicit enumerable `config` projection on the doctor result |
| `lib/doctor.mjs` | Config errors are merged into `errors` but `state` is computed only from artifacts and Beads | `lib/doctor.mjs:679`, `lib/doctor.mjs:494-525` | An invalid configuration currently reports `healthy`; guards accept it. AC-005 needs an explicit blocking path |
| `lib/guard.mjs` | Accepted result is a flat one-line `key=value` field set; there is no `--json` and no config field | `lib/guard.mjs:76-89`, `bin/sdlc.mjs:307-325` | Scalars (`mergeSlot`, `beadsMode`) fit the one-line contract; lists (gates) need an opt-in `--json` |
| `lib/snapshot.mjs` | Snapshot exposes `beads.mode` only, from `context.config` | `lib/snapshot.mjs:276-284` | `/sdlc-next` and `/sdlc-queue` can carry the config projection for free |
| `lib/review-packet.mjs` | Reviewer defaults use the magic key `config.reviewers['all targets']`; every entry point throws on `config.errors` | `lib/review-packet.mjs:113-115`, `:173`, `:294`, `:356` | The magic key is a Markdown artifact and should resolve at read time |
| `lib/review-packet.mjs` | Step packets already carry resolved `gates` and `constraints`; review packets already resolve reviewers and lanes in the CLI | `lib/review-packet.mjs:366-377`, `:203-256` | `/sdlc-implement` and the review lane are already free under AC-003 |
| `bin/sdlc.mjs` | `sdlc review` consumes `reviewEditor`/`localPreview`/`previewUrl` inside the CLI | `bin/sdlc.mjs:547-599` | Machine-scoped settings never enter a model context; the overlay is a pure CLI concern |
| `skills/*` | Model-read settings: `Targets` (`skills/sdlc-ticket/SKILL.md:17`), `Quality gates` (`skills/sdlc-plan/SKILL.md:116`), `Beads merge slot` (`skills/sdlc-land/SKILL.md:51`, `skills/sdlc-chore/SKILL.md:131`), editor/preview (`skills/sdlc-review/SKILL.md:40,44-50`) | skill text | `/sdlc-plan` and `/sdlc-land` have a guard to ride; `/sdlc-ticket` and `/sdlc-chore` run no guard at all (AA-004) |
| `template/thoughts/AGENTS.md` | Values (`:13-25`) and the prose that explains their semantics (`:9-11`, `:27-32`) sit in one section | file text | AC-001 keeps the prose, deletes the values, and the section must be *renamed* or the legacy detector fires on every fresh install |
| `template/agents/*.md` | Reviewer profiles cite "Project Configuration" for lanes and frontend constraints | `backend-code-reviewer.md:15,25,36`; `frontend-code-reviewer.md:15,18,25,37,59`; `general-code-reviewer.md:18,41` | Prose sweep is part of the move, not optional polish |
| `test/*` | Markdown config fixtures exist in four suites | `gates.test.mjs:13,40,56,75,90,100,107`; `doctor.test.mjs:90,425,503,916`; `resume.test.mjs:29`; `review-packet.test.mjs:18` | Fixture migration must land in the same step as the reader rewrite or the suite is red between steps |
| `package.json` | Zero runtime dependencies; `files` ships `bin/ docs/ lib/ skills/ template/` | `package.json` | The validator is hand-written; `template/sdlc.template.json` ships without a `files` change |
| `test/setup.test.mjs` | Asserts the generated contract stays under 1000 words | `test/setup.test.mjs:37` | Removing values keeps that budget; the assertion stays valid |

## Implementation Steps

### Step 1 - JSON schema authority, reader, overlay, provenance

Covers: AC-001, AC-005, AC-006, AC-007, AC-009, AC-010
Files:
- lib/config-schema.mjs
- lib/config.mjs
- lib/review-packet.mjs
- lib/index.mjs
- test/config.test.mjs
- test/gates.test.mjs
- test/doctor.test.mjs
- test/resume.test.mjs
- test/review-packet.test.mjs
Depends on: none
Parallelizable: no

`lib/config-schema.mjs` is the single authority: one entry per supported key
carrying `type`, `required`, `default`, `localOverridable`, `description`, and
`example`. Steps 4 and 5 render the template and the reference document from it;
nothing else may declare the key set.

Canonical shape, `version: 1`:

```json
{
  "version": 1,
  "targets": [
    { "name": "app", "paths": ["src/**", "test/**"], "gates": ["npm run test:app"], "reviewers": ["backend-code-reviewer"] }
  ],
  "gates": ["npm test"],
  "reviewers": ["backend-code-reviewer"],
  "productDocs": "thoughts/docs/",
  "frontendConstraints": "none",
  "beads": { "mode": "embedded", "mergeSlot": "off" },
  "local": {
    "reviewEditor": "code {worktree}",
    "preview": { "command": "npm run dev -- --port {port}", "url": "http://localhost:{port}" }
  },
  "models": {
    "defaults": { "tier": "balanced", "effort": "medium" },
    "roles": { "plan-reviewer": { "tier": "frontier", "effort": "high" } },
    "tiers": { "claude": { "frontier": "inherit", "balanced": "sonnet", "cheap": "haiku" } }
  }
}
```

Load-bearing choices:

1. **`targets` is an ordered array of objects, not an object keyed by name.**
   Declaration order is the precedence input `classifyTargetPath` already uses
   (`lib/config.mjs:205-207`); an array states it explicitly, avoids the
   integer-like-key ordering hazard, and makes a duplicate target name
   *detectable* - duplicate JSON object keys are silently last-wins and no
   validator can see them. Per-target `paths`/`gates`/`reviewers` nest under
   their target, so a gate or path for an undeclared target is unrepresentable.
2. **`local` is the machine-scoped block.** It may appear in either file. The
   local overlay may contain only `version`, `local`, and `models`; any other
   top-level key is refused *by name*. The boundary is structural, not a
   hand-maintained deny-list, so it cannot drift out of step with the schema
   (AC-009). Merge is deep for `local` and `models` (leaf-wise), whole-value
   replacement for arrays and scalars.
3. **Resolution happens at read time.** `readProjectConfig(root)` keeps its
   current return keys - `targets`, `qualityGates`, `targetGates`,
   `targetPaths`, `reviewers`, `productDocs`, `frontendConstraints`,
   `beadsMode`, `mergeSlotEnabled`, `reviewEditor`, `localPreview`,
   `previewUrl`, `errors` - so `gates.mjs`, `doctor.mjs`, `snapshot.mjs`,
   `review-packet.mjs` and `bin/sdlc.mjs` need no change. Additions:
   `version`, `path`, `localPath`, `defaultReviewers`, `models`, and
   `sources` (dotted field path -> repository-relative file, AC-010).
   `reviewers` becomes fully resolved per target, which retires the
   `'all targets'` magic key; `reviewerMap` (`lib/review-packet.mjs:111-128`)
   loses its default branch and keeps its `general-code-reviewer` fallback.
4. **`errors` stays `string[]`**, since three call sites join or splice it
   (`gates.mjs:155`, `review-packet.mjs:173,294,356`, `doctor.mjs:566`). Every
   message names file, dotted field path, and offending value:
   `.agents/sdlc.json: beads.mode "cluster" is not one of embedded|server.`
5. **Validation** (hand-written; no new dependency): unknown `version`; unknown
   key at any level; missing/duplicate/malformed target name
   (`^[a-z][a-z0-9-]*$`); empty or whitespace-only gate command; empty glob;
   `beads.mode` outside `embedded|server`; `beads.mergeSlot` outside `off|on`;
   `models.*.effort` outside `low|medium|high`; a role tier absent from a
   declared host's tier map (named with role, tier and host); a host outside
   `claude|codex|pi`; a local file carrying a shared-only key.
6. **A missing `.agents/sdlc.json` is an error, not silent defaults.** Every
   gate and lane input now lives there; absence must refuse rather than quietly
   disable gates and lane classification (AA-002).
7. **Gate commands are opaque strings.** JSON carries backticks, pipes,
   semicolons and `->` natively; the reader never tokenizes, splits or requotes
   (AC-007).
8. `resolveModelPolicy(config, host)` returns `{ role: { model, effort, tier,
   source } }` for the active host and is exported for AC-006. Nothing consumes
   it yet - see Step 5's boundary.

Delete the Markdown grammar in the same commit, keeping only
`detectLegacyConfigSection()` (Step 2). Migrate the four existing fixture
suites to write `.agents/sdlc.json`; `test/config.test.mjs` covers every
validation case above, overlay precedence, provenance, the shell-metacharacter
round trip, and duplicate-target detection.

### Step 2 - Refuse invalid and legacy configuration before any stage runs

Covers: AC-003, AC-004, AC-005
Files:
- lib/config.mjs
- lib/doctor.mjs
- lib/guard.mjs
- lib/snapshot.mjs
- test/config.test.mjs
- test/doctor.test.mjs
- test/guard.test.mjs
Depends on: step 1
Parallelizable: no

1. `detectLegacyConfigSection(root)` reads `thoughts/AGENTS.md` and matches only
   `^##[ \t]+Project Configuration[ \t]*$`, returning the bold field labels it
   finds. It never parses values. A hit becomes a `readProjectConfig` error
   naming `.agents/sdlc.json`, `template/sdlc.template.json`, and the settings
   to move (AC-004).
2. `inspectDoctor` gains an enumerable `config` projection - resolved values,
   `sources`, `path`/`localPath`, and `errors` - so `sdlc doctor --json` carries
   configuration without a second read (AC-003).
3. Invalid or legacy configuration makes doctor `state = blocked` with the
   config errors first. This closes the gap at `lib/doctor.mjs:677` where config
   errors were reported but did not affect state.
4. `evaluateGuard` refuses **before** any stage matrix runs with
   `code=config-invalid`, `recovery=sdlc config`, carrying every config error as
   context (tranche 1's T1.6 full-error rule). Accepted lines gain the scalars
   the stages need: `mergeSlot=on|off` and `beadsMode=embedded|server` for
   `land` and `implement`.
5. `sdlc guard <stage> <NNN> --json` returns the guard result plus a
   stage-scoped `config` projection: `plan` gets `targets`, resolved gates for
   the ticket's target, `productDocs`, `frontendConstraints`; `implement`/`land`
   get gates, `beads`, and the target map. The default output stays exactly one
   line, so no stage that does not need lists pays for them.
6. `buildSnapshot` carries the same projection under a top-level `config` key
   for `/sdlc-next` and `/sdlc-queue`.

Fixture tests: legacy section refusal, invalid-config refusal for all five
stages, `blocked` state with config errors first, guard `--json` per stage, and
snapshot schema stability with the new key.

### Step 3 - `sdlc config`, setup install, ignore entry, setup refusal

Covers: AC-002, AC-003, AC-004, AC-008, AC-012
Files:
- bin/sdlc.mjs
- test/setup.test.mjs
- test/config.test.mjs
Depends on: step 1
Parallelizable: no

1. `sdlc config [--json] [--field <dotted.path>]`. Text form prints one
   `key=value (source)` line per effective setting - the same resolved shape
   `--json` returns (AC-003, AC-010). `--field` narrows the output so the two
   lanes that must call it pay a single short line. Exit 1 with the config
   errors when configuration is invalid, legacy, or missing.
2. Setup installs `.agents/sdlc.json` from `template/sdlc.template.json` with
   `copyIfAbsent`, matching `thoughts/docs/INDEX.md` (`bin/sdlc.mjs:783`).
   `--force` cannot reach it (AC-002, AC-012).
3. Setup ensures `.agents/sdlc.local.json` is ignored: create `.gitignore` when
   absent, otherwise append only when no existing line already ignores the path
   (exact trimmed match against the bare and `/`-prefixed forms), so reruns
   never duplicate the entry (AC-008).
4. Setup refuses, before any file write and next to the existing Beads
   capability check, when `thoughts/AGENTS.md` still carries
   `## Project Configuration`. The message names the file to write, the shipped
   template, and each setting found (AC-004, AA-003).
5. The closing "Next steps" block points at `.agents/sdlc.json` instead of the
   contract section.

Setup fixture tests: template installed when absent; a hand-edited
configuration is byte-identical after `setup --force`; ignore entry created
once and not duplicated across two runs; legacy section refuses with a
non-zero exit and no writes; `sdlc config --json` matches
`readProjectConfig` on the same fixture.

### Step 4 - Shipped template and generated reference, checked for drift

Covers: AC-011, AC-012, AC-013
Files:
- scripts/render-config-reference.mjs
- template/sdlc.template.json
- docs/configuration.md
- package.json
- test/config-reference.test.mjs
Depends on: step 1
Parallelizable: yes

`scripts/render-config-reference.mjs` renders both `template/sdlc.template.json`
(every supported key with its representative value) and `docs/configuration.md`
(one row per key: type, required, default when omitted, local-overridable, and
a working example, plus the overlay rules and the legacy-migration mapping) from
`lib/config-schema.mjs`. Exposed as `npm run config:docs`.

`test/config-reference.test.mjs` re-renders in memory and asserts byte equality
with both committed files, and additionally asserts that the shipped template
resolves through `readProjectConfig` with zero errors. Adding or renaming a key
in one place therefore fails the suite instead of shipping documentation for a
field the code no longer has (AC-013). A reader can write a valid configuration
from `docs/configuration.md` alone (AC-011).

`package.json` gains the script; `files` already ships `docs/`, `template/` and
`scripts/` is not published, so no packaging change is required beyond the
script entry.

### Step 5 - Contract, skills, and reviewer-profile migration

Covers: AC-001, AC-003, AC-006
Files:
- template/thoughts/AGENTS.md
- skills/sdlc-ticket/SKILL.md
- skills/sdlc-plan/SKILL.md
- skills/sdlc-land/SKILL.md
- skills/sdlc-chore/SKILL.md
- skills/sdlc-review/SKILL.md
- skills/sdlc-implement/SKILL.md
- template/agents/backend-code-reviewer.md
- template/agents/frontend-code-reviewer.md
- template/agents/general-code-reviewer.md
- test/setup.test.mjs
- test/skills.test.mjs
Depends on: step 2, step 3
Parallelizable: no

1. `template/thoughts/AGENTS.md`: delete the twelve value lines
   (`:13-25`) and **rename** the section to `## Configuration`, keeping the
   prose that explains gate ordering, target-path overlap, Beads mode and the
   merge slot, and pointing at `.agents/sdlc.json` plus `sdlc config`. The
   rename is required: a section still titled `Project Configuration` would
   trip Step 2's legacy detector on every fresh install.
2. Skills read configuration from the call they already make:
   - `/sdlc-plan` uses `sdlc guard plan {NNN} --json` for gates, targets and
     constraints - the same single call it makes today;
   - `/sdlc-land` reads `mergeSlot=` from its existing accepted guard line;
   - `/sdlc-implement` keeps step-packet `gates`/`constraints` and reads
     `mergeSlot=`/`beadsMode=` from its guard line;
   - `/sdlc-review` states that the CLI resolves editor and preview, and that
     they may be overridden in `.agents/sdlc.local.json`;
   - `/sdlc-ticket` and `/sdlc-chore` run exactly one `sdlc config --field
     targets` / `sdlc config --json` at their start. They have no guard to ride
     (AA-004).
3. Reviewer profiles cite `.agents/sdlc.json` (`targets[].paths`,
   `targets[].reviewers`, `frontendConstraints`) instead of
   "Project Configuration".
4. `models` is documented as reserved policy: the schema validates and resolves
   it, and `sdlc config` reports it. Rendering reviewer profiles from it and
   `sdlc models <role>` (research R5.4) stay out of scope, so
   `CODEX_AGENT_MODELS`/`CODEX_AGENT_REASONING_EFFORTS` are untouched here.

Verify no skill, profile, or template still names the removed section, and that
the regenerated contract stays under the 1000-word budget asserted at
`test/setup.test.mjs:37`.

### Step 6 - Documentation, migration note, release

Covers: AC-001, AC-004, AC-011
Files:
- README.md
- docs/under-the-hood.md
- package.json
- skills/*/SKILL.md (frontmatter versions via bump script)
Depends on: step 4, step 5
Parallelizable: no

Rewrite `README.md` "Configure a project" around `.agents/sdlc.json` with the
setting table pointing at `docs/configuration.md`, document the overlay and its
machine-scoped boundary, and add a **0.6.0 migration** section: move the twelve
settings by hand, delete the `## Project Configuration` section, rerun setup
with `--force`, and note that setup refuses until the section is gone. Correct
`README.md:377`, which currently tells the reader to re-add gates after
`--force`.

`docs/under-the-hood.md`: replace §Project Configuration with the JSON file plus
overlay and provenance, update the `config.mjs` row in the module table
(`:564`), add `.agents/sdlc.json` and `.agents/sdlc.local.json` to the
operational-files list, and record that invalid configuration blocks doctor and
every guard. Release with `npm run bump:minor` (0.6.0), which keeps skill
frontmatter versions in step with `package.json`.

## Quality Gates

- `npm test` (`node --test` over `test/*.mjs`) after every step
- Fixture-repository integration tests for every new CLI surface and for setup
  behaviour (steps 2, 3, 4)
- `npm run config:docs` produces no diff (enforced by
  `test/config-reference.test.mjs`)

## Verification

| ID | Exercise | Expected outcome |
|---|---|---|
| AC-001 | Fixture project with only `.agents/sdlc.json`; run `sdlc gates`, `sdlc review-packet --json`, `sdlc doctor --json` | Every setting resolves from JSON; generated contract contains no value lines but retains the semantics prose |
| AC-002 | Hand-edit `.agents/sdlc.json`, run `sdlc setup --force --claude` | File bytes unchanged; contracts, skills, profiles and prime refreshed |
| AC-003 | Per stage, count config-motivated tool calls before/after | plan/approve/implement/review/land: zero additional calls (guard, doctor, snapshot, packets carry it); ticket/chore: exactly one `sdlc config`; `sdlc config --json` equals the projection embedded in guard `--json` |
| AC-004 | Fixture carrying `## Project Configuration`; run setup, doctor, any guard | All refuse, naming `.agents/sdlc.json`, the shipped template, and the settings found; nothing is read from Markdown; `grep` finds no Markdown grammar in `lib/` |
| AC-005 | Fixtures: `beads.mode: "cluster"`; duplicate target; empty gate string; unknown key; unknown target via `sdlc gates --target api` | Each refused before any gate runs, naming file, dotted field and value; guard exits with `code=config-invalid` |
| AC-006 | Configuration carrying the full R5.1 models block; `sdlc config --json` | Validates; `resolveModelPolicy` returns model+effort per role for each of claude/codex/pi; a role tier missing for a declared host is refused by role, tier and host |
| AC-007 | Gate `` node -e "console.log(`a|b;c->d`)" `` configured and run | Executes byte-identical to the configured string; `sdlc config` and the guard projection round-trip it unchanged |
| AC-008 | Add `.agents/sdlc.local.json`, run setup twice, run the pipeline with and without the file | Ignore entry present exactly once; `git status` clean; pipeline behaves identically apart from the overridden values |
| AC-009 | Local file containing `gates`, `targets`, `beads`, `reviewers` | Each refused by name; `local` and `models` accepted and applied |
| AC-010 | Shared + local files setting `local.reviewEditor`; `sdlc config`, `sdlc doctor --json`, `sdlc guard <stage> --json` | Every effective setting reports its producing file; the overridden one names `.agents/sdlc.local.json` |
| AC-011 | Write a fresh configuration using only `docs/configuration.md` | Valid on first read; every key's type, requiredness, default, override scope and example present |
| AC-012 | Fresh `sdlc setup` in an empty repository | `.agents/sdlc.json` installed from `template/sdlc.template.json`; template carries every supported key and resolves with zero errors |
| AC-013 | Add a key to `lib/config-schema.mjs` only; run `npm test` | Fails until template and reference are regenerated; `npm run config:docs` makes it pass |

## Approval Attention

| ID | Operation or decision | Why attention is required | Timing | Status |
|---|---|---|---|---|
| AA-001 | Breaking configuration-contract change at pre-1.0 | Every existing project must move roughly a dozen settings by hand; no automated migration ships | Steps 1, 5, 6 | approved |
| AA-002 | A missing `.agents/sdlc.json` becomes an error, not silent defaults | A project that never configured anything stops working until it writes the file; the alternative silently disables gates and lane classification | Step 1 | approved |
| AA-003 | `sdlc setup` refuses while a legacy section remains | Setup is the upgrade path, so refusal blocks refreshing skills until the human migrates; deliberate per AC-004 | Step 3 | approved |
| AA-004 | AC-003 deviation: `/sdlc-ticket` and `/sdlc-chore` each gain one `sdlc config` call | Neither lane invokes a guard, so no existing call can carry configuration; the free contract read they used disappears with the values. Mitigated by `--field` and by chore already making three CLI calls | Step 5 | approved |
| AA-005 | AC-005 interpretation: nesting makes "target referenced by gates/paths/reviewers but never declared" unrepresentable | The error class is kept where a target name still arrives from outside the file - `--target` flags and plan/ticket `Target:` frontmatter - and duplicate-target detection replaces it inside the file | Step 1 | approved |
| AA-006 | Setup writes to the project's `.gitignore` | Modifies a user-owned file; idempotent, single-line append only | Step 3 | approved |
| AA-007 | New public CLI surface: `sdlc config`, `sdlc guard --json`, `config` keys on doctor/snapshot JSON | External contract; consumers may script against it | Steps 2, 3 | approved |
| AA-008 | `models` ships validated but unconsumed | Reserved for research R5.4/R5.5; a reader may expect it to change reviewer models today | Steps 1, 5 | approved |
| AA-009 | Release is a minor bump (0.6.0) despite being breaking | Pre-1.0 convention in this repository; migration note carries the break | Step 6 | approved |

All nine items were resolved together by an explicit human decision on
2026-07-26, after the implementation was complete and demonstrated, and
before landing.

## Open Questions

- **Is `Beads mode` machine-scoped?** (ticket Open Question 1) This plan
  implements AC-009 as written: shared, refused in the local file. Revisit when
  a genuine multi-writer project exists; moving it later is a one-line schema
  change plus a reference regeneration.
- ~~The ticket is `Status: draft`; `Source Ticket Hash` must be re-recorded
  after the status flip.~~ Resolved 2026-07-26: the ticket is `approved` and
  `Source Ticket Hash` above is re-recorded against it.
- Whether `sdlc config --field` should accept multiple paths in one call. Only
  matters if a third lane without a guard appears; deferred.

## Plan Critique

Pass 1 Verdict: DEGRADED

No independent `plan-reviewer` context was available in this session, so this
records a degraded critique rather than inventing approval. `lib/artifacts.mjs`
treats `DEGRADED` as requiring explicit human resolution before approval, which
is the intended state: run one independent pass before `/sdlc-approve 002`.
Self-review found and fixed three issues before the steps were written:

- PC-001 [fixed]: renaming the contract section was missing, so the legacy
  detector in Step 2 would have refused every freshly generated project.
  Disposition: Step 5.1 renames the section to `## Configuration`.
- PC-002 [fixed]: config errors reach `doctor.errors` but not `doctor.state`
  (`lib/doctor.mjs:679`, `:494-525`), so AC-005's "before any stage runs" was
  not satisfied by reporting alone. Disposition: Step 2.3-2.4 add the blocked
  state and the pre-matrix guard refusal.
- PC-003 [fixed]: fixture migration was originally a separate late step, which
  would have left `npm test` red between steps. Disposition: folded into
  Step 1.

Run one independent critique before `/sdlc-approve 002`; the ticket's own
AC-003 and AC-005 tensions (AA-004, AA-005) are the two findings most worth an
adversarial second opinion.

### Pass 1 resolution

Resolved by explicit human decision on 2026-07-26. No independent
`plan-reviewer` context was available, so the `DEGRADED` verdict was resolved
by the human rather than upgraded by a second model pass, which is the
disposition `lib/artifacts.mjs` requires. Implementation then surfaced two
findings the critique had missed:

- PC-004 [fixed]: **PC-002's premise is false.** Config errors already reached
  `doctor.state`: `createDoctorInspectionContext` seeds `errors` from
  `config.errors`, `inspectDoctor` pushes `shared.errors` into its own list,
  and `state` is `invariantErrors ? 'blocked' : artifactState.state`. The
  pre-existing test `doctor rejects invalid native coordination configuration
  values` already asserted `blocked` for a bad `beads.mode`. Only the
  *ordering* was wrong. Disposition: one added push in `inspectDoctor` puts
  config and legacy errors first; no second blocking path was built.
- PC-005 [fixed]: the step order in this plan is not executable as written.
  Step 3 installs `template/sdlc.template.json`, which Step 4 generates, so
  Step 4 must run first (both depend only on Step 1, and Step 4 is already
  marked parallelizable). Step 3 also had to absorb Step 5.1's contract
  rename, because its own legacy-section refusal would otherwise fire on the
  contract that setup itself installs - which is PC-001, mis-scoped to Step 5.
  Disposition: executed as 1, 2, 4, 3, 5, 6.
