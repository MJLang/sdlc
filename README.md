# sdlc

**Ticket → plan → implement → land** — an agentic software development pipeline packaged as [agent skills](https://skills.sh), with a one-command project setup.

Work is defined in a `thoughts/` folder as reviewable markdown artifacts (tickets and plans) with explicit human gates between every phase. Execution state lives in [beads](https://github.com/gastownhall/beads), implementation happens in isolated git worktrees, and every change gets a persisted code review before it merges.

## Quick start

Full project setup (thoughts folder + skills + bundled agents + `AGENTS.md`/`CLAUDE.md` symlinks + beads). Choose your agent target; no target keeps the Claude Code-compatible default:

```bash
npx @mlangroman/sdlc setup --claude
npx @mlangroman/sdlc setup --codex
```

Skills only, for any of the 40+ agents the [skills CLI](https://www.npmjs.com/package/skills) supports (Claude Code, Cursor, Codex, …):

```bash
npx skills add MJLang/sdlc            # all ten skills
npx skills add MJLang/sdlc --skill ticket --skill plan   # a subset
```

## The pipeline

| Skill | Transition | Gate |
|---|---|---|
| `/ticket <idea>` | new ticket (`draft`) | — |
| — (hand-edit `Status: approved`) | ticket `draft` → `approved` | **human** |
| `/plan <NNN>` | ticket `approved` → plan (`review`) | — |
| `/approve <NNN>` | plan `review` → `approved`; creates beads epic + step issues | **human** |
| `/implement <NNN>` | executes the plan in its own worktree; ends with a review verdict | — |
| `/review <NNN>` | resolves a worktree, diff, and review artifact for local human inspection | — |
| `/land <NNN>` | squash-merge to main; plan → `merged`, ticket → `implemented` | **human** |
| `/chore <idea>` | lightweight lane: small change end-to-end in one pass | **human** |
| `/cancel <NNN> [plan]` | cancel a line of work (or just the plan, to re-plan) | **human** |
| `/queue` | read-only dashboard: in flight, stalled, awaiting a human | — |
| `/next` | one autonomous pipeline iteration — pair with `/loop` | — |

Design principles:

- **Artifacts over chat.** Tickets say *what and why*; plans say *how*, step by step with an explicit dependency graph. Both are markdown files you review and approve.
- **Humans hold the gates.** Approving a ticket is a deliberate hand-edit. `/approve`, `/land`, `/chore`, and `/cancel` never run on the agent's initiative.
- **Frontmatter records gates; beads records reality.** A file's `Status` only changes at hand-offs. Live progress is always a beads query, never a file edit.
- **Worktree isolation.** Every plan is implemented on its own branch in `.worktrees/<plan-name>`, one commit per step, pushed as each step closes — a crashed session strands nothing.
- **Reviews are artifacts.** Full reviewer output persists to `thoughts/reviews/` and travels with the branch; `/land` refuses to merge without an `APPROVED` verdict for the exact HEAD it is merging.
- **Autonomy without gate-crossing.** `/loop /next` keeps planning and implementing whatever is legal, and queues everything that needs a human.
- **Memory is evidence, not chat history.** Tickets carry durable retrieval tags; planning consults relevant Beads memories and verifies them against the current code before relying on them.

The full workflow contract lives in [`template/thoughts/AGENTS.md`](template/thoughts/AGENTS.md) — `setup` copies it to `thoughts/AGENTS.md` in your project, and the skills treat it as the source of truth.

## What `setup` does

Run inside your project directory:

1. `git init` if the directory is not a repository (the pipeline needs branches and worktrees)
2. Creates `thoughts/{tickets,plans,designs,docs,reviews}/` and `thoughts/AGENTS.md`, with a `thoughts/CLAUDE.md → AGENTS.md` symlink
3. Creates a starter root `AGENTS.md` (or adopts an existing root `CLAUDE.md` as `AGENTS.md`) and symlinks root `CLAUDE.md → AGENTS.md`
4. Installs the ten skills into `.claude/skills/` for Claude Code or `.agents/skills/` for Codex
5. Installs the three code-reviewer agents plus the `pipeline-snapshot` agent into `.claude/agents/` for Claude Code or `.codex/agents/` for Codex
6. Runs `bd init` if [beads](https://github.com/gastownhall/beads) is installed

Flags: `--claude` (the default), `--codex`, `--force` (overwrite existing files), `--skip-skills`, `--skip-agents`, `--skip-beads`. You may pass both `--claude --codex` to install for both.

## The reviewer agents

The review phase is a contract, not a suggestion. `/implement` and `/chore` run every reviewer required by the changed lanes against the same HEAD, validate each component's machine-checkable `Verdict:`, and persist one aggregate artifact per round in `thoughts/reviews/`. The aggregate approves only when every required component approves; its final `Verdict:` line is the machine-readable overall result. `/implement` then records `review: APPROVED sha=...` on the Beads epic, which is the precondition `/land` verifies before merging. Three agents that speak the component contract ship with the package (Claude Code subagents, installed by `setup` — the skills CLI installs skills only):

- **backend-code-reviewer** — holds a backend diff to three bars: ticket intent, plan conformance (silent deviation is a MUST FIX), and repo consistency (harvests conventions from canonical siblings before judging; flags second-ways-of-doing-things, layering violations, speculative generality). Evidence-gated: every MUST FIX cites `file:line`.
- **frontend-code-reviewer** — same three bars for UI work, with design-system consistency as the holistic check (tokens, component reuse, WCAG AA, responsive, anti-patterns). If the [impeccable](https://skills.sh) skill is installed it drives impeccable's audit and critique as its quality engine; otherwise it runs the equivalent checks from source and says so in the report.
- **general-code-reviewer** — the stack-neutral fallback for an unmapped target or lane. It enforces ticket intent, plan conformance, repository consistency, universal correctness risks, and the same exact `Verdict:` contract without pretending to provide a specialist audit.

All three are read-only, run in enforcing mode (canon exists) or establishing mode (greenfield — precedent-setting choices are flagged for human ratification), and return MUST FIX / NIT findings. `setup --claude` installs Claude Code definitions; `setup --codex` generates read-only Codex custom-agent profiles pinned to `gpt-5.6` (Sol) with high reasoning effort. Map targets to the specialists in the **Reviewers** line of `thoughts/AGENTS.md`; an unmapped changed lane automatically uses `general-code-reviewer`. A missing required profile fails closed instead of falling back to an anonymous reviewer.

For a mixed diff, the parent deduplicates and runs all required reviewers against one expected SHA, rechecks that the worktree stayed clean and unmoved, embeds their reports verbatim in deterministic reviewer-name order, and appends the overall verdict last. A blocked or malformed component blocks the round, and all required reviewers rerun after any fix because the reviewed HEAD changed.

`pipeline-snapshot` is the read-only fact-gatherer used by `/next` and `/queue`: it is configured for Haiku in Claude Code and `gpt-5.6-luna` with medium reasoning effort in Codex. It returns a compact table only; the parent agent makes every pipeline decision.

## Tagged project memory

Tickets carry 2–5 stable, lowercase tags: the target plus useful domain or technology terms, such as `db`, `postgres`, and `data`. Plans inherit those tags and may add planning-specific ones.

When planning, the pipeline queries Beads with each tag, recalls only candidates whose stated scope applies, and records the memories that materially informed the plan in a **Relevant Memories** section. This keeps past decisions useful without treating a keyword match as a rule.

After an approved implementation or chore review, the pipeline audits the matching memories. It keeps accurate guidance, refreshes changed advice, merges duplicates, forgets only facts proven obsolete, and records durable new decisions or footguns. Entries have a stable key plus structured `Tags`, `Index`, `Finding`, `Why`, `Applies when`, and `Source` fields, making retrieval precise and the audit trail explicit.

## Local human review

After `/implement <NNN>` has an approved automated review, use `/review <NNN>` in your coding agent or run `sdlc review <NNN>` from the primary checkout. It resolves the matching worktree and presents its ticket, plan, branch SHA, diff stat, latest review artifact, and status—without changing the branch or pipeline state. You never have to locate the hidden `.worktrees/` path yourself.

Optional actions require an explicit flag:

```bash
sdlc review 023
sdlc review 023 --editor
sdlc review 023 --artifact
sdlc review 023 --diff
sdlc review 023 --preview
```

Configure editor and preview support per project in `thoughts/AGENTS.md`:

```md
- **Review editor:** `zed {worktree}`
- **Local preview:** `npm run dev -- --port {port}`
- **Preview URL:** `http://localhost:{port}`
```

`--preview` is the only action that starts a process. It starts the configured server in the worktree on port 4173 by default (or `--port <number>`) and returns the preview URL. `/land <NNN>` remains the explicit human merge gate; `/review` does not record an approval.

## After setup

1. Edit the **Project Configuration** section of `thoughts/AGENTS.md` — this is the one place the skills read per-project values from:
   - **Targets** — the areas of your repo work can land in (e.g. `cms | jobs | web | utils` for a monorepo)
   - **Quality gates** — the commands that must pass after every implementation step (e.g. `pnpm check`)
   - **Reviewers** — map targets to specialist reviewer agents; an unmapped lane uses `general-code-reviewer`
   - **Product docs** — where tickets ground their summaries (default `thoughts/docs/`)
   - **Frontend constraints** — e.g. "no new pages until the design system exists"
   - **Review editor / Local preview / Preview URL** — optional local-review integrations used by `sdlc review`
2. Drop your product/vision docs into `thoughts/docs/`
3. Start: `/ticket <your first idea>`

## Requirements

- **git** — worktrees, branches, and (ideally) a remote
- **[beads](https://github.com/gastownhall/beads)** (`bd`) — issue tracking, dependency graphs, and the claim mutex that keeps parallel sessions off the same plan
- **Node.js 18+** — for the setup and local-review CLI
- An agent that supports skills — built for [Claude Code](https://claude.com/claude-code), installable anywhere the [skills CLI](https://skills.sh) reaches

## Releasing

Every skill has a frontmatter version aligned with `package.json`. Use the supplied commands to bump both together:

```bash
npm run bump:patch
npm run bump:minor
```

## Repository layout

```
skills/           one folder per skill (SKILL.md) — what `npx skills add` installs
template/         files copied into your project by `setup`
  thoughts/AGENTS.md   the pipeline contract (workflow instructions)
  AGENTS.root.md       starter root AGENTS.md (beads conventions, session protocol)
  agents/              backend/frontend/general reviewers + pipeline-snapshot
scripts/          release-version helpers
bin/sdlc.mjs      setup and local-review CLI
```

## License

MIT
