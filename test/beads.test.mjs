import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertReadonlyBeadsCommand,
  clearCapabilityCache,
  collectNativeDiagnostics,
  compareVersions,
  createBeadsAdapter,
  createSessionActor,
  inspectBeadsInstallation,
  isBatchCompatible,
  parseBeadsJson,
  parseBeadsVersion,
  serializeBatchOperations,
} from '../lib/beads.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('version parsing and minimum comparison are semantic', () => {
  assert.deepEqual(parseBeadsVersion('bd version 1.1.0 (Homebrew)').parts, [1, 1, 0]);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.0.99', '1.1.0'), -1);
});

test('session actors are unique unless explicitly inherited', () => {
  const first = createSessionActor({ runtime: 'codex', sessionId: null, existingActor: null, fresh: true });
  const second = createSessionActor({ runtime: 'codex', sessionId: null, existingActor: null, fresh: true });
  assert.match(first, /^sdlc:codex:/);
  assert.notEqual(first, second);
  assert.equal(createSessionActor({ existingActor: first }), first);
  assert.equal(createSessionActor({ runtime: 'Claude Code', sessionId: 'session 1', fresh: true }), 'sdlc:claude-code:session-1');
});

test('read-only adapter rejects mutation and mechanically adds --readonly', () => {
  const calls = [];
  const runner = (_executable, args, options) => {
    calls.push({ args, options });
    return { status: 0, stdout: '[]', stderr: '' };
  };
  const adapter = createBeadsAdapter({ runner, actor: createSessionActor({ runtime: 'test', sessionId: 'one', fresh: true }) });
  adapter.readonlyJson(['gate', 'list']);
  assert.equal(calls[0].args[0], '--readonly');
  assert(calls[0].args.includes('--json'));
  assert.throws(() => adapter.readonly(['update', 'bd-1', '--status=closed']), /not allowed through the read-only adapter/);
  assert.throws(() => adapter.readonly(['comments', 'add', 'bd-1', 'mutation']), /not allowed through the read-only adapter/);
  assert.throws(() => assertReadonlyBeadsCommand(['orphans', '--fix']), /Mutating flag/);
  assert.throws(() => assertReadonlyBeadsCommand(['doctor', '--fix-child-parent']), /Mutating flag/);
  assert.throws(() => assertReadonlyBeadsCommand(['doctor', '--output=diagnostics.json']), /Mutating flag/);
});

