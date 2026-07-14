import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { doctorExitCode, evaluateArtifactState, inspectDoctor, latestReproducibleApproval, parseApprovalRecords, parseRebaseRecords, parseReviewApprovalRecords, parseWaiverRecords, pathMatchesScope } from '../lib/doctor.mjs';
import { fingerprintContent } from '../lib/fingerprint.mjs';
import { parsePlan, parseTicket } from '../lib/artifacts.mjs';

const packageRoot = join(dirname(new URL(import.meta.url).pathname), '..');
const installedBeads = spawnSync('bd', ['--version'], { encoding: 'utf8' }).status === 0;

function ticketSource(status = 'approved') {
  return `---
Status: ${status}
Tags: [app, export]
Type: feature
Target: app
---

# Export

## Acceptance Criteria

- AC-001: Export succeeds.
`;
}

function planSource(ticketHash, { status = 'approved', epic = 'test-epic', instruction = 'Implement it.', extraStep = false } = {}) {
  return `---
Status: ${status}
Tags: [app, export]
Type: feature
Target: app
Ticket Origin: thoughts/tickets/023-export.md
Source Ticket Hash: sha256=${ticketHash}
Beads Epic: ${epic}
---

# Export plan

## Current-State Findings

| Area or path | Finding | Evidence | Implication |
|---|---|---|---|
| lib | Existing | \`lib/export.mjs:1\` | Extend |

## Approval Attention

None

### Step 1 - Export

Covers: AC-001
Files:
- lib/export.mjs
Depends on: none
Parallelizable: no

${instruction}

${extraStep ? `### Step 2 - Audit

Covers: none - operational instrumentation
Files:
- lib/audit.mjs
Depends on: none
Parallelizable: yes

Add audit instrumentation.

` : ''}## Verification

- AC-001: run export integration test.

## Plan Critique

Pass 1 Verdict: APPROVED
`;
}

function createRepository({ planStatus = 'approved', extraStep = false, mergeSlot = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-doctor-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  mkdirSync(join(root, 'thoughts', 'tickets'), { recursive: true });
  mkdirSync(join(root, 'thoughts', 'plans'), { recursive: true });
  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), `# Workflow\n\n## Project Configuration\n\n- **Beads mode:** \`embedded\`\n- **Beads merge slot:** \`${mergeSlot ? 'on' : 'off'}\`\n`);
  const ticket = ticketSource();
  const plan = planSource(fingerprintContent(ticket), { status: planStatus, epic: planStatus === 'review' ? '' : 'test-epic', extraStep });
  writeFileSync(join(root, 'thoughts', 'tickets', '023-export.md'), ticket);
  writeFileSync(join(root, 'thoughts', 'plans', '023-f-export.md'), plan);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'plan: approve export (ticket 023)'], { cwd: root, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return {
    root,
    commit,
    ticket,
    plan,
    ticketHash: fingerprintContent(ticket),
    planHash: fingerprintContent(plan),
    extraStep,
  };
}

