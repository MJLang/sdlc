import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(packageRoot, 'bin', 'sdlc.mjs');
const installedBeads = spawnSync('bd', ['--version'], { encoding: 'utf8' }).status === 0;

function gitRepository() {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-setup-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  return root;
}

test('setup installs the docs index and exactly four reviewer profiles', () => {
  const root = gitRepository();
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--claude'], { cwd: root, stdio: 'ignore' });
  assert.equal(existsSync(join(root, 'thoughts', 'docs', 'INDEX.md')), true);
  assert(readFileSync(join(root, 'thoughts', 'AGENTS.md'), 'utf8').trim().split(/\s+/).length < 1000);
  const agents = readdirSync(join(root, '.claude', 'agents')).sort();
  assert.deepEqual(agents, [
    'backend-code-reviewer.md',
    'frontend-code-reviewer.md',
    'general-code-reviewer.md',
    'plan-reviewer.md',
  ]);
  assert.equal(agents.some((file) => file.includes('pipeline-snapshot')), false);
});

test('setup installs an idempotent project prime whose fresh-session output contains no memory bodies', { skip: !installedBeads, timeout: 60_000 }, () => {
  const root = gitRepository();
  const actor = 'sdlc:test:setup-prime';
  const env = { ...process.env, BEADS_ACTOR: actor };
  execFileSync('bd', ['init', '--non-interactive', '--skip-hooks', '--skip-agents', '--prefix', 'sdlcprime'], { cwd: root, env, stdio: 'ignore' });
  execFileSync(process.execPath, [cli, 'setup', '--skip-skills', '--skip-agents'], { cwd: root, env, stdio: 'ignore' });
  const primePath = join(root, '.beads', 'PRIME.md');
  const installed = readFileSync(primePath, 'utf8');
  assert.equal(installed, readFileSync(join(packageRoot, 'template', 'beads', 'PRIME.md'), 'utf8'));
  for (let index = 0; index < 10; index += 1) {
    execFileSync('bd', ['remember', `MEMORY_BODY_${index} unique durable fixture`, '--key', `fixture-${index}`], { cwd: root, env, stdio: 'ignore' });
  }
  const prime = execFileSync('bd', ['--readonly', 'prime'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(prime.includes('MEMORY_BODY_'), false);
  assert(prime.includes('Memory bodies are on demand'));
  execFileSync(process.execPath, [cli, 'setup', '--skip-skills', '--skip-agents'], { cwd: root, env, stdio: 'ignore' });
  assert.equal(readFileSync(primePath, 'utf8'), installed);
});
