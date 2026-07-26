import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDoctorInspectionContext, parseApprovalRecords, parseRebaseRecords, parseReviewApprovalRecords, parseWaiverRecords } from '../lib/doctor.mjs';
import { formatResume, inspectResume, resumeExitCode, runResume } from '../lib/resume.mjs';

function planSource({ status = 'approved', epic = 'test-epic' } = {}) {
  return `---
Status: ${status}
Tags: [app, export]
Type: feature
Target: app
Ticket Origin: thoughts/tickets/023-export.md
${epic ? `Beads Epic: ${epic}\n` : ''}---

# Export plan
`;
}

function createRepository({ status = 'approved', epic = 'test-epic', mergeSlotOn = false, planNumber = '023-f-export' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-resume-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  mkdirSync(join(root, 'thoughts', 'plans'), { recursive: true });
  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), `# Workflow\n\n## Project Configuration\n\n- **Beads mode:** \`embedded\`\n- **Beads merge slot:** \`${mergeSlotOn ? 'on' : 'off'}\`\n`);
  writeFileSync(join(root, 'thoughts', 'plans', `${planNumber}.md`), planSource({ status, epic }));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'plan: approve export'], { cwd: root, stdio: 'ignore' });
  return { root };
}

function addWorktree(root, planName = '023-f-export') {
  const worktreePath = join(root, '.worktrees', planName);
  execFileSync('git', ['worktree', 'add', '-b', planName, worktreePath], { cwd: root, stdio: 'ignore' });
  return worktreePath;
}

function fakeBeadsRunner({
  worktreePath,
  planName = '023-f-export',
  epicId = 'test-epic',
  epicStatus = 'in_progress',
  epicAssignee = 'sdlc:codex:prior',
  children = [{ id: 'test-step', status: 'in_progress', assignee: 'sdlc:codex:prior' }],
  mergeSlot = null,
  claimFails = false,
  calls = [],
} = {}) {
  return (_executable, args) => {
    calls.push(args.join(' '));
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
    if (key.includes('context')) return json({ mode: 'embedded' });
    if (key.includes('ready')) return json([]);
    if (key.includes('dep cycles')) return json([]);
    if (key.includes('worktree list')) return json(worktreePath ? [{ path: worktreePath, branch: planName, beads_state: 'local' }] : []);
    if (key.includes('gate list')) return json([]);
    if (key.includes('human list')) return json([]);
    if (key.includes('stale')) return json([]);
    if (key.includes('orphans')) return json([]);
    if (key.includes('merge-slot check')) return json(mergeSlot ?? { available: true });
    if (args[0] === 'update' && args.includes('--claim')) {
      if (claimFails) return { status: 1, stdout: '', stderr: `Error claiming ${args[1]}: issue already claimed by ${epicAssignee}` };
      return json({ id: args[1], status: 'in_progress', assignee: 'sdlc:agent:new' });
    }
    if (args[0] === 'update' && args.includes('--assignee')) {
      const id = args[1];
      const assigneeIndex = args.indexOf('--assignee');
      const assignee = args[assigneeIndex + 1];
      const statusIndex = args.indexOf('--status');
      const status = statusIndex >= 0 ? args[statusIndex + 1] : undefined;
      return json({ id, ...(status ? { status } : {}), ...(assignee ? { assignee } : {}) });
    }
    if (args[0] === 'note') return json({ id: args[1], notes: args[2] });
    if (key.includes(`show ${epicId}`)) return json({ id: epicId, status: epicStatus, assignee: epicAssignee });
    if (key.includes(`list --parent ${epicId}`)) return json(children);
    return { status: 1, stdout: '', stderr: `unhandled fake bd call: ${key}` };
  };
}

function context(root, options = {}) {
  return createDoctorInspectionContext({ cwd: root, beadsRunner: fakeBeadsRunner(options) });
}

test('resume reports plan-unresolved when no applicable plan exists', () => {
  const { root } = createRepository();
  const result = inspectResume('999', { cwd: root, inspectionContext: context(root) });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'plan-unresolved');
  assert.match(result.errors[0].detail, /No applicable plan/);
});

test('resume reports plan-unresolved when the applicable plan has no Beads Epic', () => {
  const { root } = createRepository({ epic: null });
  const result = inspectResume('023', { cwd: root, inspectionContext: context(root) });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'plan-unresolved');
  assert.match(result.errors[0].detail, /no Beads Epic/);
});