test('gate observation enriches Beads 1.1 gate rows with their blocked issue', () => {
  const calls = [];
  const runner = (_executable, args) => {
    calls.push(args);
    const key = args.join(' ');
    if (key.includes('gate list')) return { status: 0, stdout: JSON.stringify([{ id: 'gate-1', status: 'open' }]), stderr: '' };
    if (key.includes('dep list gate-1')) return { status: 0, stdout: JSON.stringify([{ id: 'step-1', dependency_type: 'blocks' }]), stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const adapter = createBeadsAdapter({ runner });
  const gates = adapter.listGates();
  assert.equal(gates[0].blocks, 'step-1');
  assert.deepEqual(gates[0].blocked_issue_ids, ['step-1']);
  assert(calls.every((args) => args[0] === '--readonly'));
});

test('merge-slot observation enriches holder state with the slot timestamp', () => {
  const runner = (_executable, args) => {
    const key = args.join(' ');
    if (key.includes('merge-slot check')) return { status: 0, stdout: JSON.stringify({ id: 'test-merge-slot', available: false, holder: 'sdlc:test:lander' }), stderr: '' };
    if (key.includes('show test-merge-slot')) return { status: 0, stdout: JSON.stringify([{ id: 'test-merge-slot', updated_at: '2026-07-13T12:00:00Z', metadata: { holder: 'sdlc:test:lander' } }]), stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = createBeadsAdapter({ runner }).mergeSlotCheck();
  assert.equal(result.ok, true);
  assert.equal(result.data.updated_at, '2026-07-13T12:00:00Z');
  assert.equal(result.data.holder, 'sdlc:test:lander');
});

test('mutating adapter requires an sdlc actor and propagates it', () => {
  const calls = [];
  const runner = (_executable, args, options) => {
    calls.push({ args, options });
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const actor = 'sdlc:test:session-1';
  const adapter = createBeadsAdapter({ runner, actor });
  adapter.claim('bd-1');
  adapter.createHumanGate('bd-2', 'Need a decision');
  adapter.createWorktree('.worktrees/023-f-export', '023-f-export');
  adapter.acquireMergeSlot();
  adapter.mutate(['remember', 'durable fact', '--key', 'durable-fact']);
  adapter.mutate(['dolt', 'push']);
  assert(calls.every((call) => call.options.env.BEADS_ACTOR === actor));
  assert.deepEqual(calls[0].args.slice(0, 3), ['update', 'bd-1', '--claim']);
  assert.throws(() => createBeadsAdapter({ runner }).claim('bd-1'), /session-scoped/);
  assert.throws(() => adapter.removeWorktree('x', { force: true }), /forbids --force/);
});

test('batch compatibility is deliberately narrow', () => {
  const operations = [
    { kind: 'update', id: 'bd-1', fields: { status: 'closed', title: 'Done now' } },
    { kind: 'dep-add', from: 'bd-2', to: 'bd-1' },
  ];
  assert.equal(isBatchCompatible(operations), true);
  assert.equal(serializeBatchOperations(operations), 'update bd-1 status=closed title="Done now"\ndep add bd-2 bd-1\n');
  assert.equal(isBatchCompatible([{ kind: 'update', id: 'bd-1', fields: { metadata: '{}' } }]), false);
  assert.equal(isBatchCompatible([{ kind: 'create', type: 'task', priority: 2, title: 'New child' }]), false);
});

test('JSON parsing never scrapes prose', () => {
  assert.deepEqual(parseBeadsJson('{"issues":[]}'), { issues: [] });
  assert.throws(() => parseBeadsJson('warning\n[]'), /not valid JSON/);
});

test('native diagnostics use only read-only helpers', () => {
  const called = [];
  const adapter = {
    connectionContext: () => (called.push('context'), { mode: 'server' }),
    listReady: () => (called.push('ready'), []),
    listInProgress: () => (called.push('in-progress'), []),
    doctor: ({ server = false } = {}) => ({ ok: true, data: { server }, error: null }),
    dependencyCycles: () => (called.push('cycles'), []),
    listWorktrees: () => (called.push('worktrees'), []),
    listGates: () => (called.push('gates'), []),
    listHumanEscalations: () => (called.push('escalations'), []),
    staleClaims: () => (called.push('stale'), []),
    orphans: () => (called.push('orphans'), []),
    mergeSlotCheck: () => ({ ok: true, data: { available: true } }),
  };
  const result = collectNativeDiagnostics(adapter, { mode: 'server', mergeSlotEnabled: true });
  assert.deepEqual(called, ['context', 'ready', 'in-progress', 'cycles', 'worktrees', 'gates', 'escalations', 'stale', 'orphans']);
  assert.equal(result.serverHealth.data.server, true);
  assert.equal(result.mergeSlot.data.available, true);
});

test('embedded diagnostics use focused JSON checks instead of unsupported agent doctor prose', () => {
  const adapter = {
    connectionContext: () => ({ mode: 'embedded' }),
    listReady: () => [],
    listInProgress: () => [],
    doctor: () => { throw new Error('embedded doctor must not be called'); },
    dependencyCycles: () => [],
    listWorktrees: () => [],
    listGates: () => [],
    listHumanEscalations: () => [],
    staleClaims: () => [],
    orphans: () => [],
  };
  const result = collectNativeDiagnostics(adapter, { mode: 'embedded' });
  assert.equal(result.health.ok, true);
  assert.equal(result.health.data.supported, false);
});

const realBeads = inspectBeadsInstallation();

test('installed Beads exposes the required native profile', { skip: !realBeads.available }, () => {
  assert.equal(realBeads.coreCapabilitiesValid, true, realBeads.errors.join('\n'));
});

test('older or capability-incomplete Beads installations are rejected precisely', () => {
  const runner = (_executable, args) => {
    const readonlyArgs = args[0] === '--readonly' ? args.slice(1) : args;
    if (readonlyArgs[0] === '--version') return { status: 0, stdout: 'bd version 1.0.9', stderr: '' };
    const key = readonlyArgs.join(' ');
    const output = key === '--help' ? '--readonly update gate worktree doctor dep stale orphans' : '';
    return { status: 0, stdout: output, stderr: '' };
  };
  const result = inspectBeadsInstallation({ runner });
  assert.equal(result.supported, false);
  assert.equal(result.coreCapabilitiesValid, false);
  assert(result.errors.some((error) => error.includes('older than required')));
  assert(result.errors.some((error) => error.includes('missing required capabilities')));
});

test('capability cache hits skip the --help spawns for the default runner', (t) => {
  clearCapabilityCache();
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-capcache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, 'fake-bd.mjs');
  const logPath = join(directory, 'calls.log');
  writeFileSync(scriptPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
if (args.includes('--version')) process.stdout.write('bd version 9.9.9\\n');
process.exit(0);
`, { mode: 0o755 });
  const callCount = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;

  const first = inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.equal(callCount(), 13, 'the first call spawns one --version probe plus twelve --help probes');
  assert.equal(first.available, true);

  const second = inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.equal(callCount(), 14, 'a cache hit only re-runs the --version freshness check');
  assert.deepEqual(second, first);
  assert.notEqual(second, first);

  first.available = false;
  first.capabilities = null;
  const third = inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.equal(third.available, true, 'mutating a returned result must not poison the cache');
  assert.equal(callCount(), 15);

  clearCapabilityCache();
  inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.equal(callCount(), 28, 'clearCapabilityCache() forces a full re-probe (13 more spawns)');
});

test('an injected custom runner bypasses the capability cache in both directions', () => {
  clearCapabilityCache();
  const callsA = [];
  const runnerA = (_executable, args) => {
    callsA.push(args);
    if (args.includes('--version')) return { status: 0, stdout: 'bd version 1.1.0', stderr: '' };
    return { status: 0, stdout: 'help text from runner A', stderr: '' };
  };
  const first = inspectBeadsInstallation({ runner: runnerA, executable: 'bd' });
  const spawnsPerCall = callsA.length;
  assert.equal(spawnsPerCall, 13);

  const second = inspectBeadsInstallation({ runner: runnerA, executable: 'bd' });
  assert.equal(callsA.length, spawnsPerCall * 2, 'a custom runner must re-spawn every probe rather than reading a cache entry');
  assert.deepEqual(second, first);

  const callsB = [];
  const runnerB = (_executable, args) => {
    callsB.push(args);
    if (args.includes('--version')) return { status: 0, stdout: 'bd version 1.0.0', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const resultB = inspectBeadsInstallation({ runner: runnerB, executable: 'bd' });
  assert.equal(callsB.length, 13, 'a second injected runner is unaffected by anything the first runner touched');
  assert.equal(resultB.version, '1.0.0');
  assert.equal(first.version, '1.1.0');
  assert.notDeepEqual(resultB, first);

  const third = inspectBeadsInstallation({ runner: runnerA, executable: 'bd' });
  assert.deepEqual(third, first, 'runner B must never write a cache entry that runner A could then read');
});

function writeCountingFakeBd(scriptPath, logPath) {
  writeFileSync(scriptPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
if (args.includes('--version')) process.stdout.write('bd version 9.9.9\\n');
process.exit(0);
`, { mode: 0o755 });
}

function runProbeInSubprocess({ scriptPath, cwd }) {
  const beadsModuleUrl = pathToFileURL(join(packageRoot, 'lib', 'beads.mjs')).href;
  const stdout = execFileSync(process.execPath, ['-e', `
    import(${JSON.stringify(beadsModuleUrl)}).then(({ inspectBeadsInstallation }) => {
      const result = inspectBeadsInstallation({ executable: ${JSON.stringify(scriptPath)}, cwd: ${JSON.stringify(cwd)} });
      process.stdout.write(JSON.stringify(result));
    });
  `], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

test('the on-disk capability cache serves a cache hit to a second process', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-diskcache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
  const scriptPath = join(directory, 'fake-bd.mjs');
  const logPath = join(directory, 'calls.log');
  writeCountingFakeBd(scriptPath, logPath);
  const callCount = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;

  const first = runProbeInSubprocess({ scriptPath, cwd: directory });
  assert.equal(callCount(), 13, 'the first process spawns a full probe');
  assert.equal(first.available, true);

  const second = runProbeInSubprocess({ scriptPath, cwd: directory });
  assert.equal(callCount(), 14, 'a second process hits the on-disk cache and only re-runs the --version freshness check');
  assert.deepEqual(second, first);

  const cacheDirectory = join(directory, '.git', 'sdlc', 'capabilities');
  const entries = readdirSync(cacheDirectory);
  assert.equal(entries.length, 1, 'exactly one capability cache file was written');
  assert.match(entries[0], /^[0-9a-f]{64}\.json$/);
});

test('a corrupt on-disk capability cache file is treated as a miss', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-diskcache-corrupt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
  const scriptPath = join(directory, 'fake-bd.mjs');
  const logPath = join(directory, 'calls.log');
  writeCountingFakeBd(scriptPath, logPath);
  const callCount = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;

  // Populate the disk cache from a subprocess so this process's in-memory L1
  // stays empty for this key — the call below can only be served from disk.
  runProbeInSubprocess({ scriptPath, cwd: directory });
  assert.equal(callCount(), 13);

  const cacheDirectory = join(directory, '.git', 'sdlc', 'capabilities');
  const [fileName] = readdirSync(cacheDirectory);
  writeFileSync(join(cacheDirectory, fileName), '{ this is not valid json');

  const result = inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.equal(result.available, true);
  assert.equal(callCount(), 26, 'a corrupt cache entry is a miss, forcing a fresh 13-spawn probe rather than throwing');
});

test('an on-disk capability cache file whose stored key no longer matches is treated as a miss', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-diskcache-keymismatch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
  const scriptPath = join(directory, 'fake-bd.mjs');
  const logPath = join(directory, 'calls.log');
  writeCountingFakeBd(scriptPath, logPath);
  const callCount = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;

  runProbeInSubprocess({ scriptPath, cwd: directory });
  assert.equal(callCount(), 13);

  const cacheDirectory = join(directory, '.git', 'sdlc', 'capabilities');
  const [fileName] = readdirSync(cacheDirectory);
  const cachePath = join(cacheDirectory, fileName);
  const record = JSON.parse(readFileSync(cachePath, 'utf8'));
  writeFileSync(cachePath, JSON.stringify({ ...record, key: 'stale-key-from-a-different-binary' }));

  const result = inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.equal(result.available, true);
  assert.equal(callCount(), 26, 'a stale key inside the cache file is a miss, forcing a fresh 13-spawn probe rather than trusting a hash collision');
});

test('outside a Git worktree the capability cache falls back to memory-only with no disk cache', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-diskcache-noworktree-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Deliberately not a Git repository.
  const scriptPath = join(directory, 'fake-bd.mjs');
  const logPath = join(directory, 'calls.log');
  writeCountingFakeBd(scriptPath, logPath);
  const callCount = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;

  const first = runProbeInSubprocess({ scriptPath, cwd: directory });
  assert.equal(callCount(), 13);
  assert.equal(first.available, true);

  const second = runProbeInSubprocess({ scriptPath, cwd: directory });
  assert.equal(callCount(), 26, 'a second process gets no cross-process cache outside a Git worktree, so it fully re-probes');
  assert.deepEqual(second, first);

  assert.deepEqual(readdirSync(directory).sort(), ['calls.log', 'fake-bd.mjs'], 'no cache directory was created anywhere under cwd');
});

test('clearCapabilityCache removes the on-disk entry, not just the in-memory one', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-diskcache-clear-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
  const scriptPath = join(directory, 'fake-bd.mjs');
  const logPath = join(directory, 'calls.log');
  writeCountingFakeBd(scriptPath, logPath);
  const cacheDirectory = join(directory, '.git', 'sdlc', 'capabilities');
  const cacheFiles = () => (existsSync(cacheDirectory) ? readdirSync(cacheDirectory) : []);

  inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.equal(cacheFiles().length, 1, 'the first probe writes exactly one on-disk entry');

  clearCapabilityCache();
  assert.deepEqual(cacheFiles(), [], 'clearing must reach the disk layer, or the next process still gets a stale hit');

  inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.equal(readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length, 26, 'the post-clear call fully re-probes rather than reading a surviving disk entry');
});

test('a mutated result cannot poison a later cache hit through a shared nested object', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-capcache-isolation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, 'fake-bd.mjs');
  writeCountingFakeBd(scriptPath, join(directory, 'calls.log'));

  const first = inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  first.capabilities.readonly = 'tampered';
  first.errors.push('tampered');

  const second = inspectBeadsInstallation({ executable: scriptPath, cwd: directory });
  assert.notEqual(second.capabilities.readonly, 'tampered', 'nested capability state must not be shared with the cache');
  assert.equal(second.errors.includes('tampered'), false, 'the cached errors array must not be shared with a returned result');
});

