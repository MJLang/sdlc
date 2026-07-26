import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuredGateCommands, parseProjectConfig } from '../lib/config.mjs';
import { formatGateRun, runGates } from '../lib/gates.mjs';

function configSource(overrides = {}) {
  return JSON.stringify({
    version: 1,
    targets: [
      {
        name: 'app',
        paths: ['lib/**', 'test/**'],
        gates: [
          'node -e "console.log(\'app target\')"',
          'node -e "console.log(\'left;right\')"',
        ],
      },
      { name: 'web' },
    ],
    gates: [
      'node --test passing.test.mjs',
      'node -e "console.log(\'quoted value\')"',
    ],
    ...overrides,
  });
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-gates-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), configSource());
  writeFileSync(join(root, 'passing.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('pass', () => assert.equal(1, 1));\n");
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return root;
}

test('.agents/sdlc.json parses ordered gates, target mappings, and opaque shell quoting', () => {
  const config = parseProjectConfig(configSource());
  assert.deepEqual(config.targets, ['app', 'web']);
  assert.deepEqual(config.qualityGates, [
    'node --test passing.test.mjs',
    'node -e "console.log(\'quoted value\')"',
  ]);
  assert.deepEqual(config.targetGates.app, [
    'node -e "console.log(\'app target\')"',
    'node -e "console.log(\'left;right\')"',
  ]);
  assert.deepEqual(config.targetPaths.app, ['lib/**', 'test/**']);
  assert.deepEqual(configuredGateCommands(config, 'app').map((gate) => gate.source), ['global', 'global', 'target:app', 'target:app']);
  assert.throws(() => configuredGateCommands(config, 'api'), /Unknown target/);
});

test('a target referenced from outside the file (e.g. --target) is still refused, and a duplicate target name inside it is refused', () => {
  const config = parseProjectConfig(configSource());
  assert.throws(() => configuredGateCommands(config, 'api'), /Unknown target/);

  const duplicate = parseProjectConfig(JSON.stringify({
    version: 1,
    targets: [{ name: 'app' }, { name: 'app' }],
    gates: ['node -e "process.exit(0)"'],
  }));
  assert(duplicate.errors.some((error) => error.includes('targets[1].name') && error.includes('duplicates targets[0].name')));
});

test('quality gates keep the worktree clean and emit terse passing summaries', async () => {
  const root = repository();
  const result = await runGates({ cwd: root, target: 'app' });
  assert.equal(result.ok, true, formatGateRun(result));
  assert.equal(result.results.length, 4);
  assert.equal(result.results[0].counts.pass, 1, result.results[0].output);
  assert.match(formatGateRun(result), /^PASS command=/m);
  assert.equal(execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }), '');
  assert.equal(statSync(result.directory).mode & 0o777, 0o700);
  assert.equal(statSync(result.results[0].logPath).mode & 0o777, 0o600);
});

test('a failing gate returns a bounded excerpt, full log path, and non-zero status', async () => {
  const root = repository();
  const config = parseProjectConfig(JSON.stringify({
    version: 1,
    targets: [{ name: 'app' }],
    gates: ['node -e "console.error(\'AssertionError: expected 1\'); process.exit(7)"'],
  }));
  const result = await runGates({ cwd: root, config, logLimit: 1024 });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, 7);
  assert.match(result.results[0].excerpt, /AssertionError/);
  assert(formatGateRun(result).includes(`log=${result.results[0].logPath}`));
  assert(readFileSync(result.results[0].logPath, 'utf8').includes('AssertionError'));
});

test('gate logs retain only the latest ten runs', async () => {
  const root = repository();
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const logRoot = join(common, 'sdlc', 'logs');
  mkdirSync(logRoot, { recursive: true });
  for (let index = 0; index < 12; index += 1) mkdirSync(join(logRoot, `old-${String(index).padStart(2, '0')}`));
  const config = parseProjectConfig(JSON.stringify({ version: 1, targets: [{ name: 'app' }], gates: ['node -e "process.exit(0)"'] }));
  await runGates({ cwd: root, config });
  assert.equal(readdirSync(logRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, 10);
});

test('unwritable Git-common storage falls back, and two unavailable stores refuse before execution', async () => {
  const root = repository();
  const fakeCommon = join(root, 'common-file');
  writeFileSync(fakeCommon, 'not a directory');
  const fallbackParent = mkdtempSync(join(tmpdir(), 'sdlc-gates-fallback-'));
  const config = parseProjectConfig(JSON.stringify({ version: 1, targets: [{ name: 'app' }], gates: ['node -e "process.exit(0)"'] }));
  const fallback = await runGates({ cwd: root, config, commonDirectory: fakeCommon, temporaryDirectory: fallbackParent });
  assert.equal(fallback.storage, 'temporary');

  const fakeTemporary = join(root, 'temporary-file');
  writeFileSync(fakeTemporary, 'not a directory');
  const marker = join(root, 'gate-ran');
  const refusingConfig = parseProjectConfig(JSON.stringify({
    version: 1,
    targets: [{ name: 'app' }],
    gates: [`node -e "require('node:fs').writeFileSync('${marker}', 'ran')"`],
  }));
  await assert.rejects(
    runGates({ cwd: root, config: refusingConfig, commonDirectory: fakeCommon, temporaryDirectory: fakeTemporary }),
    /Quality gates were not run/,
  );
  assert.equal(existsSync(marker), false);
});
