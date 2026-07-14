---
name: ticket
version: 0.3.0
description: Create a new work ticket in thoughts/tickets from an idea. Use when the user describes a feature, bug, refactor, or chore that should enter the ticket-to-plan-to-implement pipeline.
argument-hint: <one-line idea or description>
---

Create the intent artifact for `$ARGUMENTS` under the pipeline in `thoughts/AGENTS.md`.

## Procedure

1. Allocate `{NNN}` as one more than the highest number used by any file in `thoughts/tickets/` or `thoughts/plans/`, zero-padded to three digits.
2. Infer:
   - `Type: feature | bug | refactor | chore`;
   - a configured Project Configuration target;
   - 2-5 stable lowercase retrieval tags, starting with the target and followed by useful domain or technology terms.

   Ground the choice in `thoughts/docs/`. Ask when target or tags are materially ambiguous. In an unattended caller, make the safest reasonable choice and record the assumption under Open Questions.
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
