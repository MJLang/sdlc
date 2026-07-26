import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fingerprintContent, formatFingerprint } from '../lib/fingerprint.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(packageRoot, 'bin', 'sdlc.mjs');

function gitRepository() {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-hash-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  return root;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });
}

test('hash --rev reproduces the working-file digest when the committed and on-disk bytes are identical', () => {
  const root = gitRepository();
  const content = '---\nStatus: approved\n---\n\n# Plan\n';
  writeFileSync(join(root, 'plan.md'), content);
  execFileSync('git', ['add', 'plan.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add plan'], { cwd: root, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const withoutRev = run(['hash', 'plan.md'], { cwd: root });
  const withRev = run(['hash', 'plan.md', '--rev', commit], { cwd: root });
  assert.equal(withoutRev.status, 0, withoutRev.stderr);
  assert.equal(withRev.status, 0, withRev.stderr);
  assert.equal(withoutRev.stdout.trim(), withRev.stdout.trim());
  assert.equal(withRev.stdout.trim(), formatFingerprint(fingerprintContent(content)));
});

test('hash --rev reads the approved commit even after the working copy has drifted', () => {
  const root = gitRepository();
  const original = '---\nStatus: approved\n---\n\n# Plan v1\n';
  writeFileSync(join(root, 'plan.md'), original);
  execFileSync('git', ['add', 'plan.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add plan'], { cwd: root, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  writeFileSync(join(root, 'plan.md'), '---\nStatus: approved\n---\n\n# Plan v2 (drifted)\n');
  const atCommit = run(['hash', 'plan.md', '--rev', commit], { cwd: root });
  const atHead = run(['hash', 'plan.md'], { cwd: root });
  assert.equal(atCommit.status, 0, atCommit.stderr);
  assert.equal(atCommit.stdout.trim(), formatFingerprint(fingerprintContent(original)));
  assert.notEqual(atCommit.stdout.trim(), atHead.stdout.trim());
});

test('hash --rev accepts an absolute path resolved relative to the repository root', () => {
  const root = gitRepository();
  writeFileSync(join(root, 'plan.md'), 'content\n');
  execFileSync('git', ['add', 'plan.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add plan'], { cwd: root, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const result = run(['hash', join(root, 'plan.md'), '--rev', commit], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), formatFingerprint(fingerprintContent('content\n')));
});

test('hash --rev fails clearly and distinctly when the path does not exist at that revision', () => {
  const root = gitRepository();
  writeFileSync(join(root, 'plan.md'), 'content\n');
  execFileSync('git', ['add', 'plan.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add plan'], { cwd: root, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  const result = run(['hash', 'missing.md', '--rev', commit], { cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no such path/);
  assert.match(result.stderr, new RegExp(commit));
});

test('hash --rev fails clearly and distinctly when the revision is unresolvable', () => {
  const root = gitRepository();
  writeFileSync(join(root, 'plan.md'), 'content\n');
  execFileSync('git', ['add', 'plan.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add plan'], { cwd: root, stdio: 'ignore' });

  const result = run(['hash', 'plan.md', '--rev', 'not-a-revision'], { cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not resolve to a commit/);
});

test('hash without --rev is byte-identical to the pre-existing behaviour', () => {
  const root = gitRepository();
  const content = 'unversioned content\n';
  writeFileSync(join(root, 'plan.md'), content);
  const result = run(['hash', 'plan.md'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), formatFingerprint(fingerprintContent(content)));
});
