import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlan, parseResearchSynthesis, parseTicket, researchReuseDecision } from '../lib/artifacts.mjs';
import { fingerprintContent } from '../lib/fingerprint.mjs';

function ticketText() {
  return `---
Status: approved
Tags: [app, export]
Type: feature
Target: app
---

# Export

## Acceptance Criteria

- AC-001: Exports records.
- AC-002: Rejects bad filters.
- ~~AC-003~~ - removed: superseded.

## Constraints

- NFR-001: Completes promptly.
`;
}

function planText(ticketHash, overrides = '') {
  return `---
Status: review
Tags: [app, export]
Type: feature
Target: app
Ticket Origin: thoughts/tickets/023-export.md
Source Ticket Hash: sha256=${ticketHash}
Beads Epic:
---

# Plan

## Current-State Findings

| Area or path | Finding | Evidence | Implication |
|---|---|---|---|
| lib | Existing path | \`lib/x.mjs:1\` | Reuse |

## Approval Attention

None

### Step 1 - Implement

Covers: AC-001, AC-002, NFR-001
Files:
- lib/export.mjs
Depends on: none
Parallelizable: no

Do it.

### ~~Step 2~~ - removed: no longer needed

## Verification

- AC-001: exercise export.
- AC-002: exercise invalid input.

## Plan Critique

Pass 1 Verdict: APPROVED
${overrides}`;
}

test('ticket and plan parsers enforce identifiers, coverage, and graph fields', () => {
  const ticketSource = ticketText();
  const ticket = parseTicket(ticketSource);
  const plan = parsePlan(planText(fingerprintContent(ticketSource)), { ticket });
  assert.deepEqual(ticket.activeAcceptanceCriteria, ['AC-001', 'AC-002']);
  assert.deepEqual(ticket.removedAcceptanceCriteria, ['AC-003']);
  assert.deepEqual(plan.activeSteps[0].covers, ['AC-001', 'AC-002', 'NFR-001']);
  assert.deepEqual(plan.coverage.missingImplementation, []);
  assert.deepEqual(plan.coverage.missingVerification, []);
  assert.deepEqual(plan.errors, []);
});

test('plan parser reports unknown IDs, missing coverage, and dependency cycles', () => {
  const ticket = parseTicket(ticketText());
  const source = planText(fingerprintContent(ticketText()))
    .replace('AC-001, AC-002, NFR-001', 'AC-001, AC-999')
    .replace('Depends on: none', 'Depends on: step 1');
  const plan = parsePlan(source, { ticket });
  assert(plan.errors.some((error) => error.includes('unknown identifiers: AC-999')));
  assert(plan.errors.some((error) => error.includes('missing implementation coverage: AC-002')));
  assert(plan.errors.some((error) => error.includes('depends on itself')));
  assert(plan.errors.some((error) => error.includes('dependency cycle')));
});

test('active plan steps require a yes/no Parallelizable field', () => {
  const ticket = parseTicket(ticketText());
  const missing = parsePlan(planText(fingerprintContent(ticketText())).replace('Parallelizable: no', 'Parallelizable: sometimes'), { ticket });
  assert(missing.errors.some((error) => error.includes('invalid or missing Parallelizable')));
});

test('plan fields cannot mix none sentinels with identifiers or step references', () => {
  const ticket = parseTicket(ticketText());
  const mixed = parsePlan(planText(fingerprintContent(ticketText()))
    .replace('Covers: AC-001, AC-002, NFR-001', 'Covers: none - operational only, AC-001')
    .replace('Depends on: none', 'Depends on: none, step 2'), { ticket });
  assert(mixed.errors.some((error) => error.includes('Covers: cannot mix none with identifiers')));
  assert(mixed.errors.some((error) => error.includes('Depends on: cannot mix none with step references')));
});

test('ticket parser rejects duplicate acceptance IDs', () => {
  const ticket = parseTicket(ticketText().replace('- AC-002:', '- AC-001:'));
  assert(ticket.errors.some((error) => error.includes('Duplicate acceptance IDs')));
});

test('ticket acceptance bullets require allocated IDs and plan origin is canonical', () => {
  const malformedTicket = parseTicket(ticketText().replace('- AC-002: Rejects bad filters.', '- Rejects bad filters.'));
  assert(malformedTicket.errors.some((error) => error.includes('without an allocated AC-NNN ID')));
  const ticket = parseTicket(ticketText(), { path: 'thoughts/tickets/023-export.md' });
  const plan = parsePlan(planText(fingerprintContent(ticketText())).replace('Ticket Origin: thoughts/tickets/023-export.md', 'Ticket Origin: export.md'), { ticket });
  assert(plan.errors.some((error) => error.includes('Ticket Origin does not match')));
  const identityMismatch = parsePlan(planText(fingerprintContent(ticketText()))
    .replace('Type: feature', 'Type: bug')
    .replace('Target: app', 'Target: other'), { ticket });
  assert(identityMismatch.errors.some((error) => error.includes('Plan Type does not match ticket Type')));
  assert(identityMismatch.errors.some((error) => error.includes('Plan Target does not match ticket Target')));
});

