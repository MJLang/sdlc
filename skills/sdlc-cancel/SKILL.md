---
name: sdlc-cancel
version: 0.5.1
description: Human gate that safely cancels a ticket/plan/Beads/worktree line of work, or cancels only its plan for explicit re-planning, using native ownership and worktree safeguards.
argument-hint: <number> [plan]
disable-model-invocation: true
---

Cancel `$ARGUMENTS` only on explicit human invocation.

Scope is the optional second word:

- default: cancel ticket, plan, epic/issues/gates, worktree, and branch;
- `plan`: cancel only the plan and its execution state; keep the ticket `approved` so `/sdlc-plan {NNN}` can create a replacement while preserving the cancelled artifact.

## Inspect before mutation

Resolve the canonical ticket, plan, latest approval identity, Beads epic/children, open dedicated gates, branch, and native Beads-visible worktree. Handle partial states idempotently.

Require Beads `>=1.1.0` when Beads/worktree state exists. A missing required native capability blocks destructive cleanup; never silently substitute raw Git or issue-label behavior.

Every Beads observation must use `bd --readonly`, including:

```text
bd --readonly show <epic-id> --json
bd --readonly gate list --json
bd --readonly dep list <open-gate-id> --direction=up --type=blocks --json
bd --readonly worktree list --json
bd --readonly orphans --json
```

Show the blast radius and, when any unmerged/dirty/unpushed/stashed work exists, require explicit confirmation after showing:

- worktree dirty status and diff summary;
- commits in the plan branch not represented on main;
- unpublished commits and stashes reported by native worktree safety checks;
- open/claimed children and gate reasons;
- staged memory candidates, noting that cancellation deliberately does not promote them.

Do not interpret the original `/sdlc-cancel` invocation as consent to discard unreported data.

## Actor and removal safety

After confirmation and before the first Beads mutation, establish one unique actor:

```bash
sdlc actor <runtime> --new
```

Capture the literal and carry it unchanged through this invocation. Per the
contract actor invariant, prefix every mutation with
`BEADS_ACTOR="<session-actor>"`; never rely on shell export or an older actor.

1. For a worktree, first run native safe removal:

   ```bash
   BEADS_ACTOR="<session-actor>" bd worktree remove .worktrees/<plan-name>
   ```

   Never fall back to raw `git worktree remove`. If safety checks refuse because of dirty files, unpushed commits, or stashes, stop and show the exact data. Use `--force` only after a second explicit confirmation that names the data that will be destroyed; cancellation is the exceptional destructive path, not normal cleanup.
2. After removal, delete the local branch and its published remote branch. Skip absent pieces and report them. Never delete a branch while its retained worktree still needs recovery.

## Close execution state

1. Resolve each open dedicated gate explicitly under the actor:

   ```bash
   BEADS_ACTOR="<session-actor>" bd gate resolve <gate-id> --reason="cancelled with line of work: <reason>"
   ```

   Then close open child issues and the epic with `--reason="cancelled: <reason>"`. Do not use `bd human respond`, which may close the wrong implementation issue.
2. Claims owned by another unique session do not prove that session is dead. The explicit human cancellation plus confirmed blast radius authorizes closeout, but report the prior actor in the cancellation note.
3. Do not run a memory audit or `bd remember`/`bd forget`. Candidate notes remain on the closed Beads object for possible manual rescue.

## Canonical status commit

Update only canonical primary-main artifacts:

- `plan` scope: plan -> `Status: cancelled`; ticket remains `approved`;
- default: existing plan -> `Status: cancelled`; ticket -> `Status: cancelled`.

Commit only the affected status paths with `git commit --only` as `cancel: <ticket title> (ticket {NNN}) - <reason>`. Do not include unrelated staged/dirty files. Push Git and then `BEADS_ACTOR="<session-actor>" bd dolt push` where remotes exist, and report their results independently.

Reruns reuse the closed objects and status commit and finish only missing push/cleanup work; they never duplicate cancellation commits or notes. Report what existed, what was safely destroyed, what was already absent, prior claim/gates, both push states, and, for plan-only scope, `/sdlc-plan {NNN}` as the next legal transition.