function fakeBeadsRunner({
  approval,
  commit,
  ticketHash,
  planHash,
  missingCommit = false,
  extraStep = false,
  gates = [],
  ready,
  mergeSlot,
  worktreePath,
  reviewLine = '',
  epicStatus = 'open',
  childStatus = 'open',
  childDependencies = [],
  childDescription = 'Files: lib/export.mjs',
  extraChild = false,
} = {}) {
  return (_executable, args) => {
    const key = args.join(' ');
    const capabilityKey = (args[0] === '--readonly' ? args.slice(1) : args).join(' ');
    if (capabilityKey === '--version') return { status: 0, stdout: 'bd version 1.1.0', stderr: '' };
    if (capabilityKey.endsWith('--help')) {
      let stdout = '';
      if (capabilityKey === '--help') stdout = '--readonly update gate worktree doctor dep stale orphans';
      else if (capabilityKey === 'update --help') stdout = '--claim --spec-id --set-metadata';
      else if (capabilityKey === 'gate --help') stdout = 'create resolve list';
      else if (capabilityKey === 'worktree --help') stdout = 'create remove list';
      else if (capabilityKey === 'doctor --help') stdout = '--agent --server';
      else if (capabilityKey === 'dep add --help') stdout = '--file';
      else if (capabilityKey === 'dep cycles --help') stdout = 'Detect dependency cycles';
      else if (capabilityKey === 'stale --help') stdout = '--status';
      else if (capabilityKey === 'orphans --help') stdout = '--fix';
      else if (capabilityKey === 'create --help') stdout = '--spec-id';
      else if (capabilityKey === 'batch --help') stdout = 'single dolt transaction';
      else if (capabilityKey === 'merge-slot --help') stdout = 'acquire release check';
      return { status: 0, stdout, stderr: '' };
    }
    const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    if (key.includes('doctor --agent')) return json({ checks: [] });
    if (key.includes('context')) return json({ mode: 'embedded' });
    if (key.includes('ready')) return json(ready ?? [{ id: 'test-step' }, ...(extraStep ? [{ id: 'test-step-2' }] : [])]);
    if (key.includes('dep cycles')) return json([]);
    if (key.includes('worktree list')) return json(worktreePath ? [{ path: worktreePath, branch: '023-f-export', beads_state: 'local' }] : []);
    if (key.includes('gate list')) return json(gates);
    if (key.includes('dep list gate-1')) return json([{ id: gates[0]?.blocks ?? 'test-step' }]);
    if (key.includes('human list')) return json([]);
    if (key.includes('stale')) return json([]);
    if (key.includes('orphans')) return json([]);
    if (key.includes('merge-slot check')) return json(mergeSlot ?? { available: true });
    if (key.includes('show test-epic')) {
      const approvalLine = approval === false
        ? ''
        : `approval: plan-sha256=${planHash} ticket-sha256=${ticketHash} commit=${missingCommit ? 'd'.repeat(40) : commit}`;
      return json({
        id: 'test-epic',
        status: epicStatus,
        spec_id: 'thoughts/plans/023-f-export.md',
        metadata: { sdlc_ticket: 'thoughts/tickets/023-export.md', sdlc_plan: 'thoughts/plans/023-f-export.md' },
        notes: [approvalLine, reviewLine].filter(Boolean).join('\n'),
      });
    }
    if (key.includes('list --parent test-epic')) return json([{
      id: 'test-step',
      status: childStatus,
      spec_id: 'thoughts/plans/023-f-export.md',
      metadata: { sdlc_ticket: 'thoughts/tickets/023-export.md', sdlc_plan: 'thoughts/plans/023-f-export.md', sdlc_step: '1' },
    }, ...(extraStep ? [{
      id: 'test-step-2',
      status: childStatus,
      spec_id: 'thoughts/plans/023-f-export.md',
      metadata: { sdlc_ticket: 'thoughts/tickets/023-export.md', sdlc_plan: 'thoughts/plans/023-f-export.md', sdlc_step: '2' },
    }] : []), ...(extraChild ? [{
      id: 'stray-child',
      status: 'open',
      spec_id: 'thoughts/plans/023-f-export.md',
      metadata: { sdlc_ticket: 'thoughts/tickets/023-export.md', sdlc_plan: 'thoughts/plans/023-f-export.md' },
    }] : [])]);
    if (key.includes('show stray-child')) return json({
      id: 'stray-child',
      status: 'open',
      spec_id: 'thoughts/plans/023-f-export.md',
      metadata: { sdlc_ticket: 'thoughts/tickets/023-export.md', sdlc_plan: 'thoughts/plans/023-f-export.md' },
      description: 'Files: lib/stray.mjs',
      dependencies: [],
    });
    if (key.includes('show test-step-2')) return json({
      id: 'test-step-2',
      status: childStatus,
      spec_id: 'thoughts/plans/023-f-export.md',
      metadata: { sdlc_ticket: 'thoughts/tickets/023-export.md', sdlc_plan: 'thoughts/plans/023-f-export.md', sdlc_step: '2' },
      description: 'Files: lib/audit.mjs',
      dependencies: [],
    });
    if (key.includes('show test-step')) return json({
      id: 'test-step',
      status: childStatus,
      spec_id: 'thoughts/plans/023-f-export.md',
      metadata: { sdlc_ticket: 'thoughts/tickets/023-export.md', sdlc_plan: 'thoughts/plans/023-f-export.md', sdlc_step: '1' },
      description: childDescription,
      dependencies: childDependencies,
    });
    return { status: 1, stdout: '', stderr: `unhandled fake bd call: ${key}` };
  };
}

test('approval and review approval note grammars are append-only parseable', () => {
  const approval = parseApprovalRecords(`approval: plan-sha256=${'a'.repeat(64)} ticket-sha256=${'b'.repeat(64)} commit=${'c'.repeat(40)}\napproval: bad`);
  assert.equal(approval.records.length, 1);
  assert.equal(approval.malformed.length, 1);
  const reviews = parseReviewApprovalRecords(`review: APPROVED sha=${'a'.repeat(40)} code-sha=${'b'.repeat(40)} plan-sha256=${'c'.repeat(64)} plan-commit=${'d'.repeat(40)} rounds=2`);
  assert.equal(reviews.records[0].rounds, 2);
  const rebases = parseRebaseRecords(`rebased: ${'a'.repeat(40)}->${'b'.repeat(40)} gates=pass\nrebased: malformed`);
  assert.equal(rebases.records.length, 1);
  assert.equal(rebases.malformed.length, 1);
  const waivers = parseWaiverRecords('waiver: id=AC-002; reason=external contract\ndiscuss waiver: id=AC-003; reason=example');
  assert.deepEqual(waivers.records.map((record) => record.id), ['AC-002']);
  assert.equal(waivers.malformed.length, 1);
});

