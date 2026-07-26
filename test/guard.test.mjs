import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createDoctorInspectionContext } from '../lib/doctor.mjs';
import { evaluateGuard, formatGuard, GUARD_ACCEPTANCE_MATRIX, GUARD_STAGES, guardExitCode, inspectGuard, stageConfigProjection } from '../lib/guard.mjs';

function resolvedConfig(overrides = {}) {
  return {
    version: 1,
    path: '.agents/sdlc.json',
    localPath: null,
    targets: ['app'],
    qualityGates: ['npm test'],
    targetGates: { app: ['npm run test:app'] },
    targetPaths: { app: ['src/**'] },
    reviewers: { app: ['backend-code-reviewer'] },
    defaultReviewers: ['backend-code-reviewer'],
    productDocs: 'thoughts/docs/',
    frontendConstraints: 'none',
    beadsMode: 'embedded',
    mergeSlotEnabled: false,
    reviewEditor: null,
    localPreview: null,
    previewUrl: null,
    models: { defaults: { tier: 'balanced', effort: 'medium' }, roles: {}, tiers: {} },
    sources: {},
    errors: [],
    ...overrides,
  };
}

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
    config: resolvedConfig(),
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

test('a refusal carries every diagnosis error, coded error first, deduplicated', () => {
  const multi = diagnosis({
    state: 'blocked',
    errors: [
      'Plan has 1 stale in-progress Beads issue corroborated by worktree inactivity.',
      'Plan has 1 unresolved human escalation.',
    ],
  });
  const refused = evaluateGuard('plan', multi);
  assert.equal(refused.ok, false);
  assert.equal(refused.errors.length, 2);
  assert.equal(refused.errors[0].code, 'wrong-state');
  assert.equal(refused.errors[0].detail, multi.errors[0]);
  assert.deepEqual(refused.errors[1], { code: 'context', detail: 'Plan has 1 unresolved human escalation.', recovery: 'sdlc doctor 001 --json' });

  const single = diagnosis({ state: 'blocked', errors: ['Plan has 1 unresolved human escalation.'] });
  const soleRefusal = evaluateGuard('plan', single);
  assert.equal(soleRefusal.errors.length, 1);
  assert.equal(soleRefusal.errors[0].code, 'wrong-state');

  const partial = diagnosis({ state: 'blocked' });
  delete partial.errors;
  assert.doesNotThrow(() => evaluateGuard('plan', partial));
  const noErrors = evaluateGuard('plan', partial);
  assert.equal(noErrors.errors.length, 1);
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

test('discovery review requires a valid result only after implementation is complete', () => {
  const closed = diagnosis({
    inspection: { ...diagnosis().inspection, ticket: { frontmatter: { Type: 'discovery' } }, children: [{ id: 'step-1', status: 'closed' }] },
    discovery: { path: 'thoughts/designs/001-discovery.md', valid: false, errors: ['Discovery result artifact is missing.'] },
  });
  assert.equal(evaluateGuard('implement', closed).fields.mode, 'review');
  assert.equal(evaluateGuard('review', closed).errors[0].code, 'discovery-result-invalid');
  const valid = { ...closed, discovery: { path: 'thoughts/designs/001-discovery.md', outcome: 'invalidated', valid: true, errors: [] } };
  assert.equal(evaluateGuard('review', valid).fields.mode, 'pending');
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

test('a config-invalid refusal fires before any stage matrix runs, for every stage, carrying every remaining error as context', () => {
  const configErrors = [
    '.agents/sdlc.json: beads.mode "cluster" is not one of embedded|server.',
    '.agents/sdlc.json: beads.mergeSlot "maybe" is not one of off|on.',
    '.agents/sdlc.json: targets[0].name "App" does not match /^[a-z][a-z0-9-]*$/.',
  ];
  for (const stage of GUARD_STAGES) {
    const broken = diagnosis({ state: 'blocked', config: resolvedConfig({ errors: configErrors }) });
    const refused = evaluateGuard(stage, broken);
    assert.equal(refused.ok, false, stage);
    assert.equal(refused.stage, stage);
    assert.equal(refused.errors[0].code, 'config-invalid');
    assert.equal(refused.errors[0].detail, configErrors[0]);
    assert.equal(refused.errors[0].recovery, 'sdlc config');
    assert.equal(refused.errors.length, 3, stage);
    assert.deepEqual(
      refused.errors.slice(1),
      configErrors.slice(1).map((detail) => ({ code: 'context', detail, recovery: 'sdlc config' })),
      `every remaining config error must ride along untruncated for ${stage}`,
    );
  }
});

test('a diagnosis with no config field at all (existing hand-built tests) is treated as having no config errors', () => {
  const bare = diagnosis({ state: 'ready_for_planning', plan: null, beads: { capabilitiesValid: true, healthValid: true, epic: null, openGates: [], escalations: [], orphans: [] } });
  delete bare.config;
  delete bare.inspection.context.config;
  const result = evaluateGuard('plan', bare);
  assert.equal(result.ok, true);
  assert.equal(result.fields.mode, 'new-plan');
});

test('inspectGuard refuses every stage against a real invalid-config fixture, before any Beads call', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-guard-config-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({
    version: 1,
    targets: [],
    beads: { mode: 'sometimes', mergeSlot: 'maybe' },
  }));
  for (const stage of GUARD_STAGES) {
    const result = inspectGuard(stage, '001', { cwd: root, beadsExecutable: 'definitely-not-a-real-bd-binary' });
    assert.equal(result.ok, false, stage);
    assert.equal(result.errors[0].code, 'config-invalid', stage);
    assert.match(result.errors[0].detail, /beads\.mode "sometimes"/);
    assert.equal(result.errors.length, 2, stage);
    assert.equal(result.errors[1].code, 'context', stage);
    assert.match(result.errors[1].detail, /beads\.mergeSlot "maybe"/);
  }
});

test('implement and land accepted lines gain mergeSlot/beadsMode scalars while staying exactly one line; other stages do not', () => {
  const execute = evaluateGuard('implement', diagnosis({ config: resolvedConfig({ mergeSlotEnabled: true, beadsMode: 'server' }) }), { actor: 'sdlc:test:one' });
  assert.equal(execute.fields.mergeSlot, 'on');
  assert.equal(execute.fields.beadsMode, 'server');
  const executeLine = formatGuard(execute);
  assert.equal(executeLine.split('\n').length, 1);
  assert.match(executeLine, /mergeSlot=on beadsMode=server warnings=none$/);

  const closed = diagnosis({ inspection: { ...diagnosis().inspection, children: [{ id: 'step-1', status: 'closed' }] } });
  const review = evaluateGuard('implement', closed);
  assert.equal(review.fields.mergeSlot, 'off');
  assert.equal(review.fields.beadsMode, 'embedded');

  const land = evaluateGuard('land', diagnosis({
    inspection: { ...diagnosis().inspection, children: [{ id: 'step-1', status: 'closed' }] },
    review: { artifact: 'thoughts/reviews/001-round1.md', valid: true, verdict: 'APPROVED', codeSha: 'h'.repeat(40) },
    config: resolvedConfig({ mergeSlotEnabled: true }),
  }), { planSource: '# Plan\n\n## Approval Attention\n\nNone\n', allGates: [] });
  assert.equal(land.ok, true);
  assert.equal(land.fields.mergeSlot, 'on');
  assert.equal(land.fields.beadsMode, 'embedded');
  assert.equal(formatGuard(land).split('\n').length, 1);

  const planAccepted = evaluateGuard('plan', diagnosis({ state: 'ready_for_planning', plan: null, beads: { capabilitiesValid: true, healthValid: true, epic: null, openGates: [], escalations: [], orphans: [] } }));
  assert.equal('mergeSlot' in planAccepted.fields, false);
  assert.equal('beadsMode' in planAccepted.fields, false);

  const approveAccepted = evaluateGuard('approve', diagnosis());
  assert.equal('mergeSlot' in approveAccepted.fields, false);

  const reviewAccepted = evaluateGuard('review', closed);
  assert.equal('mergeSlot' in reviewAccepted.fields, false);
});

test('stageConfigProjection returns the documented shape per stage', () => {
  const config = resolvedConfig();
  const plan = stageConfigProjection('plan', config);
  assert.deepEqual(Object.keys(plan).sort(), ['frontendConstraints', 'gates', 'productDocs', 'targets']);
  assert.deepEqual(plan.targets, ['app']);
  assert.deepEqual(plan.gates, { global: ['npm test'], byTarget: { app: ['npm run test:app'] } });
  assert.equal(plan.productDocs, 'thoughts/docs/');
  assert.equal(plan.frontendConstraints, 'none');

  for (const stage of ['implement', 'land']) {
    const projection = stageConfigProjection(stage, config);
    assert.deepEqual(Object.keys(projection).sort(), ['beads', 'gates', 'targets'], stage);
    assert.deepEqual(projection.beads, { mode: 'embedded', mergeSlot: 'off' }, stage);
    assert.deepEqual(projection.gates, { global: ['npm test'], byTarget: { app: ['npm run test:app'] } }, stage);
    assert.deepEqual(projection.targets, { app: { paths: ['src/**'], gates: ['npm run test:app'], reviewers: ['backend-code-reviewer'] } }, stage);
  }

  for (const stage of ['approve', 'review']) {
    const projection = stageConfigProjection(stage, config);
    assert.deepEqual(Object.keys(projection), ['beads'], stage);
    assert.deepEqual(projection.beads, { mode: 'embedded', mergeSlot: 'off' }, stage);
  }
});

test('sdlc guard <stage> <NNN> --json prints the guard result plus its stage-scoped config projection', () => {
  const packageRoot = join(dirname(new URL(import.meta.url).pathname), '..');
  const cli = join(packageRoot, 'bin', 'sdlc.mjs');
  const root = mkdtempSync(join(tmpdir(), 'sdlc-guard-cli-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  mkdirSync(join(root, '.agents'), { recursive: true });
  // An invalid config refuses deterministically before any Beads call, so
  // this exercise needs no real `bd` installation on the test machine.
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({ version: 1, targets: [], beads: { mode: 'sometimes' } }));

  const plain = spawnSync(process.execPath, [cli, 'guard', 'plan', '001'], { cwd: root, encoding: 'utf8' });
  assert.match(plain.stdout, /^REFUSED stage=plan number=001 state=/);
  assert.match(plain.stdout, /ERROR code=config-invalid detail=/);

  const json = spawnSync(process.execPath, [cli, 'guard', 'implement', '001', '--json'], { cwd: root, encoding: 'utf8' });
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors[0].code, 'config-invalid');
  assert.match(parsed.errors[0].detail, /beads\.mode "sometimes"/);
  assert.deepEqual(Object.keys(parsed.config).sort(), ['beads', 'gates', 'targets']);
});

test('every guard result carries a stage-scoped config key that the one-line formatter ignores', () => {
  const ready = diagnosis({ state: 'ready_for_planning', plan: null, beads: { capabilitiesValid: true, healthValid: true, epic: null, openGates: [], escalations: [], orphans: [] } });
  const accepted = evaluateGuard('plan', ready);
  assert.ok(accepted.config);
  assert.deepEqual(Object.keys(accepted.config).sort(), ['frontendConstraints', 'gates', 'productDocs', 'targets']);
  assert.equal(formatGuard(accepted).includes('config'), false);

  const refused = evaluateGuard('plan', diagnosis());
  assert.ok(refused.config);
  assert.equal(formatGuard(refused).includes('config'), false);
});

// `gate-history-unavailable` is raised by `inspectGuard` itself rather than by
// `evaluateGuard`, so it is the one refusal that could silently ship without
// the `config` key every other result carries.
test('the gate-history-unavailable refusal raised outside evaluateGuard still carries its config projection', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-guard-gate-history-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({
    version: 1,
    targets: [{ name: 'app', paths: ['src/**'], gates: ['npm run test:app'] }],
    gates: ['npm test'],
  }));

  const base = createDoctorInspectionContext({ cwd: root, beadsExecutable: 'definitely-not-a-real-bd-binary' });
  const context = {
    ...base,
    adapter: { listGates: () => { throw new Error('bd gate history is unavailable'); } },
  };
  const result = inspectGuard('land', '001', { cwd: root, inspectionContext: context });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'gate-history-unavailable');
  assert.deepEqual(Object.keys(result.config).sort(), ['beads', 'gates', 'targets']);
  assert.deepEqual(result.config.gates, { global: ['npm test'], byTarget: { app: ['npm run test:app'] } });
});