test('atomic claims isolate actors in a temporary Beads repository', { skip: !realBeads.coreCapabilitiesValid, timeout: 60_000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: directory });
  const init = spawnSync('bd', ['init', '--non-interactive', '--skip-hooks', '--skip-agents', '--prefix', 'sdlctest'], {
    cwd: directory,
    env: { ...process.env, BEADS_ACTOR: 'sdlc:test:init' },
    encoding: 'utf8',
  });
  if (init.status !== 0) {
    t.skip(`temporary bd init unavailable: ${init.stderr}`);
    return;
  }
  const created = JSON.parse(execFileSync('bd', ['create', 'claim fixture', '--type=epic', '--json'], {
    cwd: directory,
    env: { ...process.env, BEADS_ACTOR: 'sdlc:test:creator' },
    encoding: 'utf8',
  }));
  const id = created.id ?? created.issue?.id;
  assert(id);
  execFileSync('bd', ['update', id, '--claim'], { cwd: directory, env: { ...process.env, BEADS_ACTOR: 'sdlc:test:actor-a' } });
  execFileSync('bd', ['update', id, '--claim'], { cwd: directory, env: { ...process.env, BEADS_ACTOR: 'sdlc:test:actor-a' } });
  const conflict = spawnSync('bd', ['update', id, '--claim'], {
    cwd: directory,
    env: { ...process.env, BEADS_ACTOR: 'sdlc:test:actor-b' },
    encoding: 'utf8',
  });
  assert.notEqual(conflict.status, 0);
});

