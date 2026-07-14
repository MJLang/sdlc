import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const MINIMUM_BEADS_VERSION = '1.1.0';

const READONLY_COMMANDS = new Map([
  ['blocked', null],
  ['children', null],
  ['context', null],
  ['count', null],
  ['dep', new Set(['cycles', 'list'])],
  ['diff', null],
  ['doctor', null],
  ['gate', new Set(['list'])],
  ['graph', null],
  ['human', new Set(['list', 'stats'])],
  ['info', null],
  ['list', null],
  ['memories', null],
  ['merge-slot', new Set(['check'])],
  ['orphans', null],
  ['ping', null],
  ['ready', null],
  ['recall', null],
  ['search', null],
  ['show', null],
  ['stale', null],
  ['status', null],
  ['version', null],
  ['where', null],
  ['worktree', new Set(['info', 'list'])],
]);

const MUTATING_COMMANDS = new Map([
  ['batch', null],
  ['close', null],
  ['create', null],
  ['dep', new Set(['add', 'remove'])],
  ['dolt', new Set(['push'])],
  ['forget', null],
  ['gate', new Set(['create', 'resolve'])],
  ['label', null],
  ['merge-slot', new Set(['acquire', 'create', 'release'])],
  ['note', null],
  ['remember', null],
  ['reopen', null],
  ['update', null],
  ['worktree', new Set(['create', 'remove'])],
]);

const MUTATING_READONLY_FLAGS = new Set([
  '--clean', '--fix', '--force', '--yes', '-f', '-y', '--set', '--unset', '--delete',
  '--output', '-o', '--perf', '--profile',
]);

export class BeadsCommandError extends Error {
  constructor(message, result = {}) {
    super(message);
    this.name = 'BeadsCommandError';
    this.status = result.status;
    this.stdout = result.stdout ?? '';
    this.stderr = result.stderr ?? '';
    this.cause = result.error;
  }
}