test('plan critique grammar preserves blockers and requires reasoned waivers', () => {
  const ticket = parseTicket(ticketText());
  const base = planText(fingerprintContent(ticketText()));
  const fixed = parsePlan(base.replace('Pass 1 Verdict: APPROVED', 'Pass 1 Verdict: BLOCKED - 1 MUST FIX\n- PC-001 [fixed]: coverage repaired.\nScoped Re-check Verdict: APPROVED'), { ticket });
  assert.equal(fixed.errors.length, 0, fixed.errors.join('\n'));
  const missingFinding = parsePlan(base.replace('Pass 1 Verdict: APPROVED', 'Pass 1 Verdict: BLOCKED - 1 MUST FIX'), { ticket });
  assert(missingFinding.errors.some((error) => error.includes('no stable finding IDs')));
  const reasonless = parsePlan(base.replace('Pass 1 Verdict: APPROVED', 'Pass 1 Verdict: BLOCKED - 1 MUST FIX\n- PC-001 [waived]: omitted.'), { ticket });
  assert(reasonless.errors.some((error) => error.includes('lack a human reason')));
  const persists = parsePlan(base.replace('Pass 1 Verdict: APPROVED', 'Pass 1 Verdict: BLOCKED - 1 MUST FIX\n- PC-001 [persists]: still missing.\nScoped Re-check Verdict: BLOCKED - 1 MUST FIX'), { ticket });
  assert(persists.errors.some((error) => error.includes('re-check remains blocked')));
});

test('acceptance waivers require an explicit positive record', () => {
  const ticket = parseTicket(ticketText());
  const uncovered = planText(fingerprintContent(ticketText())).replace('AC-001, AC-002, NFR-001', 'AC-001, NFR-001');
  const negative = parsePlan(uncovered.replace('## Approval Attention\n\nNone', '## Approval Attention\n\nAC-002 is not waived because validation remains required.'), { ticket });
  assert(negative.errors.some((error) => error.includes('missing implementation coverage: AC-002')));
  const proseExample = parsePlan(uncovered.replace('## Approval Attention\n\nNone', '## Approval Attention\n\nDocument the example waiver: id=AC-002; reason=external contract.'), { ticket });
  assert(proseExample.errors.some((error) => error.includes('missing implementation coverage: AC-002')));
  const placeholder = parsePlan(uncovered.replace('## Approval Attention\n\nNone', '## Approval Attention\n\nwaiver: id=AC-002; reason=<reason>'), { ticket });
  assert(placeholder.errors.some((error) => error.includes('missing implementation coverage: AC-002')));
  const explicit = parsePlan(uncovered.replace('## Approval Attention\n\nNone', '## Approval Attention\n\nwaiver: id=AC-002; reason=handled by an external contract'), { ticket });
  assert.equal(explicit.coverage.waived.includes('AC-002'), true);
  assert.equal(explicit.errors.some((error) => error.includes('AC-002')), false, explicit.errors.join('\n'));
});

test('research reuse refreshes only tracks whose evidence changed', () => {
  const hash = 'a'.repeat(64);
  const synthesis = parseResearchSynthesis(`---
Ticket: thoughts/tickets/023-export.md
Ticket-Hash: sha256=${hash}
Baseline: abc1234
Generated-At: 2026-07-13T12:00:00Z
Tracks: 2
---

## Track R1 - API

Question: Where?
Evidence Paths:
- src/api/export.ts

Findings:
- Found.

Conflicts:
- None.

Remaining Unknowns:
- None.

Confidence: high

## Track R2 - UI

Question: Where?
Evidence Paths:
- src/ui/export.tsx

Findings:
- Found.

Conflicts:
- None.

Remaining Unknowns:
- None.

Confidence: high

## Cross-Track Synthesis

- Planning implications: reuse.
`);
  const decision = researchReuseDecision(synthesis, {
    ticketSha256: hash,
    changedPaths: ['src/api/export.ts'],
    dirtyPaths: ['README.md'],
  });
  assert.equal(decision.refreshAll, false);
  assert.deepEqual(decision.refreshTrackIds, ['R1']);
  assert.deepEqual(decision.reusableTrackIds, ['R2']);
});