test('native human gates preserve the step and failed batches roll back', { skip: !realBeads.coreCapabilitiesValid, timeout: 60_000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-beads-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: directory });
  const environment = { ...process.env, BEADS_ACTOR: 'sdlc:test:native' };
  const init = spawnSync('bd', ['init', '--non-interactive', '--skip-hooks', '--skip-agents', '--prefix', 'sdlctest'], {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
  });
  if (init.status !== 0) {
    t.skip(`temporary bd init unavailable: ${init.stderr}`);
    return;
  }
  const created = JSON.parse(execFileSync('bd', ['create', 'gated step', '--type=task', '--json'], { cwd: directory, env: environment, encoding: 'utf8' }));
  const stepId = created.id;
  const failedBatch = spawnSync('bd', ['batch'], {
    cwd: directory,
    env: environment,
    input: `update ${stepId} title="changed title"\nupdate not-a-real-id title=bad\n`,
    encoding: 'utf8',
  });
  assert.notEqual(failedBatch.status, 0);
  const afterBatch = JSON.parse(execFileSync('bd', ['--readonly', 'show', stepId, '--json'], { cwd: directory, encoding: 'utf8' }))[0];
  assert.equal(afterBatch.title, 'gated step');

  const gate = JSON.parse(execFileSync('bd', ['gate', 'create', '--type=human', '--blocks', stepId, '--reason=Need a decision', '--json'], {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
  }));
  const blockedReady = JSON.parse(execFileSync('bd', ['--readonly', 'ready', '--json'], { cwd: directory, encoding: 'utf8' }));
  assert.equal(blockedReady.some((issue) => issue.id === stepId), false);
  execFileSync('bd', ['gate', 'resolve', gate.id, '--reason=Approved'], { cwd: directory, env: environment, stdio: 'ignore' });
  const ready = JSON.parse(execFileSync('bd', ['--readonly', 'ready', '--json'], { cwd: directory, encoding: 'utf8' }));
  assert.equal(ready.some((issue) => issue.id === stepId), true);
  const step = JSON.parse(execFileSync('bd', ['--readonly', 'show', stepId, '--json'], { cwd: directory, encoding: 'utf8' }))[0];
  assert.equal(step.status, 'open');

  execFileSync('bd', ['merge-slot', 'create'], { cwd: directory, env: environment, stdio: 'ignore' });
  execFileSync('bd', ['merge-slot', 'acquire', '--holder=sdlc:test:lander-a'], { cwd: directory, env: environment, stdio: 'ignore' });
  const competing = spawnSync('bd', ['merge-slot', 'acquire', '--holder=sdlc:test:lander-b'], { cwd: directory, env: { ...environment, BEADS_ACTOR: 'sdlc:test:lander-b' }, encoding: 'utf8' });
  assert.notEqual(competing.status, 0);
  const held = JSON.parse(execFileSync('bd', ['--readonly', 'merge-slot', 'check', '--json'], { cwd: directory, encoding: 'utf8' }));
  assert.equal(held.holder, 'sdlc:test:lander-a');
  execFileSync('bd', ['merge-slot', 'release', '--holder=sdlc:test:lander-a'], { cwd: directory, env: environment, stdio: 'ignore' });
});

