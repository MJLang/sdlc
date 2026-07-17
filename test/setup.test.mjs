import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(packageRoot, 'bin', 'sdlc.mjs');
const installedBeads = spawnSync('bd', ['--version'], { encoding: 'utf8' }).status === 0;
const skillNames = [
  'sdlc-approve',
  'sdlc-cancel',
  'sdlc-chore',
  'sdlc-implement',
  'sdlc-land',
  'sdlc-next',
  'sdlc-plan',
  'sdlc-queue',
  'sdlc-review',
  'sdlc-ticket',
];

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

test('setup installs discovery workflow contracts in templates and skills', () => {
  const root = gitRepository();
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-agents', '--codex'], { cwd: root, stdio: 'ignore' });
  assert.match(readFileSync(join(root, 'thoughts', 'AGENTS.md'), 'utf8'), /Discovery is planned work/);
  const installed = readFileSync(join(root, '.agents', 'skills', 'sdlc-implement', 'SKILL.md'), 'utf8');
  assert.match(installed, /Discovery Result - Ticket/);
  assert.match(installed, /Outcome: validated \| invalidated/);
  assert.deepEqual(readdirSync(join(root, '.agents', 'skills')).sort(), skillNames);
});

test('setup warns without deleting a legacy unprefixed skill', () => {
  const root = gitRepository();
  const legacySkill = join(root, '.agents', 'skills', 'plan');
  mkdirSync(legacySkill, { recursive: true });

  const output = execFileSync(
    process.execPath,
    [cli, 'setup', '--skip-beads', '--skip-agents', '--codex'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.match(output, /legacy unprefixed skill directories detected: plan/);
  assert.equal(existsSync(legacySkill), true);
  assert.equal(existsSync(join(root, '.agents', 'skills', 'sdlc-plan', 'SKILL.md')), true);
});

test('setup --pi installs Pi reviewer profiles without selecting Claude by default', () => {
  const root = gitRepository();
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--pi'], { cwd: root, stdio: 'ignore' });

  assert.equal(existsSync(join(root, '.claude')), false);
  assert.equal(existsSync(join(root, '.codex')), false);
  assert.equal(existsSync(join(root, '.agents', 'skills', 'sdlc-implement', 'SKILL.md')), true);
  const agents = readdirSync(join(root, '.pi', 'agents')).sort();
  assert.deepEqual(agents, [
    'backend-code-reviewer.md',
    'frontend-code-reviewer.md',
    'general-code-reviewer.md',
    'plan-reviewer.md',
  ]);
  const reviewer = readFileSync(join(root, '.pi', 'agents', 'plan-reviewer.md'), 'utf8');
  assert.match(reviewer, /^tools: read, grep, find, ls, bash$/m);
  assert.match(reviewer, /^inheritProjectContext: true$/m);
  assert.match(reviewer, /This is a read-only reviewer/);
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