test('research ticket or baseline invalidation refreshes every track', () => {
  const synthesis = { ticketSha256: 'a'.repeat(64), baseline: 'abc', tracks: [{ id: 'R1', evidencePaths: ['a'] }, { id: 'R2', evidencePaths: ['b'] }] };
  assert.equal(researchReuseDecision(synthesis, { ticketSha256: 'b'.repeat(64) }).refreshAll, true);
  assert.equal(researchReuseDecision(synthesis, { ticketSha256: 'a'.repeat(64), baselineIsAncestor: false }).refreshAll, true);
});

test('track-local research defects refresh only the affected track', () => {
  const hash = 'a'.repeat(64);
  const synthesis = {
    ticketSha256: hash,
    baseline: 'abc1234',
    errors: ['R1 is missing Evidence Paths.'],
    globalErrors: [],
    tracks: [
      { id: 'R1', evidencePaths: [], errors: ['R1 is missing Evidence Paths.'] },
      { id: 'R2', evidencePaths: ['src/ui/export.tsx'], errors: [] },
    ],
  };
  const decision = researchReuseDecision(synthesis, { ticketSha256: hash });
  assert.equal(decision.refreshAll, false);
  assert.deepEqual(decision.refreshTrackIds, ['R1']);
  assert.deepEqual(decision.reusableTrackIds, ['R2']);
  assert(decision.reasons.includes('R1:malformed-track'));
});

test('malformed research synthesis is never reused', () => {
  const synthesis = parseResearchSynthesis(`---
Ticket: thoughts/tickets/023-export.md
Ticket: thoughts/tickets/023-other.md
Ticket-Hash: sha256=${'a'.repeat(64)}
Baseline: abc1234
Tracks: 1
---

## Track R1 - Incomplete

Evidence Paths:
- src/export.ts
`);
  assert(synthesis.errors.length > 0);
  assert(synthesis.errors.some((error) => error.includes('Duplicate frontmatter fields: Ticket')));
  const decision = researchReuseDecision(synthesis, { ticketSha256: 'a'.repeat(64) });
  assert.equal(decision.refreshAll, true);
  assert(decision.reasons.includes('malformed-synthesis'));
});

function reusableSynthesisText(hash) {
  return `---
Ticket: thoughts/tickets/023-export.md
Ticket-Hash: sha256=${hash}
Baseline: abc1234
Generated-At: 2026-07-13T12:00:00Z
Tracks: 2
---

## Track R1 - API

Question: Where?
Evidence Paths:
- src/api/export.ts

Findings:
- Found.

Conflicts:
- None.

Remaining Unknowns:
- None.

Confidence: high

## Track R2 - UI

Question: Where?
Evidence Paths:
- src/ui/export.tsx

Findings:
- Found.

Conflicts:
- None.

Remaining Unknowns:
- None.

Confidence: high

## Cross-Track Synthesis

- Planning implications: reuse.
`;
}

test('research reuse keeps every track when only unrelated paths changed', () => {
  const hash = 'a'.repeat(64);
  const synthesis = parseResearchSynthesis(reusableSynthesisText(hash));
  const decision = researchReuseDecision(synthesis, {
    ticketSha256: hash,
    changedPaths: ['docs/README.md', 'lib/unrelated.mjs'],
    dirtyPaths: ['scripts/tooling.mjs'],
  });
  assert.equal(decision.refreshAll, false);
  assert.deepEqual(decision.refreshTrackIds, []);
  assert.deepEqual(decision.reusableTrackIds, ['R1', 'R2']);
  assert.deepEqual(decision.reasons, []);
});

test('research reuse refreshes a track whose cited path was deleted or renamed away', () => {
  const hash = 'a'.repeat(64);
  const synthesis = parseResearchSynthesis(reusableSynthesisText(hash));
  const deleted = researchReuseDecision(synthesis, {
    ticketSha256: hash,
    changedPaths: ['src/ui/export.tsx'],
  });
  assert.deepEqual(deleted.refreshTrackIds, ['R2']);
  assert.deepEqual(deleted.reusableTrackIds, ['R1']);
  const directory = researchReuseDecision(synthesis, {
    ticketSha256: hash,
    changedPaths: ['src/api'],
  });
  assert.deepEqual(directory.refreshTrackIds, ['R1']);
});

test('plan step depending on a missing step is an error', () => {
  const ticket = parseTicket(ticketText());
  const plan = parsePlan(planText(fingerprintContent(ticketText())).replace('Depends on: none', 'Depends on: step 9'), { ticket });
  assert(plan.errors.some((error) => error.includes('Step 1 depends on missing step 9')));
});
