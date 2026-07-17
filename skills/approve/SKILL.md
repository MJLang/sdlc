---
name: approve
version: 0.5.0
description: Human gate that commits and approves a reviewed plan, creates its traceable Beads graph and approval hash record, or safely re-syncs an amended approved plan.
argument-hint: <plan number, e.g. 003>
disable-model-invocation: true
---

Approve or re-sync plan `$ARGUMENTS`. Run only on explicit human invocation.

Modes:

- **First approval:** `Status: review` and no `Beads Epic`.
- **Amendment re-sync:** `Status: approved`, `Beads Epic` is set, and the canonical plan or ticket was intentionally edited.
- **Recovery/no-op:** a prior run stopped between Git and Beads operations.

Refuse a missing/draft/cancelled/merged plan. Never treat Git and Beads as one atomic transaction; use the ordered, idempotent recovery protocol below.

## Invariants

- Work only in the primary `main` checkout. Ticket, synthesis, and plan there are canonical; never approve worktree snapshots.
- Step numbers and AC IDs are immutable after first approval. Preserve removals with reasons and allocate new numbers above the prior maximum.
- `Source Ticket Hash` must equal `sdlc hash <canonical-ticket-path>` before the gate commit. A changed ticket requires the plan's coverage, Verification, research validity, and critique to be reconsidered; never update only the hash.
- Every live AC has implementation and Verification coverage, every `Covers:` ID exists, and the step dependency graph is valid and acyclic.
- A discovery plan additionally has a complete Discovery Protocol. Approval does not authorize a final conclusion in advance: both validation and invalidation thresholds, resource attention, cleanup, and follow-up dispositions must remain explicit.
- Surface every Open Question and research Remaining Unknown. Resolve it, explicitly defer it outside this plan with a rationale, or record the human's reasoned waiver; never approve by omission.
- Every unresolved `PC-NNN` blocker or uncovered AC must be corrected or explicitly waived by this human. Record each waiver in the plan and on the epic as `waiver: id=<id>; reason=<reason>` (an AC may additionally be marked `AC-NNN [waived] - reason: <reason>; waived by human`); a silent, negative, or inferred mention is invalid.
- Plan approval authorizes disclosed repository edits. Approval Attention operations that require execution-time consent remain separate gates.
- During this human gate, set each Approval Attention status to
  `approved-in-plan` when plan approval itself grants consent, or leave it
  `open` when a later execution-time decision is still required. Landing treats
  every still-open `AA-NNN` as requiring matching resolved-gate evidence.
- Beads metadata contains identity only, never prose or hashes:
  - epic: `sdlc_ticket=<repo-relative ticket>`, `sdlc_plan=<repo-relative plan>`;
  - child: those keys plus `sdlc_step=<stable number>`.
  - epic and children use `--spec-id <repo-relative plan>`.
- Every observation uses `bd --readonly`; every mutation inherits one session actor.

## Preflight and actor

1. Run `sdlc guard approve {NNN}`. Its acceptance matrix identifies
   `first-approval` (`ready_for_approval`), `amendment` (approved plan with
   intentional canonical drift), or `no-op` (`healthy`). A refusal preserves
   doctor exit semantics; run `sdlc doctor {NNN} --json` only when the coded
   recovery lacks needed detail. Legacy work uses the explicit migration rules
   below and never gains synthesized coverage or waivers.
2. Before the first Beads mutation, establish a unique root actor. This human gate is a root mutating boundary: set `<runtime>` to the current runtime and run:

   ```bash
   sdlc actor <runtime> --new
   ```

   Capture the literal and carry it unchanged through this invocation. Per the
   contract actor invariant, prefix every mutation with
   `BEADS_ACTOR="<session-actor>"`; never rely on shell export or an older actor.
3. Discover existing objects with `bd --readonly` by the plan's `spec-id`, metadata, plan mapping, and epic ID before creating anything. Reuse matching objects from a partial run; never duplicate them.

## First approval

1. Create or recover the epic, capturing its ID:

   ```bash
   BEADS_ACTOR="<session-actor>" bd create "<plan title>" --type=epic --priority=2 --spec-id="<plan path>" \
     --metadata='{"sdlc_ticket":"<ticket path>","sdlc_plan":"<plan path>"}' \
     --description="Epic for <plan path>; source ticket <ticket path>." --silent
   ```

2. Create or recover exactly one child per active plan step. Include its full current instruction, `Covers`, `Files`, and `Depends on` in the description:

   ```bash
   BEADS_ACTOR="<session-actor>" bd create "<step title>" --type=task --parent=<epic-id> --priority=2 \
     --spec-id="<plan path>" \
     --metadata='{"sdlc_ticket":"<ticket path>","sdlc_plan":"<plan path>","sdlc_step":"<N>"}' \
     --description="Step <N> of <plan path>: <instruction, covers, files, dependencies>" --silent
   ```

