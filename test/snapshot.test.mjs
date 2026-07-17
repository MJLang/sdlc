import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSnapshot, declaredScopeOverlap, SNAPSHOT_SCHEMA } from '../lib/snapshot.mjs';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-snapshot-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return root;
}

function context(overrides = {}) {
  return {
    primary: repository(),
    head: 'a'.repeat(40),
    now: Date.parse('2026-07-14T12:00:00Z'),
    installation: { version: '1.1.0' },
    config: { mode: 'embedded' },
    native: {
      ready: { data: [{ id: 'step-1' }] },
      gates: { data: [] },
      mergeSlot: null,
    },
    ...overrides,
  };
}

function diagnosis(shared, overrides = {}) {
  const epic = { id: 'epic-001', status: 'open', assignee: null };
  const children = [{ id: 'step-1', status: 'open' }];
  return {
    number: '001',
    state: 'healthy',
    ticket: { path: 'thoughts/tickets/001-work.md', status: 'approved', sha256: 't'.repeat(64) },
    plan: { path: 'thoughts/plans/001-f-work.md', status: 'approved', sha256: 'p'.repeat(64), approvedCommit: 'c'.repeat(40) },
    beads: { capabilitiesValid: true, healthValid: true, epic, openGates: [], escalations: [], orphans: [] },
    worktree: null,
    mergeSlot: { enabled: false, holder: null },
    review: null,
    errors: [],
    warnings: [],
    inspection: { context: shared, epic, children, plan: { activeSteps: [{ number: 1, files: ['lib/work.mjs'] }] } },
    ...overrides,
  };
}

test('idle next snapshot has stable compact schema and no selected transition', () => {
  const shared = context({ native: { ready: { data: [] }, gates: { data: [] }, mergeSlot: null } });
  const draft = diagnosis(shared, {
    state: 'blocked',
    ticket: { path: 'thoughts/tickets/001-work.md', status: 'draft', sha256: 't'.repeat(64) },
    plan: null,
    beads: { capabilitiesValid: true, healthValid: true, epic: null, openGates: [], escalations: [], orphans: [] },
    errors: ['Ticket status draft is not approved.'],
    inspection: { context: shared, epic: null, children: [], plan: null },
  });
  const result = buildSnapshot({ view: 'next', context: shared, diagnoses: [draft], now: shared.now });
  assert.equal(result.schema, SNAPSHOT_SCHEMA);
  assert.equal(result.beads.healthValid, true);
  assert.equal(result.selected, undefined);
  assert.equal(result.candidates, undefined);
  assert.deepEqual(Object.keys(result), ['schema', 'view', 'generatedAt', 'expiresAt', 'head', 'state', 'beads', 'humanQueue']);
  assert.equal(result.humanQueue[0].code, 'ticket-approval');
});

test('idle snapshots expose global health failures without requiring an active artifact', () => {
  const shared = context({ errors: ['Beads inProgress diagnostics failed: unavailable'] });
  const result = buildSnapshot({ view: 'next', context: shared, diagnoses: [], now: shared.now });
  assert.equal(result.beads.healthValid, false);
  assert.deepEqual(result.beads.errors, ['Beads inProgress diagnostics failed: unavailable']);
  assert.equal(result.selected, undefined);
});

test('next selects one implementable plan and reports compact identity fields', () => {
  const shared = context();
  const result = buildSnapshot({ view: 'next', context: shared, diagnoses: [diagnosis(shared)], actor: 'sdlc:test:one', now: shared.now });
  assert.equal(result.selected.number, '001');
  assert.equal(result.selected.transition, 'implement');
  assert.equal(result.selected.eligible, true);
  assert.deepEqual(result.selected.ready, ['step-1']);
});

test('next emits stable rejection codes for health, claims, gates, stale work, and orphans', () => {
  const shared = context();
  const foreignEpic = { id: 'epic-001', status: 'in_progress', assignee: 'sdlc:other:session' };
  const cases = [
    [diagnosis(shared, { beads: { capabilitiesValid: true, healthValid: false, epic: foreignEpic, openGates: [], escalations: [], orphans: [] }, inspection: { ...diagnosis(shared).inspection, epic: foreignEpic } }), 'unhealthy'],
    [diagnosis(shared, { beads: { capabilitiesValid: true, healthValid: true, epic: foreignEpic, openGates: [], escalations: [], orphans: [] }, inspection: { ...diagnosis(shared).inspection, epic: foreignEpic } }), 'foreign-claim'],
    [diagnosis({ ...shared, native: { ...shared.native, gates: { data: [{ id: 'gate-1', blocks: 'step-1' }] } } }, { beads: { capabilitiesValid: true, healthValid: true, epic: diagnosis(shared).beads.epic, openGates: [{ id: 'gate-1', blocks: 'step-1' }], escalations: [], orphans: [] } }), 'gated'],
    [diagnosis(shared, { beads: { ...diagnosis(shared).beads, staleClaim: { id: 'step-1' } }, errors: ['Plan has 1 stale in-progress Beads issue corroborated by worktree inactivity.'] }), 'stale-candidate'],
    [diagnosis(shared, { beads: { ...diagnosis(shared).beads, orphans: [{ commit: 'deadbeef' }] } }), 'orphan-recovery'],
  ];
  for (const [item, code] of cases) {
    const result = buildSnapshot({ view: 'next', context: item.inspection.context, diagnoses: [item], actor: 'sdlc:test:one', now: shared.now });
    assert(result.candidates[0].reasons.includes(code), `${code}: ${JSON.stringify(result)}`);
  }
});

