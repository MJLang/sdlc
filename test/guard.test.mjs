import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGuard, formatGuard, GUARD_ACCEPTANCE_MATRIX, guardExitCode } from '../lib/guard.mjs';

function diagnosis(overrides = {}) {
  const context = { native: { ready: { data: [{ id: 'step-1' }] }, gates: { data: [] } } };
  const epic = { id: 'epic-1', status: 'open', assignee: null };
  const children = [{ id: 'step-1', status: 'open' }];
  return {
    number: '001',
    state: 'healthy',
    dependencyUnavailable: false,
    primaryCheckout: '/fixture',
    ticket: { path: 'thoughts/tickets/001-work.md', status: 'approved', sha256: 't'.repeat(64) },
    plan: { path: 'thoughts/plans/001-f-work.md', status: 'approved', sha256: 'p'.repeat(64), approvedCommit: 'c'.repeat(40) },
    beads: { epic, capabilitiesValid: true, healthValid: true, openGates: [], escalations: [], orphans: [] },
    worktree: { path: '/fixture/.worktrees/001-f-work', head: 'h'.repeat(40), dirty: false },
    review: null,
    mergeSlot: { enabled: false, holder: null },
    errors: [],
    warnings: [],
    inspection: { context, epic, children, plan: { activeSteps: [{ number: 1 }] } },
    ...overrides,
  };
}

test('the guard acceptance matrix exposes every required stage and mode', () => {
  assert.deepEqual(Object.keys(GUARD_ACCEPTANCE_MATRIX), ['plan', 'approve', 'implement', 'review', 'land']);
  assert.deepEqual(GUARD_ACCEPTANCE_MATRIX.approve.map((row) => row.mode), ['first-approval', 'amendment', 'no-op']);
  assert.deepEqual(GUARD_ACCEPTANCE_MATRIX.land.map((row) => row.mode), ['normal', 'post-merge-recovery']);
});

test('plan accepts only ready_for_planning and prints exactly one stable success line', () => {
  const ready = diagnosis({ state: 'ready_for_planning', plan: null, beads: { capabilitiesValid: true, healthValid: true, epic: null, openGates: [], escalations: [], orphans: [] } });
  const result = evaluateGuard('plan', ready);
  assert.equal(result.ok, true);
  const output = formatGuard(result);
  assert.equal(output.split('\n').length, 1);
  assert.match(output, /^OK stage=plan number=001 mode=new-plan state=ready_for_planning ticket=/);
  assert.match(output, /warnings=none$/);

  const refused = evaluateGuard('plan', diagnosis());
  assert.equal(refused.ok, false);
  assert.equal(refused.errors[0].code, 'wrong-state');
  assert.equal(guardExitCode(refused), 3);
});

test('approve detects first approval, amendment, no-op, and refuses an illegal mode', () => {
  const first = evaluateGuard('approve', diagnosis({ state: 'ready_for_approval', plan: { ...diagnosis().plan, status: 'review', approvedCommit: null } }));
  assert.equal(first.fields.mode, 'first-approval');
  const amendment = evaluateGuard('approve', diagnosis({ state: 'reapproval_required', errors: ['Canonical ticket or plan differs from approval.'] }));
  assert.equal(amendment.fields.mode, 'amendment');
  const noop = evaluateGuard('approve', diagnosis());
  assert.equal(noop.fields.mode, 'no-op');
  const refused = evaluateGuard('approve', diagnosis({ state: 'blocked', plan: { ...diagnosis().plan, status: 'cancelled' }, errors: ['Plan is cancelled.'] }));
  assert.equal(refused.errors[0].code, 'wrong-state');
});

test('implement enforces ready work and exact claim-owner compatibility', () => {
  const execute = evaluateGuard('implement', diagnosis(), { actor: 'sdlc:test:one' });
  assert.equal(execute.fields.mode, 'execute');
  assert.equal(execute.fields.ready, 'step-1');

  const claimedEpic = { id: 'epic-1', status: 'in_progress', assignee: 'sdlc:other:session' };
  const foreign = evaluateGuard('implement', diagnosis({
    beads: { ...diagnosis().beads, epic: claimedEpic },
    inspection: { ...diagnosis().inspection, epic: claimedEpic },
  }), { actor: 'sdlc:test:one' });
  assert.equal(foreign.errors[0].code, 'foreign-claim');

  const gatedContext = { native: { ready: { data: [{ id: 'step-1' }] }, gates: { data: [{ id: 'gate-1', blocks: 'step-1' }] } } };
  const gated = evaluateGuard('implement', diagnosis({
    beads: { ...diagnosis().beads, openGates: [{ id: 'gate-1', blocks: 'step-1' }] },
    inspection: { ...diagnosis().inspection, context: gatedContext },
  }));
  assert.equal(gated.errors[0].code, 'gated');
});

test('implement review mode and review guard require closed children and a clean worktree', () => {
  const closed = diagnosis({ inspection: { ...diagnosis().inspection, children: [{ id: 'step-1', status: 'closed' }] } });
  assert.equal(evaluateGuard('implement', closed).fields.mode, 'review');
  assert.equal(evaluateGuard('review', closed).fields.mode, 'pending');
  const existing = evaluateGuard('review', { ...closed, review: { artifact: 'thoughts/reviews/001-round1.md', valid: true, verdict: 'BLOCKED', codeSha: 'h'.repeat(40) } });
  assert.equal(existing.fields.mode, 'existing');
  const dirty = evaluateGuard('review', { ...closed, worktree: { ...closed.worktree, dirty: true } });
  assert.equal(dirty.errors[0].code, 'worktree-dirty');
});

test('land requires an approved bound review and resolved AA gate evidence', () => {
  const closed = diagnosis({
    inspection: { ...diagnosis().inspection, children: [{ id: 'step-1', status: 'closed' }] },
    review: { artifact: 'thoughts/reviews/001-round1.md', valid: true, verdict: 'APPROVED', codeSha: 'h'.repeat(40) },
  });
  const planSource = `# Plan\n\n## Approval Attention\n\n| ID | Operation | Why | Timing | Status |\n|---|---|---|---|---|\n| AA-001 | External write | consent | implementation | open |\n`;
  const missing = evaluateGuard('land', closed, { planSource, allGates: [] });
  assert.equal(missing.errors[0].code, 'approval-consent-missing');
  const accepted = evaluateGuard('land', closed, {
    planSource,
    allGates: [{ id: 'gate-aa', status: 'closed', description: 'AA-001 approved', resolution_reason: 'AA-001: proceed' }],
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.fields.mode, 'normal');
  assert.equal(accepted.fields.consent, 'AA-001');
});

test('land post-merge recovery accepts only terminal artifacts with matching evidence and preserves a semantic warning', () => {
  const recovery = diagnosis({
    state: 'blocked',
    ticket: { ...diagnosis().ticket, status: 'implemented' },
    plan: { ...diagnosis().plan, status: 'merged' },
    errors: ['Plan is merged; this is a terminal/recovery projection, not an implementation candidate.'],
  });
  const accepted = evaluateGuard('land', recovery, { mergeCommit: 'm'.repeat(40) });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.fields.mode, 'post-merge-recovery');
  assert.match(accepted.fields.warnings, /semantic-recovery-proof-required/);
  const refused = evaluateGuard('land', recovery, { mergeCommit: '' });
  assert.equal(refused.errors[0].code, 'post-merge-proof-required');
});