3. Wire the `Depends on:` graph. Prefer one newline-delimited JSON stream to `BEADS_ACTOR="<session-actor>" bd dep add --file -`, with records such as `{"from":"<later-id>","to":"<earlier-id>"}`. Then require `bd --readonly dep cycles --json` to report no cycle for the whole graph.
4. Update the canonical plan in one edit: set `Status: approved`, fill `Beads Epic`, and write/update the **Beads** step-to-issue mapping. Ensure any human waiver is visible in the applicable AC or Plan Critique disposition and an Approval Waivers record.
5. Append the same waiver and resolved/deferred-question records to the epic under the session actor.
6. Commit the gate artifacts as described below, append the approval record, validate, and push.

## Amendment re-sync

1. Compare the canonical active/removed steps with `bd --readonly show <epic-id> --json` and the Beads mapping.
2. Reconcile by stable step number and existing issue ID:
   - create a child only for a new step;
   - refresh `--spec-id`, stable metadata, title, and description for each changed open step;
   - close an open issue for a removed step with `--reason="superseded by plan amendment: <reason>"`;
   - leave closed unchanged steps closed;
   - add/remove dependency edges to exactly match active `Depends on:` lines.
3. Use `BEADS_ACTOR="<session-actor>" bd batch` only when the **entire** Beads-only amendment consists of existing-ID `close`, supported limited `update`, or dependency add/remove operations accepted by `bd batch --help`. Do not use it when rich create, description, metadata, spec-id, notes, or another unsupported operation is needed. A batch is one Dolt transaction, not Git/Beads atomicity. If it fails, verify that none of its writes landed and retry from the prior Beads state.
4. Require an empty `bd --readonly dep cycles --json` result, update the plan mapping, and add the amendment summary to the plan and epic notes.
5. Commit as an amendment, append a fresh approval record, validate, and push. Never copy, merge, rebase, or cherry-pick the amended plan into a live implementation worktree; execution reads canonical text from main and structure from Beads.

## Gate commit and approval record

For either mode:

1. Form the allowlist: canonical ticket, canonical plan, and `thoughts/designs/{NNN}-research.md` only when it exists and belongs to this ticket. Do not stage or commit any other path.
2. Stage only the allowlist and commit it from primary main with `git commit --only` so unrelated staged changes remain outside the commit:
   - first approval: `plan: approve <title> (ticket {NNN})`;
   - amendment: `plan: amend <title> (ticket {NNN})`.
3. Verify every changed path in the commit is in the allowlist, the plan is included, and all allowlisted paths are clean. An unchanged, already-committed ticket or synthesis need not appear in the commit diff. If an outside path appears, stop without adding an approval record.
4. Compute both committed artifact identities through the public command:

   ```bash
   sdlc hash <canonical-ticket-path>
   sdlc hash <canonical-plan-path>
   ```

   Each output must be exactly `sha256=<hex>`. Record `git rev-parse HEAD` as `<main-sha>`.
5. Append to the epic:

   ```text
   approval: plan-sha256=<hex> ticket-sha256=<hex> commit=<main-sha>
   ```

   Approval records are append-only. The latest record whose commit is main-reachable and whose committed files reproduce both hashes is authoritative. A later malformed record is a warning, never authority.
6. Re-run `sdlc guard approve {NNN}` and require `mode=no-op state=healthy` for
   the completed approval identity, mapping, dependencies, and Beads health.
   Run full doctor only after a refusal that needs expanded evidence.
7. If a remote exists, push Git first, then `BEADS_ACTOR="<session-actor>" bd dolt push`. Report either failure precisely; do not claim both stores synced when only one pushed.

## Recovery and migration

- Existing Beads objects from a failed pre-commit run are reused by identity.
- A gate commit with no matching note is completed by appending its reproducible approval record; do not create another commit.
- An unreproducible approval record is ignored in favor of the latest valid record and reported.
- Explicit mutations that partially landed are reconciled from canonical plan state on rerun; do not assume rollback except for a failed compatible `bd batch`.
- Draft/review legacy work must first gain reviewed AC IDs, coverage, source-ticket hash, and critique. Approved legacy work with open issues migrates only through this explicit re-sync while preserving step and issue IDs.
- Preserve pre-contract `human`-labeled implementation steps as legacy records; do not synthesize gate issues or silently close them. Record the decision explicitly, remove the legacy label only when safe, and use dedicated gates for every new question.
- Never silently add AC IDs, coverage, findings dispositions, or waivers during migration.

Report the mode, commit and hashes, epic/step mapping changes, dependency result, doctor state, and push state. `/implement {NNN}` is legal only after doctor is `healthy`.