test('declared scope matching handles directories and recursive globs', () => {
  assert.equal(pathMatchesScope('src/server/export.ts', 'src'), true);
  assert.equal(pathMatchesScope('src/server/export.ts', 'src/**/*.ts'), true);
  assert.equal(pathMatchesScope('src/export.ts', 'src/**/*.ts'), true);
  assert.equal(pathMatchesScope('src/server/export.js', 'src/**/*.ts'), false);
  assert.equal(pathMatchesScope('lib/a.mjs', 'lib/*.mjs'), true);
  assert.equal(pathMatchesScope('lib/nested/a.mjs', 'lib/*.mjs'), false);
});

test('latest reproducible approval binds committed artifact bytes', () => {
  const fixture = createRepository();
  const result = latestReproducibleApproval({
    root: fixture.root,
    records: [{ planSha256: fixture.planHash, ticketSha256: fixture.ticketHash, commit: fixture.commit }],
    ticketPath: 'thoughts/tickets/023-export.md',
    planPath: 'thoughts/plans/023-f-export.md',
  });
  assert.equal(result.record.commit, fixture.commit);
});

test('historical approval artifacts must also be valid UTF-8', () => {
  const fixture = createRepository();
  writeFileSync(join(fixture.root, 'thoughts', 'tickets', '023-export.md'), Buffer.from([0xff, 0xfe]));
  execFileSync('git', ['add', 'thoughts/tickets/023-export.md'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-m', 'corrupt historical ticket'], { cwd: fixture.root, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).trim();
  const result = latestReproducibleApproval({
    root: fixture.root,
    records: [{ planSha256: 'a'.repeat(64), ticketSha256: 'b'.repeat(64), commit }],
    ticketPath: 'thoughts/tickets/023-export.md',
    planPath: 'thoughts/plans/023-f-export.md',
  });
  assert.equal(result.record, null);
  assert(result.rejected[0].reason.includes('cannot be fingerprinted'));
});

test('doctor reports a healthy reproducible approval with native mappings', () => {
  const fixture = createRepository();
  const result = inspectDoctor('23', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner(fixture),
  });
  assert.equal(result.state, 'healthy', JSON.stringify(result, null, 2));
  assert.equal(result.plan.approvedCommit, fixture.commit);
  assert.equal(result.beads.mappingValid, true);
  assert.equal(doctorExitCode(result), 0);
});

test('doctor validates the structured review binding in a linked worktree', () => {
  const fixture = createRepository();
  const worktree = join(fixture.root, 'review-worktree');
  execFileSync('git', ['worktree', 'add', '-b', '023-f-export', worktree], { cwd: fixture.root, stdio: 'ignore' });
  mkdirSync(join(worktree, 'lib'), { recursive: true });
  writeFileSync(join(worktree, 'lib', 'export.mjs'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'lib/export.mjs'], { cwd: worktree });
  execFileSync('git', ['commit', '-m', 'step 1: export (test-step)'], { cwd: worktree, stdio: 'ignore' });
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  mkdirSync(join(worktree, 'thoughts', 'reviews'), { recursive: true });
  const artifact = `# Automated Review — 023 round 1
Reviewed code SHA: ${codeSha}
Approved plan SHA256: ${fixture.planHash}
Approved plan commit: ${fixture.commit}
Reviewers: backend-code-reviewer

## backend-code-reviewer

## Review — export

### Clean-Pass Evidence

- Ticket intent and ACs checked: AC-001.
- Plan steps and deviations checked: no deviation.
- Canonical repository siblings and conventions inspected: lib/export.mjs.
- Tests and failure paths examined: fixture test and invalid input.
- Risk surfaces considered: security, data, performance, accessibility, and operational risk.

Verdict: APPROVED

## Overall

Scope-Check: PASS - unplanned=none
AC-Coverage: PASS - verified=AC-001; missing=none
Fix-Disposition: N/A

- backend-code-reviewer: APPROVED

Verdict: APPROVED
`;
  writeFileSync(join(worktree, 'thoughts', 'reviews', '023-round1.md'), artifact);
  execFileSync('git', ['add', 'thoughts/reviews/023-round1.md'], { cwd: worktree });
  execFileSync('git', ['commit', '-m', 'review: approve export (ticket 023)'], { cwd: worktree, stdio: 'ignore' });
  const artifactSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  const reviewLine = `review: APPROVED sha=${artifactSha} code-sha=${codeSha} plan-sha256=${fixture.planHash} plan-commit=${fixture.commit} rounds=1`;
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      worktreePath: worktree,
      reviewLine,
      epicStatus: 'in_progress',
      childStatus: 'closed',
      ready: [],
    }),
  });
  assert.equal(result.state, 'healthy', JSON.stringify(result, null, 2));
  assert.equal(result.review.valid, true);
  assert.equal(result.review.codeSha, codeSha);
  assert.equal(result.worktree.beadsState, 'local');
  assert(result.warnings.some((warning) => warning.includes('unpushed commits')));

  const mismatchedBinding = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      worktreePath: worktree,
      reviewLine: reviewLine.replace(`code-sha=${codeSha}`, `code-sha=${fixture.commit}`),
      epicStatus: 'in_progress',
      childStatus: 'closed',
      ready: [],
    }),
  });
  assert.equal(mismatchedBinding.state, 'blocked');
  assert.equal(mismatchedBinding.review.valid, false);

  writeFileSync(join(fixture.root, 'base.txt'), 'new main base\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: fixture.root });
  execFileSync('git', ['commit', '-m', 'advance main'], { cwd: fixture.root, stdio: 'ignore' });
  execFileSync('git', ['rebase', 'main'], { cwd: worktree, stdio: 'ignore' });
  const rebasedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  const rebasedResult = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      worktreePath: worktree,
      reviewLine: `${reviewLine}\nrebased: ${artifactSha}->${rebasedHead} gates=pass`,
      epicStatus: 'in_progress',
      childStatus: 'closed',
      ready: [],
    }),
  });
  assert.equal(rebasedResult.state, 'healthy', JSON.stringify(rebasedResult, null, 2));
  assert.equal(rebasedResult.review.rebaseHops, 1);

  const artifactPath = join(worktree, 'thoughts', 'reviews', '023-round1.md');
  writeFileSync(artifactPath, artifact.replace(`Reviewed code SHA: ${codeSha}\n`, ''));
  const malformedResult = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      worktreePath: worktree,
      reviewLine: `${reviewLine}\nrebased: ${artifactSha}->${rebasedHead} gates=pass`,
      epicStatus: 'in_progress',
      childStatus: 'closed',
      ready: [],
    }),
  });
  assert.equal(malformedResult.state, 'blocked');
  assert(malformedResult.errors.some((error) => error.includes('exactly one valid Reviewed code SHA')));
});