test('unconfirmed stale work remains eligible but is surfaced as a warning', () => {
  const shared = context();
  const item = diagnosis(shared, {
    beads: { ...diagnosis(shared).beads, staleClaim: { id: 'step-1' } },
    warnings: ['Beads reports candidate stale work, but current Git/worktree activity does not corroborate abandonment.'],
  });
  const result = buildSnapshot({ view: 'next', context: shared, diagnoses: [item], now: shared.now });
  assert.equal(result.candidates[0].eligible, true);
  assert(result.candidates[0].warnings.includes('stale-unconfirmed'));
});

test('declared file overlap skips a candidate with plan/path evidence', () => {
  const shared = context({ native: { ready: { data: [{ id: 'step-1' }, { id: 'step-2' }] }, gates: { data: [] }, mergeSlot: null } });
  const first = diagnosis(shared);
  const secondEpic = { id: 'epic-002', status: 'in_progress', assignee: 'sdlc:test:one' };
  const second = diagnosis(shared, {
    number: '002',
    ticket: { path: 'thoughts/tickets/002-work.md', status: 'approved', sha256: 'u'.repeat(64) },
    plan: { path: 'thoughts/plans/002-f-work.md', status: 'approved', sha256: 'q'.repeat(64), approvedCommit: 'd'.repeat(40) },
    beads: { capabilitiesValid: true, healthValid: true, epic: secondEpic, openGates: [], escalations: [], orphans: [] },
    worktree: { path: '/tmp/work-2', branch: '002-f-work', head: 'e'.repeat(40), dirty: false },
    inspection: { context: shared, epic: secondEpic, children: [{ id: 'step-2', status: 'in_progress' }], plan: { activeSteps: [{ number: 1, files: ['lib/work.mjs'] }] } },
  });
  const result = buildSnapshot({ view: 'next', context: shared, diagnoses: [first, second], actor: 'sdlc:test:one', now: shared.now });
  assert(result.candidates[0].reasons.includes('file-overlap:lib/work.mjs'));
  assert.deepEqual(result.candidates[0].overlap, { plan: '002', path: 'lib/work.mjs' });
  assert.equal(declaredScopeOverlap('src/**/*.ts', 'src/api/user.ts'), true);
});

test('queue includes corroborating worktree evidence and optional merge-slot state only when present', () => {
  const disabled = context();
  const inFlight = diagnosis(disabled, {
    worktree: { path: '/tmp/work', branch: '001-f-work', head: 'e'.repeat(40), dirty: false, unpushed: 0, stashes: 0, lastCommitAt: 1 },
  });
  const queue = buildSnapshot({ view: 'queue', context: disabled, diagnoses: [inFlight], now: disabled.now });
  assert.equal(queue.sections.inFlight[0].worktree.head, 'e'.repeat(40));
  assert.equal(queue.beads.mergeSlot, undefined);

  const enabled = context({ native: { ready: { data: [] }, gates: { data: [] }, mergeSlot: { data: { id: 'slot', available: true } } } });
  const withSlot = buildSnapshot({ view: 'queue', context: enabled, diagnoses: [], now: enabled.now });
  assert.equal(withSlot.beads.mergeSlot.id, 'slot');
});

test('queue includes an in-progress chore discovered by the single global issue collection', () => {
  const shared = context({
    native: {
      ready: { data: [] },
      inProgress: { data: [{ id: 'chore-1', status: 'in_progress', assignee: 'sdlc:test:one', metadata: { sdlc_ticket: 'thoughts/tickets/003-chore.md' } }] },
      gates: { data: [] },
      worktrees: { data: [] },
      mergeSlot: null,
    },
  });
  const chore = diagnosis(shared, {
    number: '003',
    ticket: { path: 'thoughts/tickets/003-chore.md', status: 'approved', sha256: 'x'.repeat(64) },
    plan: null,
    state: 'blocked',
    errors: ['Chore-lane ticket intentionally has no plan; resume or recover it through /sdlc-chore, not /sdlc-plan.'],
    beads: { capabilitiesValid: true, healthValid: true, epic: null, openGates: [], escalations: [], orphans: [] },
    inspection: { context: shared, epic: null, children: [], plan: null },
  });
  const queue = buildSnapshot({ view: 'queue', context: shared, diagnoses: [chore], now: shared.now });
  assert.equal(queue.sections.inFlight[0].kind, 'chore');
  assert.equal(queue.sections.inFlight[0].issue, 'chore-1');
});
