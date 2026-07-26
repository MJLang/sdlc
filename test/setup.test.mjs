import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  // The discovery-result contract is part of the review lane, so it ships in review.md.
  const installed = readFileSync(join(root, '.agents', 'skills', 'sdlc-implement', 'review.md'), 'utf8');
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

test('setup installs .agents/sdlc.json from the shipped template when absent', () => {
  const root = gitRepository();
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], { cwd: root, stdio: 'ignore' });
  assert.equal(
    readFileSync(join(root, '.agents', 'sdlc.json'), 'utf8'),
    readFileSync(join(packageRoot, 'template', 'sdlc.template.json'), 'utf8'),
  );
});

test('a hand-edited .agents/sdlc.json is byte-identical after setup --force (--force cannot reach it)', () => {
  const root = gitRepository();
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], { cwd: root, stdio: 'ignore' });
  const configPath = join(root, '.agents', 'sdlc.json');
  const handEdited = JSON.stringify({ version: 1, targets: [{ name: 'custom' }] });
  writeFileSync(configPath, handEdited);
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents', '--force'], { cwd: root, stdio: 'ignore' });
  assert.equal(readFileSync(configPath, 'utf8'), handEdited);
});

test('both generated JSON Schema files are installed and refreshed on rerun, even without --force', () => {
  const root = gitRepository();
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], { cwd: root, stdio: 'ignore' });
  const schemaPath = join(root, '.agents', 'sdlc.schema.json');
  const localSchemaPath = join(root, '.agents', 'sdlc.local.schema.json');
  const schema = readFileSync(join(packageRoot, 'template', 'sdlc.schema.json'), 'utf8');
  const localSchema = readFileSync(join(packageRoot, 'template', 'sdlc.local.schema.json'), 'utf8');
  assert.equal(readFileSync(schemaPath, 'utf8'), schema);
  assert.equal(readFileSync(localSchemaPath, 'utf8'), localSchema);

  // A stale committed copy (e.g. from before a schema change) must refresh on
  // the next plain rerun; these are generated files, never user-owned.
  writeFileSync(schemaPath, '{}');
  writeFileSync(localSchemaPath, '{}');
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], { cwd: root, stdio: 'ignore' });
  assert.equal(readFileSync(schemaPath, 'utf8'), schema);
  assert.equal(readFileSync(localSchemaPath, 'utf8'), localSchema);
});

test('setup ignores .agents/sdlc.local.json exactly once across two runs', () => {
  const root = gitRepository();
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], { cwd: root, stdio: 'ignore' });
  const countIgnoreLines = () => readFileSync(join(root, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() === '.agents/sdlc.local.json').length;
  assert.equal(countIgnoreLines(), 1);
  execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], { cwd: root, stdio: 'ignore' });
  assert.equal(countIgnoreLines(), 1);
});

test('setup does not duplicate the ignore entry when the user already ignores it, bare or slash-prefixed', () => {
  for (const existingForm of ['.agents/sdlc.local.json', '/.agents/sdlc.local.json']) {
    const root = gitRepository();
    writeFileSync(join(root, '.gitignore'), `node_modules/\n${existingForm}\n`);
    execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-skills', '--skip-agents'], { cwd: root, stdio: 'ignore' });
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
    const occurrences = lines.filter((line) => line === '.agents/sdlc.local.json' || line === '/.agents/sdlc.local.json').length;
    assert.equal(occurrences, 1, `expected exactly one ignore line for existing form ${JSON.stringify(existingForm)}`);
  }
});

test('setup refuses while thoughts/AGENTS.md still carries a legacy Project Configuration section, writing nothing', () => {
  const root = gitRepository();
  mkdirSync(join(root, 'thoughts'), { recursive: true });
  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), '## Project Configuration\n\n- **Targets:** `app`\n');
  const before = readdirSync(root).sort();

  const result = spawnSync(process.execPath, [cli, 'setup', '--skip-beads'], { cwd: root, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Project Configuration/);
  assert.match(result.stderr, /\.agents\/sdlc\.json/);
  assert.match(result.stderr, /template\/sdlc\.template\.json/);
  assert.match(result.stderr, /Targets/);
  assert.deepEqual(readdirSync(root).sort(), before, 'setup must write nothing before refusing');
  assert.equal(existsSync(join(root, '.agents')), false);
  assert.equal(existsSync(join(root, 'AGENTS.md')), false);
});

test('two consecutive plain sdlc setup runs both succeed (PC-001 regression: the renamed contract section must not trip its own legacy detector)', () => {
  const root = gitRepository();
  const first = spawnSync(process.execPath, [cli, 'setup', '--skip-beads'], { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(process.execPath, [cli, 'setup', '--skip-beads'], { cwd: root, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
});

test('setup ships the sdlc-implement review contract to every host target', () => {
  for (const target of ['--claude', '--codex', '--pi']) {
    const root = gitRepository();
    execFileSync(process.execPath, [cli, 'setup', '--skip-beads', '--skip-agents', target], { cwd: root, stdio: 'ignore' });
    const canonical = join(root, '.agents', 'skills', 'sdlc-implement', 'review.md');
    assert.equal(existsSync(canonical), true, `${target} must install .agents/skills/sdlc-implement/review.md`);
    assert.match(readFileSync(canonical, 'utf8'), /sdlc review-artifact --validate/);
    // The SKILL.md reference has to resolve from the directory each host reads.
    const hostSkillDir = target === '--claude'
      ? join(root, '.claude', 'skills', 'sdlc-implement')
      : join(root, '.agents', 'skills', 'sdlc-implement');
    assert.match(readFileSync(join(hostSkillDir, 'SKILL.md'), 'utf8'), /review\.md/);
    assert.equal(existsSync(join(hostSkillDir, 'review.md')), true, `${target} must resolve review.md next to SKILL.md`);
  }
});