test('doctor validates a real embedded Beads approval fixture', { skip: !installedBeads, timeout: 60_000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-doctor-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  const environment = { ...process.env, BEADS_ACTOR: 'sdlc:test:doctor-native' };
  execFileSync('bd', ['init', '--non-interactive', '--skip-hooks', '--skip-agents', '--prefix', 'sdlctest'], { cwd: root, env: environment, stdio: 'ignore' });
  mkdirSync(join(root, 'thoughts', 'tickets'), { recursive: true });
  mkdirSync(join(root, 'thoughts', 'plans'), { recursive: true });
  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), '# Workflow\n\n## Project Configuration\n\n- **Beads mode:** `embedded`\n- **Beads merge slot:** `off`\n');
  const ticket = ticketSource();
  const ticketPath = 'thoughts/tickets/023-export.md';
  const planPath = 'thoughts/plans/023-f-export.md';
  writeFileSync(join(root, ticketPath), ticket);
  const epic = JSON.parse(execFileSync('bd', [
    'create', 'Export plan', '--type=epic', `--spec-id=${planPath}`,
    `--metadata=${JSON.stringify({ sdlc_ticket: ticketPath, sdlc_plan: planPath })}`, '--json',
  ], { cwd: root, env: environment, encoding: 'utf8' }));
  execFileSync('bd', [
    'create', 'Export step', '--type=task', `--parent=${epic.id}`, `--spec-id=${planPath}`,
    `--metadata=${JSON.stringify({ sdlc_ticket: ticketPath, sdlc_plan: planPath, sdlc_step: '1' })}`,
    '--description=Files: lib/export.mjs', '--json',
  ], { cwd: root, env: environment, stdio: 'ignore' });
  const plan = planSource(fingerprintContent(ticket), { epic: epic.id });
  writeFileSync(join(root, planPath), plan);
  execFileSync('git', ['add', 'thoughts'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'plan: approve export (ticket 023)'], { cwd: root, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const approval = `approval: plan-sha256=${fingerprintContent(plan)} ticket-sha256=${fingerprintContent(ticket)} commit=${commit}`;
  execFileSync('bd', ['update', epic.id, `--append-notes=${approval}`], { cwd: root, env: environment, stdio: 'ignore' });

  const result = inspectDoctor('023', { cwd: root });
  assert.equal(result.state, 'healthy', JSON.stringify(result, null, 2));
  assert.equal(result.beads.healthSupported, false);
  assert.equal(result.beads.mappingValid, true);
  assert.equal(result.warnings.some((warning) => warning.includes('undeclared Beads dependency')), false);
});

