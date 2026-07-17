---
name: ticket
version: 0.5.0
description: Create a new work ticket in thoughts/tickets from an idea. Use when the user describes a feature, bug, refactor, chore, or discovery that should enter the ticket-to-plan-to-implement pipeline.
argument-hint: <one-line idea or description>
disable-model-invocation: true
---

Create the intent artifact for `$ARGUMENTS` under the pipeline in `thoughts/AGENTS.md`.

## Procedure

1. Allocate `{NNN}` as one more than the highest number used by any file in `thoughts/tickets/` or `thoughts/plans/`, zero-padded to three digits.
2. Infer:
   - `Type: feature | bug | refactor | chore | discovery`.
   - Use `discovery` when the outcome tests feasibility, compatibility, limits, performance, or an architectural assumption. Its ACs state the question/hypothesis, observable experiments, decision thresholds, retained evidence, and required disposition after either result.
   - a configured Project Configuration target;
   - 2-5 stable lowercase retrieval tags, starting with the target and followed by useful domain or technology terms.

   Search `thoughts/docs/INDEX.md` first. Load the product overview plus rows whose target/tags match the idea, and expand to another document only when the indexed evidence remains ambiguous. Ask when target or tags are materially ambiguous; in an unattended caller, make the safest reasonable choice and record the assumption under Open Questions.
3. Write `thoughts/tickets/{NNN}-{kebab-case-title}.md`:

   ```yaml
   ---
   Status: draft
   Tags: [<tag>, ...]
   Type: <type>
   Target: <target>
   ---
   ```

   Include:
   - **Summary** - what and why, grounded in product goals and journeys;
   - **Scope** - explicit in-scope and out-of-scope boundaries;
   - **Acceptance Criteria** - at least one checkable outcome, each allocated as `AC-NNN`;
   - **Open Questions** - unresolved product or priority decisions; `None` is valid.
   - **Documentation Sources** - the index rows/documents that informed the ticket, or `None`.

   Use this acceptance-criterion form:

   ```md
   ## Acceptance Criteria

   - AC-001: A user can export the selected records in CSV format.
   - AC-002: Invalid filters produce the repository-standard validation response.
   ```

4. Keep the artifact at WHAT/WHY level. Acceptance criteria describe observable outcomes, not implementation steps. Split work that cannot fit one reviewable unit and explain the split.

## Identifier rules

- Allocate unique three-digit AC IDs in ascending order.
- Before a plan exists, criteria may be edited freely.
- Once a plan exists, never reassign an existing ID to a different outcome. Mark a removal as `~~AC-NNN~~ - removed: <reason>` and allocate future criteria above the highest number ever used.
- Add `NFR-NNN`, `C-NNN`, `A-NNN`, or `Q-NNN` only when a downstream artifact needs to reference one. Do not create empty taxonomy sections.
- Chore tickets follow the same AC rules, normally with one concise criterion.

Report the path and remind the user that the ticket stays `draft` until they explicitly flip it to `Status: approved`. Do not create Beads issues, plans, worktrees, or code.
