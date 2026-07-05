# sdlc

**Ticket → plan → implement → land** — an agentic software development pipeline packaged as [agent skills](https://skills.sh), with a one-command project setup.

Work is defined in a `thoughts/` folder as reviewable markdown artifacts (tickets and plans) with explicit human gates between every phase. Execution state lives in [beads](https://github.com/gastownhall/beads), implementation happens in isolated git worktrees, and every change gets a persisted code review before it merges.

## Quick start

Full project setup (thoughts folder + skills + `AGENTS.md`/`CLAUDE.md` symlinks + beads):

```bash
npx @mlangroman/sdlc setup
```

Skills only, for any of the 40+ agents the [skills CLI](https://www.npmjs.com/package/skills) supports (Claude Code, Cursor, Codex, …):

```bash
npx skills add MJLang/sdlc            # all nine skills
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

The full workflow contract lives in [`template/thoughts/AGENTS.md`](template/thoughts/AGENTS.md) — `setup` copies it to `thoughts/AGENTS.md` in your project, and the skills treat it as the source of truth.

## What `setup` does

Run inside your project directory:

1. `git init` if the directory is not a repository (the pipeline needs branches and worktrees)
2. Creates `thoughts/{tickets,plans,designs,docs,reviews}/` and `thoughts/AGENTS.md`, with a `thoughts/CLAUDE.md → AGENTS.md` symlink
3. Creates a starter root `AGENTS.md` (or adopts an existing root `CLAUDE.md` as `AGENTS.md`) and symlinks root `CLAUDE.md → AGENTS.md`
4. Installs the nine skills into `.claude/skills/`
5. Runs `bd init` if [beads](https://github.com/gastownhall/beads) is installed

Flags: `--force` (overwrite existing files), `--skip-skills`, `--skip-beads`.

## After setup

1. Edit the **Project Configuration** section of `thoughts/AGENTS.md` — this is the one place the skills read per-project values from:
   - **Targets** — the areas of your repo work can land in (e.g. `cms | jobs | web | utils` for a monorepo)
   - **Quality gates** — the commands that must pass after every implementation step (e.g. `pnpm check`)
   - **Reviewers** — map targets to reviewer agents if you have them; otherwise a general code review is used
   - **Product docs** — where tickets ground their summaries (default `thoughts/docs/`)
   - **Frontend constraints** — e.g. "no new pages until the design system exists"
2. Drop your product/vision docs into `thoughts/docs/`
3. Start: `/ticket <your first idea>`

## Requirements

- **git** — worktrees, branches, and (ideally) a remote
- **[beads](https://github.com/gastownhall/beads)** (`bd`) — issue tracking, dependency graphs, and the claim mutex that keeps parallel sessions off the same plan
- An agent that supports skills — built for [Claude Code](https://claude.com/claude-code), installable anywhere the [skills CLI](https://skills.sh) reaches

## Repository layout

```
skills/           one folder per skill (SKILL.md) — what `npx skills add` installs
template/         files copied into your project by `setup`
  thoughts/AGENTS.md   the pipeline contract (workflow instructions)
  AGENTS.root.md       starter root AGENTS.md (beads conventions, session protocol)
bin/sdlc.mjs      the zero-dependency setup CLI
```

## License

MIT