test('doctor reports approval drift before implementation can claim', () => {
  const fixture = createRepository();
  writeFileSync(join(fixture.root, 'thoughts', 'plans', '023-f-export.md'), fixture.plan.replace('Implement it.', 'Implement it safely.'));
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner(fixture),
  });
  assert.equal(result.state, 'reapproval_required', JSON.stringify(result, null, 2));
  assert.equal(doctorExitCode(result), 2);
});

test('doctor blocks undeclared Beads dependency edges', () => {
  const fixture = createRepository();
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      childDependencies: [{ id: 'external-blocker', dependency_type: 'blocks' }],
    }),
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.beads.mappingValid, false);
  assert(result.errors.some((error) => error.includes('undeclared Beads dependency external-blocker')));
});

test('doctor blocks stale open-step file scope in Beads', () => {
  const fixture = createRepository();
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({ ...fixture, childDescription: 'Files: lib/old-export.mjs' }),
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.beads.mappingValid, false);
  assert(result.errors.some((error) => error.includes('does not reflect its current Files scope')));
});

test('doctor blocks Beads epic children without exact step identity', () => {
  const fixture = createRepository();
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({ ...fixture, extraChild: true }),
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.beads.mappingValid, false);
  assert(result.errors.some((error) => error.includes('missing or invalid sdlc_step metadata')));
});

test('doctor projects empty server health responses as invalid', () => {
  const fixture = createRepository();
  writeFileSync(join(fixture.root, 'thoughts', 'AGENTS.md'), '# Workflow\n\n## Project Configuration\n\n- **Beads mode:** `server`\n- **Beads merge slot:** `off`\n');
  const fallback = fakeBeadsRunner(fixture);
  const runner = (executable, args) => {
    const key = args.join(' ');
    if (key.includes('doctor --agent') || key.includes('doctor --server')) return { status: 0, stdout: '', stderr: '' };
    if (key.includes('context')) return { status: 0, stdout: JSON.stringify({ mode: 'server' }), stderr: '' };
    return fallback(executable, args);
  };
  const result = inspectDoctor('023', { cwd: fixture.root, beadsRunner: runner });
  assert.equal(result.state, 'blocked');
  assert.equal(result.beads.healthValid, false);
  assert.equal(result.beads.healthSupported, false);
  assert(result.errors.some((error) => error.includes('empty diagnostic response')));
});

test('doctor blocks invalid UTF-8 artifacts instead of throwing', () => {
  const fixture = createRepository();
  writeFileSync(join(fixture.root, 'thoughts', 'tickets', '023-export.md'), Buffer.from([0xff, 0xfe]));
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner(fixture),
  });
  assert.equal(result.state, 'blocked');
  assert(result.errors.some((error) => error.includes('could not be read and fingerprinted')));
});

test('doctor rejects invalid native coordination configuration values', () => {
  const fixture = createRepository();
  writeFileSync(join(fixture.root, 'thoughts', 'AGENTS.md'), '# Workflow\n\n- **Beads mode:** `sometimes`\n- **Beads merge slot:** `maybe`\n');
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner(fixture),
  });
  assert.equal(result.state, 'blocked');
  assert(result.errors.some((error) => error.includes('invalid Beads mode')));
  assert(result.errors.some((error) => error.includes('invalid Beads merge slot')));
});

test('doctor leaves amendment mapping deltas for approve instead of deadlocking reapproval', () => {
  const fixture = createRepository();
  const amended = planSource(fixture.ticketHash, { extraStep: true });
  writeFileSync(join(fixture.root, 'thoughts', 'plans', '023-f-export.md'), amended);
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner(fixture),
  });
  assert.equal(result.state, 'reapproval_required', JSON.stringify(result, null, 2));
  assert.equal(result.beads.mappingValid, false);
  assert(result.warnings.some((warning) => warning.includes('Pending /approve sync: Active plan step 2 has no Beads child mapping')));
});

test('doctor ignores a cancelled prior plan when an approved ticket is ready to plan again', () => {
  const fixture = createRepository({ planStatus: 'cancelled' });
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner(fixture),
  });
  assert.equal(result.state, 'ready_for_planning', JSON.stringify(result, null, 2));
  assert.equal(result.plan, null);
});

test('doctor reports an open gate without freezing unrelated ready children', () => {
  const fixture = createRepository({ extraStep: true });
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      gates: [{ id: 'gate-1', blocks: 'test-step', description: 'Ad-hoc gate blocking test-step\n\nReason: Choose export format' }],
      ready: [{ id: 'test-step-2' }],
    }),
  });
  assert.equal(result.state, 'healthy', JSON.stringify(result, null, 2));
  assert.equal(result.beads.openGates.length, 1);
  assert.equal(result.beads.openGates[0].blocks, 'test-step');
  assert.equal(result.beads.openGates[0].reason, 'Choose export format');
  assert(result.warnings.some((warning) => warning.includes('unrelated child remains ready')));
});

