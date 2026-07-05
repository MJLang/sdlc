---
name: approve
description: Human gate — approve a reviewed plan (creates its beads epic + step issues), or re-sync an amended, already-approved plan into its epic.
argument-hint: <plan number, e.g. 003>
disable-model-invocation: true
---

Approve or re-sync plan $ARGUMENTS. This is a human gate: it runs only on explicit user invocation.

Two modes, chosen by the plan's current state:
- **First approval** — `Status: review`, no `Beads Epic`.
- **Amendment re-sync** — `Status: approved` with `Beads Epic` set, and the plan file has been edited. This is the sanctioned way to change a plan after approval — including adding scope while `/implement` is running.

If the plan is `draft`, refuse: it is not finished. If it does not exist, refuse.

## Amendment rules — enforced in both modes

- Step numbers are immutable — never renumber. New steps get fresh numbers and place themselves via `Depends on:`.
- Removed steps stay in the file, marked `~~Step N~~ — removed: <why>`.
- A dependency on an already-closed issue is simply satisfied, so appending steps mid-flight is safe.

## Mode: first approval

1. Read the plan in full. Unresolved **Open Questions** → list them and ask the user to resolve them before approving.
2. Create the epic:

   ```bash
   bd create "<plan title>" --type=epic --priority=2 \
     --description="Epic for plan <plan filename>. Ticket: <ticket filename>."
   ```

3. Create one child issue per step (parallel subagents are fine when there are many):

   ```bash
   bd create "<step title>" --type=task --parent=<epic-id> --priority=2 \
     --description="Step N of <plan filename>: <what, files touched>"
   ```

4. Wire step ordering from the plan's `Depends on:` lines: `bd dep add <later-step-id> <earlier-step-id>`.
5. Update the plan file atomically — the one place frontmatter and beads are synced: set `Beads Epic: <epic-id>`, set `Status: approved`, and append a **Beads** section mapping steps ↔ issue ids.
6. Report: the epic id, the issue ids, what `bd ready` shows unblocked, and that `/implement {NNN}` may now run.

## Mode: amendment re-sync

1. Read the plan and the epic's children (`bd show <epic-id>`). Diff plan steps against issues using the **Beads** section mapping:
   - a step with no issue → create it (`--parent=<epic-id>`) and wire its `Depends on:` deps;
   - a step marked removed whose issue is still open → `bd close <id> --reason="superseded by plan amendment"`;
   - closed issues for unchanged steps → leave untouched.
2. Update the plan's **Beads** section with the new mapping; record the amendment in both places: a line in the plan body, and `bd update <epic-id> --append-notes="amended: +<n> steps, -<m> steps — <one-line why>"`.
3. Report what changed. A running `/implement` needs no restart — it re-derives its issue set from beads every iteration, so new issues simply join its queue.

This skill is idempotent in both modes: re-running with nothing to sync changes nothing and says so.
