import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { gitWorkingTreeState, resolveWorkingTree } from '../lib/working-tree.mjs';

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-working-tree-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  return root;
}

const plan = { path: 'thoughts/plans/023-f-export.md' };
const planName = '023-f-export';

test('worktree mode is detected via the conventional .worktrees/<planName> path', () => {
  const root = createRepository();
  const worktreePath = join(root, '.worktrees', planName);
  execFileSync('git', ['worktree', 'add', '-b', planName, worktreePath], { cwd: root, stdio: 'ignore' });
  const worktrees = [{ path: worktreePath, branch: planName, beads_state: 'local' }];
  const result = resolveWorkingTree(plan, { primary: root, worktrees });
  assert.equal(result.mode, 'worktree');
  assert.equal(result.path, resolve(worktreePath));
  assert.equal(result.planName, planName);
  assert.equal(result.onPlanBranch, true);
  assert.deepEqual(result.registered, worktrees[0]);
  assert.equal(result.beadsState, 'local');
  assert.equal(result.git.branch, planName);
});

test('branch mode is the default when no worktree is registered', () => {
  const root = createRepository();
  const result = resolveWorkingTree(plan, { primary: root, worktrees: [] });
  assert.equal(result.mode, 'branch');
  assert.equal(result.path, root);
  assert.equal(result.registered, null);
  assert.equal(result.beadsState, null);
  assert.equal(result.onPlanBranch, false);
  assert.equal(result.git.branch, 'main');
});

test('a missing .worktrees directory resolves to branch mode', () => {
  const root = createRepository();
  assert.equal(existsSync(join(root, '.worktrees')), false);
  const result = resolveWorkingTree(plan, { primary: root, worktrees: [] });
  assert.equal(result.mode, 'branch');
  assert.equal(result.path, root);
});

test('a worktree present on disk but absent from the bd list resolves to branch mode', () => {
  const root = createRepository();
  const worktreePath = join(root, '.worktrees', planName);
  execFileSync('git', ['worktree', 'add', '-b', planName, worktreePath], { cwd: root, stdio: 'ignore' });
  const result = resolveWorkingTree(plan, { primary: root, worktrees: [] });
  assert.equal(result.mode, 'branch');
  assert.equal(result.path, root);
  assert.equal(result.registered, null);
});

test('a worktree registered in the bd list but absent from disk resolves to branch mode', () => {
  const root = createRepository();
  const worktreePath = join(root, '.worktrees', planName);
  const worktrees = [{ path: worktreePath, branch: planName, beads_state: 'local' }];
  const result = resolveWorkingTree(plan, { primary: root, worktrees });
  assert.equal(result.mode, 'branch');
  assert.equal(result.path, root);
  assert.deepEqual(result.registered, worktrees[0]);
  assert.equal(result.beadsState, 'local');
});

test('a worktree at a non-conventional path is still detected via the branch-name compatibility fallback', () => {
  const root = createRepository();
  const worktreePath = join(root, 'review-worktree');
  execFileSync('git', ['worktree', 'add', '-b', planName, worktreePath], { cwd: root, stdio: 'ignore' });
  const worktrees = [{ path: worktreePath, branch: planName, beads_state: 'shared' }];
  const result = resolveWorkingTree(plan, { primary: root, worktrees });
  assert.equal(result.mode, 'worktree');
  assert.equal(result.path, resolve(worktreePath));
  assert.equal(result.beadsState, 'shared');
  assert.deepEqual(result.registered, worktrees[0]);
});

test('a plain string plan path is accepted in place of a parsed plan object', () => {
  const root = createRepository();
  const result = resolveWorkingTree('thoughts/plans/023-f-export.md', { primary: root, worktrees: [] });
  assert.equal(result.planName, planName);
  assert.equal(result.mode, 'branch');
});

test('primary is derived from cwd when omitted', () => {
  const root = createRepository();
  const canonical = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  const result = resolveWorkingTree(plan, { worktrees: [], cwd: root });
  assert.equal(result.path, resolve(canonical));
});

test('git state carries real branch, head, dirty and unpushed values from disk', () => {
  const root = createRepository();
  const worktreePath = join(root, '.worktrees', planName);
  execFileSync('git', ['worktree', 'add', '-b', planName, worktreePath], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
  execFileSync('git', ['add', 'feature.txt'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-m', 'feature commit'], { cwd: worktreePath, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
  writeFileSync(join(worktreePath, 'scratch.txt'), 'uncommitted\n');

  const worktrees = [{ path: worktreePath, branch: planName, beads_state: 'local' }];
  const result = resolveWorkingTree(plan, { primary: root, worktrees });
  assert.equal(result.git.branch, planName);
  assert.equal(result.git.head, head);
  assert.equal(result.git.dirty, true);
  assert.equal(result.git.unpushed, 1);
  assert.equal(result.git.publicationBaseline, 'main');
  assert.equal(result.git.stashes, 0);
  assert.equal(typeof result.git.lastCommitAt, 'number');
  assert(result.git.lastCommitAt > 0);
});

test('gitWorkingTreeState returns null for a path that does not exist', () => {
  assert.equal(gitWorkingTreeState(join(tmpdir(), 'sdlc-working-tree-nonexistent'), 'main'), null);
});

test('gitWorkingTreeState mirrors the shape doctor previously computed inline, minus path', () => {
  const root = createRepository();
  const state = gitWorkingTreeState(root, 'unused-fallback');
  assert.deepEqual(
    Object.keys(state).sort(),
    ['branch', 'dirty', 'head', 'lastCommitAt', 'publicationBaseline', 'stashes', 'unpushed', 'upstream'].sort(),
  );
  assert.equal(state.branch, 'main');
  assert.equal(state.dirty, false);
  assert.equal(state.unpushed, 0);
});
