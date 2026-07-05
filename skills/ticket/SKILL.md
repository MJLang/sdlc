---
name: ticket
description: Create a new work ticket in thoughts/tickets from an idea. Use when the user describes a new feature, bug, refactor, or chore that should enter the ticket → plan → implement pipeline.
argument-hint: <one-line idea or description>
---

Create a new ticket — the intent artifact of the pipeline described in `thoughts/AGENTS.md`.

Input: $ARGUMENTS

## Steps

1. **Allocate the number.** Next number = the highest number used by any file in `thoughts/tickets/` or `thoughts/plans/`, plus one, zero-padded to 3 digits.
2. **Classify.** Type: `feature | bug | refactor | chore`. Target: one of the targets defined in `thoughts/AGENTS.md` (Project Configuration). Infer both from the idea and the product docs in `thoughts/docs/`. If the target is genuinely ambiguous, ask the user; when running unattended, pick the best fit and record the assumption under Open Questions.
3. **Write** `thoughts/tickets/{NNN}-{kebab-case-title}.md`:

   ```yaml
   ---
   Status: draft
   Tags: []
   Type: <type>
   Target: <target>
   ---
   ```

   Body sections:
   - **Summary** — what and why, grounded in the product docs in `thoughts/docs/` (user journeys, goals).
   - **Scope** — explicitly in scope / out of scope.
   - **Acceptance Criteria** — checkable outcomes, not implementation steps.
   - **Open Questions** — if any; empty section is fine.

4. **Stay high-level.** A ticket describes WHAT and WHY — never implementation steps; that is the plan's job. A ticket must fit a single reviewable unit of work: if the idea is bigger than that, split it into multiple tickets and tell the user how you split it.
5. **Report** the file path and remind the user: the ticket stays `draft` until they approve it (flip `Status: approved`), which is what makes it eligible for `/plan`.

Do NOT create beads issues, plans, or code here.
