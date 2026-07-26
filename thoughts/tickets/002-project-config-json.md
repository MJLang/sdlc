---
Status: approved
Tags: [sdlc, config, setup, cli, contracts]
Type: refactor
Target: sdlc
---

# Ticket 002 - Move project configuration into `.agents/sdlc.json`

## Summary

Project configuration lives in the `## Project Configuration` section of the generated `thoughts/AGENTS.md`, which mixes setup-owned prose with user-owned values in one file. Two costs follow.

First, configuration is destroyed on the documented upgrade path. `bin/sdlc.mjs:781` installs the contract with `copyIfMissing`, which overwrites when `--force` is set (`bin/sdlc.mjs:640`); `README.md:377` presents `--force` as the way to refresh contracts and skills, then instructs the user to re-add their gates and target paths afterward. Setup never writes sibling files under `.agents/` — only `.agents/skills/<name>` (`bin/sdlc.mjs:798-812`) — so a configuration file there is structurally out of reach of `--force` rather than protected by a special case.

Second, the format needs a bespoke parser. `lib/config.mjs` is roughly 210 lines of Markdown grammar carrying two legacy compatibility paths — the heading-absent whole-document fallback (`lib/config.mjs:30`) and the literal-line grammar (`lib/config.mjs:130-139`) — plus per-field splitting rules that deliberately disagree, since gate mappings must never split on semicolons while target paths must (`lib/config.mjs:60-70`). Correctness depends on which helper each field happens to route through. A structured file removes that class of defect, and keying gates, paths and reviewers under their target makes the unknown-target error (`lib/config.mjs:144-145`) unrepresentable.

`thoughts/research/001-workflow-friction.md` §5 (R5.1-R5.5) already argues `.agents/` is the correct host-neutral home and proposes the role→tier→model block. This ticket widens that move from the models block to the whole configuration so the migration happens once.

A shared repository also needs somewhere personal settings can live. The review editor, the local preview command and port, and model policy describe the developer's machine, not the project, and today a second developer editing them dirties a tracked file. A Git-ignored `.agents/sdlc.local.json` overlay solves that, but only if its reach is bounded: quality gates, target paths, reviewers and the merge slot are what the pipeline enforces before landing, so allowing an ignored, invisible file to weaken them would make those gates optional in exactly the case — shared work — where they matter most.

The change has a further cost to pay deliberately: several settings are read by the model rather than by code — `Targets` (`skills/sdlc-ticket/SKILL.md:17`), `Quality gates` (`skills/sdlc-plan/SKILL.md:116`), `Beads merge slot` (`skills/sdlc-land/SKILL.md:51`, `skills/sdlc-chore/SKILL.md:131`) — and are free today because a skill reading the contract receives them in the same read. Resolved configuration must therefore be delivered through calls skills already make, or the pipeline trades a parser defect for extra reads on its hottest paths.

## Scope

**In scope:** `.agents/sdlc.json` as the shared project-configuration authority; a Git-ignored `.agents/sdlc.local.json` overlay restricted to machine-scoped settings; migration of every field currently parsed from `## Project Configuration` (targets, quality gates, target gates, target paths, reviewers, product docs, frontend constraints, Beads mode, Beads merge slot, review editor, local preview, preview URL); a schema that also accommodates the R5.1 role→tier→model block so no second migration is needed; field-level validation; delivery of resolved configuration through commands skills already invoke plus a direct `sdlc config` surface; deletion of the Markdown configuration grammar from `lib/config.mjs`, retaining only a heading-level check that detects a legacy section and refuses rather than ignoring it; removal of the configuration values from the generated contract while keeping the prose that explains their semantics; an exhaustive `template/sdlc.template.json` shipped in the package; a complete configuration reference in `docs/`, kept in step with the schema automatically; corresponding updates to `README.md` and `docs/under-the-hood.md`.

**Out of scope:** per-plan declarations, including `Isolation:` from `thoughts/design/workflow-simplification.md` T1.2, which stay in plan frontmatter where the approval hash covers them; any automated migration, since an existing project rewrites roughly a dozen configuration lines by hand and the release is breaking at pre-1.0; the review-profile and threat-model declaration (research R4.1); any change to which gates run, to gate execution semantics, to human gates, or to reproducible approvals.

## Acceptance Criteria

- AC-001: A project declares its complete shared configuration in one file, `.agents/sdlc.json`. Every setting previously read from `## Project Configuration` resolves from it, and the generated contract carries no configuration values while retaining the prose that explains what the settings mean.
- AC-002: `sdlc setup --force` refreshes generated contracts, skills, reviewer profiles and managed prime while leaving an existing project configuration byte-identical.
- AC-003: No pipeline stage pays an additional read for configuration: resolved configuration is present in the JSON surfaces skills already invoke, and `sdlc config [--json]` returns the same resolved shape for direct use.
- AC-004: A project still carrying `## Project Configuration` is told so rather than silently losing its settings: setup and doctor detect the leftover section and refuse, naming the file to write and the settings to move. No configuration is read from Markdown, and the Markdown grammar no longer ships.
- AC-005: Invalid configuration is refused before any stage runs, naming the offending field and value — at minimum an out-of-range enum, a target referenced by gates, paths or reviewers but never declared, and an empty gate command.
- AC-006: A role→tier→model policy per research §5 validates against the same schema and resolves per host, so adopting it later requires no second migration and no format change.
- AC-007: A gate command containing shell metacharacters — backticks, pipes, semicolons, `->` — round-trips through configuration and executes unmodified.
- AC-008: `.agents/sdlc.local.json` overrides the shared file for the current checkout and is never committed: setup ensures the ignore entry exists without duplicating it, and the pipeline works identically whether or not the file is present.
- AC-009: A local file may override only settings that describe the machine — review editor, local preview command and URL, and model policy. Targets, target paths, quality gates, target gates, reviewers, Beads mode and the merge slot are refused by name, so an ignored file cannot weaken what the pipeline enforces before landing.
- AC-010: Every effective setting reports which file produced it, so a local override is visible in the same output the stage already reads rather than inferred from behaviour.
- AC-011: A reference document covers every supported setting, giving for each its type, whether it is required, its default when omitted, whether a local file may override it, and a working example. A reader can write a valid configuration from that document alone, without reading `lib/`.
- AC-012: The package ships `template/sdlc.template.json` carrying every supported key with a representative value. Setup installs `.agents/sdlc.json` from it only when absent, matching the treatment `thoughts/docs/INDEX.md` already receives at `bin/sdlc.mjs:782`.
- AC-013: The schema, the shipped template and the reference document describe the same set of keys, checked automatically, so adding or renaming a setting in one place without the others fails rather than shipping documentation that describes a field the code no longer has.

## Open Questions

- Is `Beads mode` machine-scoped or shared? AC-009 refuses it locally because embedded and server modes describe how the shared store is coordinated, but the choice genuinely depends on whether a given developer is a concurrent writer. It is the one field on the boundary and the decision belongs to whoever runs a multi-writer project first.
- Where does this sit relative to tranches 1-3? `thoughts/design/workflow-simplification.md` defers `.agents/sdlc.json` as "cost control, not friction," but at whole-configuration scope it becomes a breaking contract change and wants its own tranche rather than growing tranche 1.

## Documentation Sources

None. `thoughts/docs/INDEX.md` does not exist in this repository; the ticket is grounded in `thoughts/research/001-workflow-friction.md` §5 and `thoughts/design/workflow-simplification.md`.