test('native worktree inventory exposes the shared store and cleanup safety', { skip: !realBeads.coreCapabilitiesValid, timeout: 60_000 }, (t) => {
  const directory = mkdtempSync(join(packageRoot, '.sdlc-native-worktree-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: directory });
  const environment = { ...process.env, BEADS_ACTOR: 'sdlc:test:worktree' };
  const init = spawnSync('bd', ['init', '--non-interactive', '--skip-hooks', '--skip-agents', '--prefix', 'sdlctest'], {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
  });
  if (init.status !== 0) {
    t.skip(`temporary bd init unavailable: ${init.stderr}`);
    return;
  }
  execFileSync('bd', ['worktree', 'create', '.worktrees/native-plan', '--branch=native-plan', '--json'], { cwd: directory, env: environment, stdio: 'ignore' });
  const worktree = join(directory, '.worktrees', 'native-plan');
  const inventory = JSON.parse(execFileSync('bd', ['--readonly', 'worktree', 'list', '--json'], { cwd: directory, encoding: 'utf8' }));
  const registered = inventory.find((item) => item.branch === 'native-plan');
  assert(registered);
  assert(['local', 'shared', 'redirect'].includes(registered.beads_state));
  const context = JSON.parse(execFileSync('bd', ['--readonly', 'context', '--json'], { cwd: worktree, encoding: 'utf8' }));
  assert.equal(context.repo_root, directory);
  assert.equal(context.is_worktree, true);

  const refused = spawnSync('bd', ['worktree', 'remove', '.worktrees/native-plan'], { cwd: directory, env: environment, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /unpushed commits|safety check/i);
  execFileSync('bd', ['worktree', 'remove', '.worktrees/native-plan', '--force'], { cwd: directory, env: environment, stdio: 'ignore' });
});