test('doctor blocks when an open gate leaves no plan child ready', () => {
  const fixture = createRepository();
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      gates: [{ id: 'gate-1', blocks: 'test-step' }],
      ready: [],
    }),
  });
  assert.equal(result.state, 'blocked', JSON.stringify(result, null, 2));
  assert(result.errors.some((error) => error.includes('open human gate')));
});

test('doctor projects configured merge-slot holder age', () => {
  const fixture = createRepository({ mergeSlot: true });
  const now = Date.parse('2026-07-13T12:01:00Z');
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    now,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      mergeSlot: { holder: 'sdlc:codex:landing', updated_at: '2026-07-13T12:00:00Z', available: false },
    }),
  });
  assert.equal(result.state, 'healthy', JSON.stringify(result, null, 2));
  assert.equal(result.mergeSlot.ageSeconds, 60);
  assert(result.warnings.some((warning) => warning.includes('age 60s')));
});

test('doctor blocks an enabled merge slot until it is initialized', () => {
  const fixture = createRepository({ mergeSlot: true });
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({
      ...fixture,
      mergeSlot: { id: 'test-merge-slot', available: false, error: 'not found' },
    }),
  });
  assert.equal(result.state, 'blocked', JSON.stringify(result, null, 2));
  assert.equal(result.mergeSlot.error, 'not found');
  assert(result.errors.some((error) => error.includes('bd merge-slot create')));
});

test('doctor blocks an approval whose only commit cannot be reproduced', () => {
  const fixture = createRepository();
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({ ...fixture, missingCommit: true }),
  });
  assert.equal(result.state, 'blocked', JSON.stringify(result, null, 2));
  assert(result.errors.some((error) => error.includes('No approval record is reproducible')));
  assert.equal(doctorExitCode(result), 3);
});

test('artifact-state projection distinguishes planning, approval, legacy, and drift', () => {
  const source = ticketSource();
  const ticket = parseTicket(source);
  const ticketHash = fingerprintContent(source);
  assert.equal(evaluateArtifactState({ ticket, ticketSha256: ticketHash }).state, 'ready_for_planning');
  const planSourceText = planSource(ticketHash, { status: 'review', epic: '' });
  const plan = parsePlan(planSourceText, { ticket });
  assert.equal(evaluateArtifactState({ ticket, plan, ticketSha256: ticketHash, planSha256: fingerprintContent(planSourceText) }).state, 'ready_for_approval');
  const legacy = { ...plan, sourceTicketSha256: undefined, sourceTicketHashPresent: false };
  assert.equal(evaluateArtifactState({ ticket, plan: legacy, ticketSha256: ticketHash }).state, 'legacy');
  const draftTicketSource = ticketSource('draft');
  const draftTicket = parseTicket(draftTicketSource);
  const draftPlanSource = planSource(fingerprintContent(draftTicketSource));
  const draftPlan = parsePlan(draftPlanSource, { ticket: draftTicket });
  assert.equal(evaluateArtifactState({
    ticket: draftTicket,
    plan: draftPlan,
    ticketSha256: fingerprintContent(draftTicketSource),
    planSha256: fingerprintContent(draftPlanSource),
    approval: { ticketSha256: fingerprintContent(draftTicketSource), planSha256: fingerprintContent(draftPlanSource) },
  }).state, 'blocked');
});

test('public hash and actor commands emit stable machine-readable single lines', () => {
  const fixture = createRepository();
  const cli = join(packageRoot, 'bin', 'sdlc.mjs');
  const hash = execFileSync(process.execPath, [cli, 'hash', join(fixture.root, 'thoughts', 'tickets', '023-export.md')], { encoding: 'utf8' }).trim();
  assert.equal(hash, `sha256=${fixture.ticketHash}`);
  const actorEnvironment = { ...process.env, SDLC_SESSION_ID: 'fixture-session', BEADS_ACTOR: '' };
  const actor = execFileSync(process.execPath, [cli, 'actor', 'test', '--new'], {
    encoding: 'utf8',
    cwd: fixture.root,
    env: actorEnvironment,
  }).trim();
  assert.match(actor, /^sdlc:test:[A-Za-z0-9._:-]+$/);
  const restored = execFileSync(process.execPath, [cli, 'actor', 'test'], { encoding: 'utf8', cwd: fixture.root, env: actorEnvironment }).trim();
  assert.equal(restored, actor);

  const otherEnvironment = { ...process.env, SDLC_SESSION_ID: 'other-session', BEADS_ACTOR: '' };
  const other = execFileSync(process.execPath, [cli, 'actor', 'test', '--new'], { encoding: 'utf8', cwd: fixture.root, env: otherEnvironment }).trim();
  assert.notEqual(other, actor);
  assert.equal(execFileSync(process.execPath, [cli, 'actor', 'test'], { encoding: 'utf8', cwd: fixture.root, env: actorEnvironment }).trim(), actor);

  const rotated = execFileSync(process.execPath, [cli, 'actor', 'test', '--new'], { encoding: 'utf8', cwd: fixture.root, env: actorEnvironment }).trim();
  assert.notEqual(rotated, actor);
  const linkedWorktree = join(fixture.root, 'actor-worktree');
  execFileSync('git', ['worktree', 'add', '-b', 'actor-fixture', linkedWorktree], { cwd: fixture.root, stdio: 'ignore' });
  const fromWorktree = execFileSync(process.execPath, [cli, 'actor', 'test'], { encoding: 'utf8', cwd: linkedWorktree, env: actorEnvironment }).trim();
  assert.equal(fromWorktree, rotated);
});