export function defaultCommandRunner(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

export function parseBeadsVersion(output) {
  const match = String(output ?? '').match(/\b(?:v(?:ersion)?[ \t]*)?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/i);
  return match ? { raw: `${match[1]}.${match[2]}.${match[3]}`, parts: match.slice(1, 4).map(Number) } : undefined;
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseBeadsVersion(left)?.parts : left?.parts ?? left;
  const b = typeof right === 'string' ? parseBeadsVersion(right)?.parts : right?.parts ?? right;
  if (!a || !b) throw new TypeError('Both versions must be semantic versions.');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function help(runner, executable, args, cwd) {
  const result = runner(executable, ['--readonly', ...args, '--help'], { cwd, env: process.env });
  return result.status === 0 ? `${result.stdout}\n${result.stderr}` : '';
}

export function inspectBeadsInstallation({ cwd = process.cwd(), executable = 'bd', runner = defaultCommandRunner } = {}) {
  const versionResult = runner(executable, ['--readonly', '--version'], { cwd, env: process.env });
  if (versionResult.error || versionResult.status !== 0) {
    return {
      available: false,
      supported: false,
      version: null,
      capabilities: {},
      coreCapabilitiesValid: false,
      errors: [`Beads executable '${executable}' is unavailable.`],
    };
  }

  const parsed = parseBeadsVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  const root = help(runner, executable, [], cwd);
  const update = help(runner, executable, ['update'], cwd);
  const gate = help(runner, executable, ['gate'], cwd);
  const worktree = help(runner, executable, ['worktree'], cwd);
  const doctor = help(runner, executable, ['doctor'], cwd);
  const dependency = help(runner, executable, ['dep', 'add'], cwd);
  const dependencyCycles = help(runner, executable, ['dep', 'cycles'], cwd);
  const stale = help(runner, executable, ['stale'], cwd);
  const orphans = help(runner, executable, ['orphans'], cwd);
  const create = help(runner, executable, ['create'], cwd);
  const batch = help(runner, executable, ['batch'], cwd);
  const mergeSlot = help(runner, executable, ['merge-slot'], cwd);

  const capabilities = {
    readonly: /--readonly\b/.test(root),
    atomicClaim: /--claim\b/.test(update),
    specIdentity: /--spec-id\b/.test(update) && /--set-metadata\b/.test(update) && /--spec-id\b/.test(create),
    humanGates: /\bcreate\b/.test(gate) && /\bresolve\b/.test(gate) && /\blist\b/.test(gate),
    nativeWorktrees: /\bcreate\b/.test(worktree) && /\bremove\b/.test(worktree) && /\blist\b/.test(worktree),
    agentDoctor: /--agent\b/.test(doctor),
    serverDoctor: /--server\b/.test(doctor),
    dependencyBulk: /--file\b/.test(dependency),
    dependencyCycles: Boolean(dependencyCycles),
    stale: /--status\b/.test(stale),
    orphans: /--fix\b/.test(orphans),
    batch: /single database transaction|single dolt transaction/i.test(batch),
    mergeSlot: /\bacquire\b/.test(mergeSlot) && /\brelease\b/.test(mergeSlot) && /\bcheck\b/.test(mergeSlot),
  };
  const required = [
    'readonly', 'atomicClaim', 'specIdentity', 'humanGates', 'nativeWorktrees',
    'agentDoctor', 'dependencyBulk', 'dependencyCycles', 'stale', 'orphans',
  ];
  const missing = required.filter((name) => !capabilities[name]);
  const supported = Boolean(parsed) && compareVersions(parsed, MINIMUM_BEADS_VERSION) >= 0;
  const errors = [];
  if (!parsed) errors.push('Could not parse the installed Beads version.');
  else if (!supported) errors.push(`Beads ${parsed.raw} is older than required ${MINIMUM_BEADS_VERSION}.`);
  if (missing.length) errors.push(`Beads is missing required capabilities: ${missing.join(', ')}.`);

  return {
    available: true,
    supported,
    version: parsed?.raw ?? null,
    capabilities,
    coreCapabilitiesValid: supported && missing.length === 0,
    missingCapabilities: missing,
    errors,
  };
}

function runtimeName(value) {
  const normalized = String(value || 'agent').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'agent';
}

function sessionToken(value) {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || randomUUID();
}

export function isSessionActor(value) {
  return /^sdlc:[a-z0-9._-]+:[A-Za-z0-9._:-]+$/.test(String(value ?? ''));
}

export function createSessionActor({
  runtime = process.env.SDLC_RUNTIME || 'agent',
  sessionId = process.env.SDLC_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID,
  existingActor = process.env.BEADS_ACTOR,
  fresh = false,
} = {}) {
  if (!fresh && isSessionActor(existingActor)) return existingActor;
  return `sdlc:${runtimeName(runtime)}:${sessionToken(sessionId)}`;
}

function gitCommonDirectory(cwd) {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error('Cannot persist an SDLC session actor outside a Git worktree.');
  }
  return resolve(cwd, result.stdout.trim());
}

function runtimeSessionId(env) {
  return env.SDLC_SESSION_ID || env.CODEX_THREAD_ID || env.CLAUDE_SESSION_ID || null;
}

function actorRegistryPath({ cwd, runtime, env }) {
  const commonDirectory = gitCommonDirectory(cwd);
  const runtimeKey = runtimeName(runtime);
  const suppliedSessionId = runtimeSessionId(env);
  const sessionKey = suppliedSessionId
    ? createHash('sha256').update(`${runtimeKey}\0${suppliedSessionId}`).digest('hex').slice(0, 24)
    : 'active';
  return join(commonDirectory, 'sdlc', 'actors', `${runtimeKey}-${sessionKey}.json`);
}

function readStoredActor(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return isSessionActor(record.actor) ? record.actor : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredActor(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Return the actor for this agent-runtime session, persisted in Git common
 * state so separate shells and linked worktrees rehydrate the same identity.
 * A fresh root boundary atomically rotates its own session-keyed record.
 */
export function repositorySessionActor({
  cwd = process.cwd(),
  runtime = process.env.SDLC_RUNTIME || 'agent',
  fresh = false,
  env = process.env,
} = {}) {
  const path = actorRegistryPath({ cwd, runtime, env });
  if (!fresh) {
    const stored = readStoredActor(path);
    if (stored) return stored;
  }
  const actor = createSessionActor({ runtime, sessionId: randomUUID(), existingActor: null, fresh: true });
  writeStoredActor(path, {
    actor,
    runtime: runtimeName(runtime),
    runtimeSessionId: runtimeSessionId(env),
    rotatedAt: new Date().toISOString(),
  });
  return actor;
}

function commandAllowed(args, commands) {
  const command = args[0];
  const subcommands = commands.get(command);
  return commands.has(command) && (!subcommands || subcommands.has(args[1]));
}

export function assertReadonlyBeadsCommand(args) {
  if (!Array.isArray(args) || !args.length || !commandAllowed(args, READONLY_COMMANDS)) {
    throw new TypeError(`Beads command is not allowed through the read-only adapter: ${args?.join(' ') || '<empty>'}`);
  }
  if (args.some((argument) => {
    if (MUTATING_READONLY_FLAGS.has(argument)) return true;
    return [...MUTATING_READONLY_FLAGS]
      .filter((flag) => flag.startsWith('--'))
      .some((flag) => argument.startsWith(`${flag}=`) || (flag === '--fix' && argument.startsWith('--fix-')));
  })) {
    throw new TypeError(`Mutating flag is forbidden in a read-only Beads command: ${args.join(' ')}`);
  }
}

export function assertMutatingBeadsCommand(args) {
  if (!Array.isArray(args) || !args.length || !commandAllowed(args, MUTATING_COMMANDS)) {
    throw new TypeError(`Beads command is not allowed through the mutating adapter: ${args?.join(' ') || '<empty>'}`);
  }
  if (args.includes('--readonly')) throw new TypeError('A mutating Beads command cannot use --readonly.');
}

export function parseBeadsJson(stdout, description = 'Beads response') {
  const value = String(stdout ?? '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new BeadsCommandError(`${description} was not valid JSON: ${error.message}`, { stdout: value });
  }
}

export function collectionFromBeadsJson(value, keys = ['issues', 'items', 'results', 'ready', 'gates', 'worktrees', 'escalations', 'orphans', 'cycles']) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

export function issueMetadata(issue) {
  const metadata = issue?.metadata ?? issue?.custom_metadata ?? {};
  if (metadata && typeof metadata === 'object') return metadata;
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

function runOrThrow(runner, executable, args, options, description) {
  const result = runner(executable, args, options);
  if (result.error || result.status !== 0) {
    throw new BeadsCommandError(`${description} failed${result.status === null ? '' : ` (exit ${result.status})`}.`, result);
  }
  return result;
}

export function createBeadsAdapter({
  cwd = process.cwd(),
  actor,
  executable = 'bd',
  runner = defaultCommandRunner,
} = {}) {
  function readonly(args, { json = false, allowNonZero = false } = {}) {
    assertReadonlyBeadsCommand(args);
    const commandArgs = ['--readonly', ...args];
    if (json && !commandArgs.includes('--json')) commandArgs.push('--json');
    const result = runner(executable, commandArgs, { cwd, env: process.env });
    if (!allowNonZero && (result.error || result.status !== 0)) {
      throw new BeadsCommandError(`Read-only Beads command failed: bd ${commandArgs.join(' ')}`, result);
    }
    return result;
  }

  function readonlyJson(args, options = {}) {
    const result = readonly(args, { ...options, json: true });
    return parseBeadsJson(result.stdout, `bd --readonly ${args.join(' ')}`);
  }

  function tryReadonlyJson(args, options = {}) {
    try {
      const result = readonly(args, { ...options, json: true, allowNonZero: true });
      let data;
      try {
        data = parseBeadsJson(result.stdout, `bd --readonly ${args.join(' ')}`);
      } catch (error) {
        return { ok: false, status: result.status, data: null, error: error.message, stderr: result.stderr };
      }
      return {
        ok: !result.error && result.status === 0,
        status: result.status,
        data,
        error: result.error?.message ?? (result.status === 0 ? null : result.stderr.trim() || 'Beads command failed.'),
        stderr: result.stderr,
      };
    } catch (error) {
      return { ok: false, status: error.status, data: null, error: error.message, stderr: error.stderr };
    }
  }

  function mutate(args, { json = false, input } = {}) {
    assertMutatingBeadsCommand(args);
    if (!isSessionActor(actor)) throw new TypeError('Mutating Beads calls require a valid session-scoped sdlc actor.');
    const commandArgs = [...args];
    if (json && !commandArgs.includes('--json')) commandArgs.push('--json');
    const env = { ...process.env, BEADS_ACTOR: actor };
    return runOrThrow(runner, executable, commandArgs, { cwd, env, input }, `Mutating Beads command bd ${commandArgs.join(' ')}`);
  }

  function mutateJson(args, options = {}) {
    const result = mutate(args, { ...options, json: true });
    return parseBeadsJson(result.stdout, `bd ${args.join(' ')}`);
  }

  return {
    cwd,
    actor,
    readonly,
    readonlyJson,
    tryReadonlyJson,
    mutate,
    mutateJson,
    showIssue(id) {
      const data = readonlyJson(['show', id, '--long']);
      return Array.isArray(data) ? data[0] : data;
    },
    connectionContext() {
      return readonlyJson(['context']);
    },
    listChildren(id) {
      return collectionFromBeadsJson(readonlyJson(['list', '--parent', id, '--all', '--limit', '0']));
    },
    listReady() {
      return collectionFromBeadsJson(readonlyJson(['ready']));
    },
    claim(id) {
      return mutateJson(['update', id, '--claim']);
    },
    updateSpecIdentity(id, { specId, ticketPath, planPath, stepNumber } = {}) {
      if (!specId || !ticketPath || !planPath) throw new TypeError('Spec identity requires specId, ticketPath, and planPath.');
      const identityArgs = [
        'update', id,
        '--spec-id', specId,
        '--set-metadata', `sdlc_ticket=${ticketPath}`,
        '--set-metadata', `sdlc_plan=${planPath}`,
      ];
      if (stepNumber !== undefined) identityArgs.push('--set-metadata', `sdlc_step=${stepNumber}`);
      return mutateJson(identityArgs);
    },
    createHumanGate(stepId, reason) {
      if (!reason?.trim()) throw new TypeError('Human gate reason must be non-empty.');
      return mutateJson(['gate', 'create', '--type=human', '--blocks', stepId, '--reason', reason.trim()]);
    },
    resolveGate(gateId, reason) {
      if (!reason?.trim()) throw new TypeError('Gate resolution reason must be non-empty.');
      return mutateJson(['gate', 'resolve', gateId, '--reason', reason.trim()]);
    },
    listGates() {
      return collectionFromBeadsJson(readonlyJson(['gate', 'list'])).map((gate) => {
        if (!gate?.id) return gate;
        const dependents = collectionFromBeadsJson(readonlyJson(['dep', 'list', gate.id, '--direction=up', '--type=blocks']));
        const blockedIssueIds = dependents.map((issue) => issue?.id ?? issue?.issue_id).filter(Boolean);
        return {
          ...gate,
          ...(blockedIssueIds[0] ? { blocks: blockedIssueIds[0] } : {}),
          blocked_issue_ids: blockedIssueIds,
        };
      });
    },
    listHumanEscalations() {
      return collectionFromBeadsJson(readonlyJson(['human', 'list']));
    },
    createWorktree(path, branch) {
      return mutateJson(['worktree', 'create', path, '--branch', branch]);
    },
    removeWorktree(path, { force = false } = {}) {
      if (force) throw new TypeError('The normal SDLC worktree cleanup contract forbids --force.');
      return mutateJson(['worktree', 'remove', path]);
    },
    listWorktrees() {
      return collectionFromBeadsJson(readonlyJson(['worktree', 'list']));
    },
    dependencyCycles() {
      return collectionFromBeadsJson(readonlyJson(['dep', 'cycles']));
    },
    addDependencies(edges) {
      const lines = edges.map(({ from, to, type }) => JSON.stringify({ from, to, ...(type ? { type } : {}) })).join('\n');
      return mutateJson(['dep', 'add', '--file', '-'], { input: `${lines}\n` });
    },
    staleClaims(days = 1) {
      return collectionFromBeadsJson(readonlyJson(['stale', '--status=in_progress', `--days=${days}`]));
    },
    orphans() {
      return collectionFromBeadsJson(readonlyJson(['orphans']));
    },
    doctor({ server = false } = {}) {
      return tryReadonlyJson(['doctor', server ? '--server' : '--agent']);
    },
    mergeSlotCheck() {
      const result = tryReadonlyJson(['merge-slot', 'check']);
      if (result.ok && result.data?.id && !result.data.error) {
        try {
          const detail = this.showIssue(result.data.id);
          result.data = { ...detail, ...result.data };
        } catch {
          // The check result remains authoritative; missing enrichment only
          // removes age/detail fields and never turns an observer into repair.
        }
      }
      return result;
    },
    createMergeSlot() {
      return mutateJson(['merge-slot', 'create']);
    },
    acquireMergeSlot() {
      return mutateJson(['merge-slot', 'acquire', '--holder', actor]);
    },
    releaseMergeSlot() {
      return mutateJson(['merge-slot', 'release', '--holder', actor]);
    },
    runBatch(operations, { message } = {}) {
      const input = serializeBatchOperations(operations);
      const args = ['batch'];
      if (message) args.push('--message', message);
      return mutateJson(args, { input });
    },
  };
}

const BATCH_UPDATE_KEYS = new Set(['status', 'priority', 'title', 'assignee']);
const BATCH_DEP_TYPES = new Set(['blocks', 'tracks', 'related', 'parent-child', 'discovered-from', 'until', 'caused-by', 'validates', 'relates-to', 'supersedes']);

function quoteBatchToken(value) {
  const token = String(value);
  return /\s|["\\]/.test(token) ? `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : token;
}

export function isBatchCompatible(operations) {
  if (!Array.isArray(operations) || !operations.length) return false;
  return operations.every((operation) => {
    if (operation.kind === 'close') return Boolean(operation.id);
    if (operation.kind === 'update') {
      const keys = Object.keys(operation.fields ?? {});
      return Boolean(operation.id) && keys.length > 0 && keys.every((key) => BATCH_UPDATE_KEYS.has(key));
    }
    if (operation.kind === 'dep-add') return Boolean(operation.from && operation.to) && (!operation.type || BATCH_DEP_TYPES.has(operation.type));
    if (operation.kind === 'dep-remove') return Boolean(operation.from && operation.to);
    return false;
  });
}

export function serializeBatchOperations(operations) {
  if (!isBatchCompatible(operations)) throw new TypeError('Operations do not fit the supported Beads batch grammar.');
  const lines = operations.map((operation) => {
    if (operation.kind === 'close') return `close ${quoteBatchToken(operation.id)}${operation.reason ? ` ${quoteBatchToken(operation.reason)}` : ''}`;
    if (operation.kind === 'update') {
      const fields = Object.entries(operation.fields).map(([key, value]) => `${key}=${quoteBatchToken(value)}`);
      return `update ${quoteBatchToken(operation.id)} ${fields.join(' ')}`;
    }
    if (operation.kind === 'dep-add') return `dep add ${quoteBatchToken(operation.from)} ${quoteBatchToken(operation.to)}${operation.type ? ` ${operation.type}` : ''}`;
    return `dep remove ${quoteBatchToken(operation.from)} ${quoteBatchToken(operation.to)}`;
  });
  return `${lines.join('\n')}\n`;
}

export function collectNativeDiagnostics(adapter, { mode = 'embedded', mergeSlotEnabled = false } = {}) {
  // Beads 1.1 advertises --agent but explicitly does not implement it in
  // embedded mode and emits non-JSON prose even when --json is supplied.
  // Context plus the focused native checks below are the deterministic
  // embedded health surface; server mode retains both doctor profiles.
  const health = mode === 'server'
    ? adapter.doctor()
    : { ok: true, data: { mode: 'embedded', supported: false }, error: null };
  const serverHealth = mode === 'server' ? adapter.doctor({ server: true }) : null;
  const get = (method) => {
    try {
      return { ok: true, data: adapter[method]() };
    } catch (error) {
      return { ok: false, data: [], error: error.message };
    }
  };
  return {
    context: get('connectionContext'),
    ready: get('listReady'),
    health,
    serverHealth,
    cycles: get('dependencyCycles'),
    worktrees: get('listWorktrees'),
    gates: get('listGates'),
    escalations: get('listHumanEscalations'),
    stale: get('staleClaims'),
    orphans: get('orphans'),
    mergeSlot: mergeSlotEnabled ? adapter.mergeSlotCheck() : null,
  };
}