test('resume reports plan-unresolved when more than one applicable plan exists', () => {
  const { root } = createRepository();
  writeFileSync(join(root, 'thoughts', 'plans', '023-g-export-alt.md'), planSource({ epic: 'test-epic-2' }));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'second plan'], { cwd: root, stdio: 'ignore' });
  const result = inspectResume('023', { cwd: root, inspectionContext: context(root) });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'plan-unresolved');
  assert.match(result.errors[0].detail, /Multiple applicable plans/);
});

test('resume refuses a dirty worktree and names the dirty paths', () => {
  const { root } = createRepository();
  const worktreePath = addWorktree(root);
  writeFileSync(join(worktreePath, 'scratch.txt'), 'uncommitted\n');
  const result = inspectResume('023', { cwd: root, inspectionContext: context(root, { worktreePath }) });
  assert.equal(result.ok, false);
  const error = result.errors.find((entry) => entry.code === 'worktree-dirty');
  assert(error, JSON.stringify(result));
  assert.match(error.detail, /scratch\.txt/);
  assert.match(error.detail, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('resume refuses unpushed commits and names them', () => {
  const { root } = createRepository();
  const worktreePath = addWorktree(root);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-m', 'add feature work'], { cwd: worktreePath, stdio: 'ignore' });
  const expected = execFileSync('git', ['log', '--oneline', 'main..HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
  const result = inspectResume('023', { cwd: root, inspectionContext: context(root, { worktreePath }) });
  assert.equal(result.ok, false);
  const error = result.errors.find((entry) => entry.code === 'unpushed-commits');
  assert(error, JSON.stringify(result));
  assert.match(error.detail, /1 unpushed commit/);
  assert(error.detail.includes(expected), `expected detail to include ${expected}, got ${error.detail}`);
});

test('resume reports every failing precondition at once, not just the first', () => {
  const { root } = createRepository({ mergeSlotOn: true });
  const worktreePath = addWorktree(root);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-m', 'add feature work'], { cwd: worktreePath, stdio: 'ignore' });
  writeFileSync(join(worktreePath, 'scratch.txt'), 'uncommitted\n');
  const mergeSlot = { holder: 'sdlc:codex:landing', updated_at: new Date(Date.now() - 60000).toISOString() };
  const result = inspectResume('023', { cwd: root, actor: 'sdlc:agent:me', inspectionContext: context(root, { worktreePath, mergeSlot }) });
  assert.equal(result.ok, false);
  const codes = result.errors.map((error) => error.code).sort();
  assert.deepEqual(codes, ['merge-slot-held', 'unpushed-commits', 'worktree-dirty']);
});

test('resume refuses when the merge slot is held by a different actor, naming holder and age', () => {
  const { root } = createRepository({ mergeSlotOn: true });
  const worktreePath = addWorktree(root);
  const mergeSlot = { holder: 'sdlc:codex:landing', updated_at: new Date(Date.now() - 60000).toISOString() };
  const result = inspectResume('023', { cwd: root, actor: 'sdlc:agent:me', inspectionContext: context(root, { worktreePath, mergeSlot }) });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'merge-slot-held');
  assert.match(result.errors[0].detail, /sdlc:codex:landing/);
  assert.match(result.errors[0].detail, /age 60s/);
});

test('a clean, fully pushed worktree passes every resume precondition', () => {
  const { root } = createRepository();
  const worktreePath = addWorktree(root);
  const result = inspectResume('023', { cwd: root, inspectionContext: context(root, { worktreePath }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.errors.length, 0);
  assert.equal(result.epic.id, 'test-epic');
  assert.equal(result.epic.assignee, 'sdlc:codex:prior');
  assert.deepEqual(result.children, [{ id: 'test-step', assignee: 'sdlc:codex:prior' }]);
  assert.equal(result.workingTree.mode, 'worktree');
  assert.equal(result.workingTree.path, worktreePath);
});

test('inspectResume result shapes round-trip through JSON with a stable key set', () => {
  const { root } = createRepository();
  const worktreePath = addWorktree(root);
  writeFileSync(join(worktreePath, 'scratch.txt'), 'uncommitted\n');
  const refused = inspectResume('023', { cwd: root, inspectionContext: context(root, { worktreePath }) });
  assert.deepEqual(Object.keys(refused).sort(), ['errors', 'number', 'ok']);
  assert.deepEqual(Object.keys(refused.errors[0]).sort(), ['code', 'detail']);
  assert.deepEqual(JSON.parse(JSON.stringify(refused)), refused);

  const { root: cleanRoot } = createRepository();
  const cleanWorktree = addWorktree(cleanRoot);
  const accepted = inspectResume('023', { cwd: cleanRoot, inspectionContext: context(cleanRoot, { worktreePath: cleanWorktree }) });
  assert.deepEqual(
    Object.keys(accepted).sort(),
    ['children', 'epic', 'errors', 'number', 'ok', 'plan', 'primary', 'workingTree'].sort(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(accepted)), accepted);
});

test('runResume adopts a foreign epic via the update fallback, resets orphaned children, and appends exactly one note', () => {
  const { root } = createRepository();
  const worktreePath = addWorktree(root);
  const calls = [];
  const runner = fakeBeadsRunner({ worktreePath, claimFails: true, calls });
  const now = Date.parse('2026-07-25T23:30:00.000Z');
  const result = runResume('023', { cwd: root, runtime: 'test', beadsRunner: runner, now });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.epic, 'test-epic');
  assert.equal(result.priorActor, 'sdlc:codex:prior');
  assert.deepEqual(result.resetChildIds, ['test-step']);
  assert.match(result.newActor, /^sdlc:test:/);

  assert(calls.some((call) => call.startsWith('update test-epic --claim')));
  assert(calls.some((call) => call.startsWith('update test-epic --assignee') && call.includes('--status in_progress')));
  assert(calls.some((call) => call.startsWith('update test-step --status open --assignee')));
  const noteCalls = calls.filter((call) => call.startsWith('note test-epic'));
  assert.equal(noteCalls.length, 1);
  assert.match(noteCalls[0], /^note test-epic resume: adopted from sdlc:codex:prior at 2026-07-25T23:30:00\.000Z; tree clean, 0 unpushed --json$/);
});

test('runResume claims directly when the epic is not held by a foreign actor', () => {
  const { root } = createRepository();
  const worktreePath = addWorktree(root);
  const calls = [];
  const runner = fakeBeadsRunner({ worktreePath, epicStatus: 'open', epicAssignee: null, children: [], claimFails: false, calls });
  const result = runResume('023', { cwd: root, runtime: 'test', beadsRunner: runner });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.priorActor, '<none>');
  assert.deepEqual(result.resetChildIds, []);
  assert(calls.some((call) => call.startsWith('update test-epic --claim')));
  assert.equal(calls.some((call) => call.includes('--assignee') && call.startsWith('update test-epic')), false);
});

test('runResume propagates a refusal unchanged and never mutates', () => {
  const { root } = createRepository();
  const worktreePath = addWorktree(root);
  writeFileSync(join(worktreePath, 'scratch.txt'), 'uncommitted\n');
  const calls = [];
  const runner = fakeBeadsRunner({ worktreePath, calls });
  const result = runResume('023', { cwd: root, runtime: 'test', beadsRunner: runner });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'worktree-dirty');
  assert.equal(calls.some((call) => call.startsWith('update') || call.startsWith('note')), false);
});

test('formatResume and resumeExitCode render refusals and acceptances distinctly', () => {
  const refusal = { number: '023', ok: false, errors: [{ code: 'worktree-dirty', detail: 'Working tree at /x has uncommitted changes:\n M lib/a.mjs' }] };
  assert.equal(resumeExitCode(refusal), 3);
  const refusedText = formatResume(refusal);
  assert.match(refusedText, /^REFUSED resume 023/);
  assert.match(refusedText, /worktree-dirty/);

  const accepted = { number: '023', ok: true, epic: 'test-epic', newActor: 'sdlc:agent:new', priorActor: 'sdlc:codex:prior', resetChildIds: ['test-step'], workingTree: { path: '/x', mode: 'worktree' } };
  assert.equal(resumeExitCode(accepted), 0);
  const acceptedText = formatResume(accepted);
  assert.match(acceptedText, /epic test-epic adopted by sdlc:agent:new \(was sdlc:codex:prior\)/);
  assert.match(acceptedText, /reset 1 orphaned child claim: test-step/);
});

test('the resume note grammar collides with none of the other epic-note parsers', () => {
  const note = 'resume: adopted from sdlc:codex:prior at 2026-07-25T23:30:00.000Z; tree clean, 0 unpushed';
  assert.deepEqual(parseApprovalRecords(note), { records: [], malformed: [] });
  assert.deepEqual(parseReviewApprovalRecords(note), { records: [], malformed: [] });
  assert.deepEqual(parseRebaseRecords(note), { records: [], malformed: [] });
  assert.deepEqual(parseWaiverRecords(note), { records: [], malformed: [] });
});