test('doctor marks a completely unavailable Beads executable as dependency unavailable', () => {
  const fixture = createRepository({ planStatus: 'review' });
  const result = inspectDoctor('023', { cwd: fixture.root, beadsExecutable: 'definitely-not-a-real-bd-binary' });
  assert.equal(result.state, 'blocked');
  assert(result.errors.some((error) => error.includes('unavailable')));
  assert.equal(doctorExitCode(result), 1);
});

test('setup --skip-beads scaffolds without enabling Beads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-setup-skip-'));
  const cli = join(packageRoot, 'bin', 'sdlc.mjs');
  const result = spawnSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(directory, 'thoughts', 'AGENTS.md')), true);
  assert.equal(existsSync(join(directory, '.beads')), false);
});

test('setup fails before scaffolding with an unsupported Beads binary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-setup-old-'));
  const binaries = join(directory, 'bin');
  mkdirSync(binaries);
  const fake = join(binaries, 'bd');
  writeFileSync(fake, '#!/bin/sh\necho "bd version 1.0.0"\n');
  chmodSync(fake, 0o755);
  const cli = join(packageRoot, 'bin', 'sdlc.mjs');
  const result = spawnSync(process.execPath, [cli, 'setup', '--skip-skills', '--skip-agents'], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binaries}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot set up the Beads-backed workflow/);
  assert.equal(existsSync(join(directory, '.git')), false);
});

function overriddenRunner(fixture, respond) {
  const fallback = fakeBeadsRunner(fixture);
  return (executable, args) => {
    const key = args.join(' ');
    if (!key.includes('--help')) {
      const response = respond(key);
      if (response) return response;
    }
    return fallback(executable, args);
  };
}

test('doctor invalidates the plan source hash when the canonical ticket is edited', () => {
  const fixture = createRepository();
  writeFileSync(
    join(fixture.root, 'thoughts', 'tickets', '023-export.md'),
    fixture.ticket.replace('Export succeeds.', 'Export succeeds quickly.'),
  );
  const result = inspectDoctor('023', { cwd: fixture.root, beadsRunner: fakeBeadsRunner(fixture) });
  assert.equal(result.state, 'reapproval_required', JSON.stringify(result, null, 2));
  assert(result.errors.some((error) => error.includes('Plan source-ticket hash differs from the canonical ticket')));
  assert.equal(doctorExitCode(result), 2);
});

test('doctor keeps the latest reproducible approval when later records are malformed or unreproducible', () => {
  const fixture = createRepository();
  const notes = [
    `approval: plan-sha256=${fixture.planHash} ticket-sha256=${fixture.ticketHash} commit=${fixture.commit}`,
    `approval: plan-sha256=${fixture.planHash} ticket-sha256=${fixture.ticketHash} commit=${'d'.repeat(40)}`,
    'approval: garbled later record',
  ].join('\n');
  const runner = overriddenRunner(fixture, (key) => {
    if (!key.includes('show test-epic')) return undefined;
    return {
      status: 0,
      stdout: JSON.stringify({
        id: 'test-epic',
        status: 'open',
        spec_id: 'thoughts/plans/023-f-export.md',
        metadata: { sdlc_ticket: 'thoughts/tickets/023-export.md', sdlc_plan: 'thoughts/plans/023-f-export.md' },
        notes,
      }),
      stderr: '',
    };
  });
  const result = inspectDoctor('023', { cwd: fixture.root, beadsRunner: runner });
  assert.equal(result.state, 'healthy', JSON.stringify(result, null, 2));
  assert.equal(result.plan.approvedCommit, fixture.commit);
  assert(result.warnings.some((warning) => warning.includes('malformed approval record')));
  assert(result.warnings.some((warning) => warning.includes('Ignored unreproducible approval')));
});

test('doctor blocks a native dependency cycle without invoking repair', () => {
  const fixture = createRepository();
  const runner = overriddenRunner(fixture, (key) => {
    if (!key.includes('dep cycles')) return undefined;
    return { status: 0, stdout: JSON.stringify([['test-step', 'test-step-2', 'test-step']]), stderr: '' };
  });
  const result = inspectDoctor('023', { cwd: fixture.root, beadsRunner: runner });
  assert.equal(result.state, 'blocked', JSON.stringify(result, null, 2));
  assert.equal(result.beads.dependenciesValid, false);
  assert(result.errors.some((error) => error.includes('dependency graph contains 1 cycle')));
});

