---
name: sdlc-queue
version: 0.5.1
description: Format the deterministic read-only pipeline snapshot as a compact human dashboard.
---

Build the dashboard without editing files, Git, or Beads. Run exactly one fact
collection command:

```bash
sdlc snapshot --view=queue --json
```

Do not spawn a subagent, run per-number doctor, issue additional Beads/Git
queries, or reimplement eligibility. The snapshot is authoritative for this
view and already includes canonical identities, native gates/ready work,
worktree Git corroboration, stale/orphan/escalation evidence, overlap, health,
and optional merge-slot state.

Format its non-empty `sections` in this order, one compact line per item:

1. **Needs you now** — preserve each stable code and exact supplied action.
2. **In flight** — progress, owner, doctor state, worktree path/HEAD, dirt,
   unpushed commits, stashes, and last Git activity when present.
3. **Ready to start** — only snapshot entries with `eligible=true`; show the
   exact `/sdlc-plan` or `/sdlc-implement` command.
4. **Drafts** — ticket path and the explicit ticket-approval action.
5. **Recently landed** — ticket, commit, and title.

Show rejection reasons and overlap evidence without translating them into a
bypass. A dedicated gate is not a `human` label; uncorroborated stale work stays
a warning; a disabled merge slot is omitted. The dashboard prints recovery
commands but never runs them, and never calls repair, claim release, gate
resolution, issue closure, or any pipeline transition.