test('doctor escalates a stale claim only when worktree evidence corroborates it', () => {
  const fixture = createRepository();
  const staleRunner = (base) => overriddenRunner(base, (key) => {
    if (!key.includes('stale')) return undefined;
    return { status: 0, stdout: JSON.stringify([{ id: 'test-step', status: 'in_progress' }]), stderr: '' };
  });

  const corroborated = inspectDoctor('023', { cwd: fixture.root, beadsRunner: staleRunner(fixture) });
  assert.equal(corroborated.state, 'blocked', JSON.stringify(corroborated, null, 2));
  assert(corroborated.errors.some((error) => error.includes('corroborated by worktree inactivity')));

  const worktree = join(fixture.root, 'stale-worktree');
  execFileSync('git', ['worktree', 'add', '-b', '023-f-export', worktree], { cwd: fixture.root, stdio: 'ignore' });
  const active = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: staleRunner({ ...fixture, worktreePath: worktree }),
  });
  assert.equal(active.state, 'healthy', JSON.stringify(active, null, 2));
  assert(active.warnings.some((warning) => warning.includes('does not corroborate abandonment')));
});

test('doctor reports orphaned issue-referencing commits with recovery guidance and never auto-closes', () => {
  const fixture = createRepository();
  const runner = overriddenRunner(fixture, (key) => {
    if (!key.includes('orphans')) return undefined;
    return { status: 0, stdout: JSON.stringify([{ id: 'test-step', commit: 'e'.repeat(40) }]), stderr: '' };
  });
  const result = inspectDoctor('023', { cwd: fixture.root, beadsRunner: runner });
  assert.equal(result.state, 'blocked', JSON.stringify(result, null, 2));
  assert(result.errors.some((error) => error.includes('orphaned issue-referencing commit') && error.includes('recover explicitly')));
  assert.equal(result.beads.orphans.length, 1);
});

test('doctor blocks an unresolved human escalation distinctly from gates', () => {
  const fixture = createRepository();
  const runner = overriddenRunner(fixture, (key) => {
    if (!key.includes('human list')) return undefined;
    return { status: 0, stdout: JSON.stringify([{ id: 'test-step', status: 'open' }]), stderr: '' };
  });
  const result = inspectDoctor('023', { cwd: fixture.root, beadsRunner: runner });
  assert.equal(result.state, 'blocked', JSON.stringify(result, null, 2));
  assert(result.errors.some((error) => error.includes('unresolved human escalation')));
  assert.equal(result.beads.openGates.length, 0);
});

test('doctor reports worktree plan-snapshot skew as a warning while staying healthy', () => {
  const fixture = createRepository();
  const worktree = join(fixture.root, 'skew-worktree');
  execFileSync('git', ['worktree', 'add', '-b', '023-f-export', worktree], { cwd: fixture.root, stdio: 'ignore' });
  writeFileSync(join(worktree, 'thoughts', 'plans', '023-f-export.md'), `${fixture.plan}\nEdited only in the worktree snapshot.\n`);
  const result = inspectDoctor('023', {
    cwd: fixture.root,
    beadsRunner: fakeBeadsRunner({ ...fixture, worktreePath: worktree }),
  });
  assert.equal(result.state, 'healthy', JSON.stringify(result, null, 2));
  assert.equal(result.worktree.snapshotMatchesApprovedPlan, false);
  assert.equal(result.worktree.snapshotSeverity, 'warning');
  assert(result.warnings.some((warning) => warning.includes('Worktree plan snapshot differs')));
});

test('doctor blocks an installed but unsupported Beads version with exit code 3', () => {
  const fixture = createRepository();
  const runner = overriddenRunner(fixture, (key) => {
    if (!key.includes('--version')) return undefined;
    return { status: 0, stdout: 'bd version 1.0.0', stderr: '' };
  });
  const result = inspectDoctor('023', { cwd: fixture.root, beadsRunner: runner });
  assert.equal(result.state, 'blocked', JSON.stringify(result, null, 2));
  assert.equal(result.dependencyUnavailable, false);
  assert(result.errors.some((error) => error.includes('older than required 1.1.0')));
  assert.equal(doctorExitCode(result), 3);
});

test('doctor is never healthy in a --skip-beads scaffold', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-skipbeads-doctor-'));
  const cli = join(packageRoot, 'bin', 'sdlc.mjs');
  const setup = spawnSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(setup.status, 0, setup.stderr);
  const result = spawnSync(process.execPath, [cli, 'doctor', '001', '--json'], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.state, 'blocked');
  assert.notEqual(parsed.state, 'healthy');
});
