import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants, accessSync, chmodSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { configuredGateCommands, readProjectConfig } from './config.mjs';

export const GATE_LOG_LIMIT = 1024 * 1024;
export const GATE_FAILURE_EXCERPT_LIMIT = 8192;
export const GATE_RUN_RETENTION = 10;

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function primaryCheckout(cwd) {
  const worktrees = git(cwd, ['worktree', 'list', '--porcelain']);
  return worktrees.match(/^worktree (.+)$/m)?.[1] || git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
}

export function gitCommonDirectory(cwd = process.cwd()) {
  const value = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!value) throw new Error('Git common directory could not be resolved.');
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function repositoryFingerprint(value) {
  return createHash('sha256').update(resolve(value)).digest('hex').slice(0, 16);
}

function proveWritableDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  accessSync(path, constants.W_OK | constants.X_OK);
  const probe = join(path, `.write-probe-${process.pid}-${randomUUID()}`);
  const descriptor = openSync(probe, 'wx', 0o600);
  closeSync(descriptor);
  rmSync(probe, { force: true });
  return path;
}

export function selectGateLogRoot({
  cwd = process.cwd(),
  commonDirectory,
  temporaryDirectory = tmpdir(),
} = {}) {
  let common = commonDirectory;
  try {
    common ||= gitCommonDirectory(cwd);
    return { path: proveWritableDirectory(join(common, 'sdlc', 'logs')), storage: 'git-common' };
  } catch (commonError) {
    const fingerprint = repositoryFingerprint(common || git(cwd, ['rev-parse', '--show-toplevel']) || cwd);
    const fallback = join(temporaryDirectory, `sdlc-gates-${fingerprint}`);
    try {
      return { path: proveWritableDirectory(fallback), storage: 'temporary', warning: commonError.message };
    } catch (temporaryError) {
      throw new Error(`Quality gates were not run: Git-common logging is unavailable (${commonError.message}); temporary fallback is unavailable (${temporaryError.message}).`);
    }
  }
}

function runName(now) {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function pruneRuns(root, keep = GATE_RUN_RETENTION) {
  const runs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, modified: statSync(join(root, entry.name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
  for (const run of runs.slice(keep)) rmSync(join(root, run.name), { recursive: true, force: true });
}

function countSummary(output) {
  const fields = {};
  for (const [key, patterns] of Object.entries({
    tests: [/^(?:#|ℹ) tests[ \t]+(\d+)$/im, /\bTests?[ \t]+(\d+)\b/i],
    pass: [/^(?:#|ℹ) pass[ \t]+(\d+)$/im, /\b(\d+)[ \t]+passed\b/i],
    fail: [/^(?:#|ℹ) fail[ \t]+(\d+)$/im, /\b(\d+)[ \t]+failed\b/i],
    skipped: [/^(?:#|ℹ) skipped[ \t]+(\d+)$/im, /\b(\d+)[ \t]+skipped\b/i],
  })) {
    const value = patterns.map((pattern) => output.match(pattern)?.[1]).find((candidate) => candidate !== undefined);
    if (value !== undefined) fields[key] = Number(value);
  }
  return fields;
}

function failureExcerpt(output, { maxBytes = GATE_FAILURE_EXCERPT_LIMIT, maxLines = 40 } = {}) {
  const lines = String(output ?? '').replace(/\r\n?/g, '\n').split('\n');
  const match = lines.findIndex((line) => /(?:^not ok\b|\b(?:error|failed|failure|exception|assertion)\b)/i.test(line));
  const start = match >= 0 ? Math.max(0, match - 3) : Math.max(0, lines.length - maxLines);
  let excerpt = lines.slice(start, start + maxLines).join('\n').trim();
  while (Buffer.byteLength(excerpt) > maxBytes && excerpt.length) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.9));
  if (start > 0) excerpt = `[${start} earlier line(s) omitted]\n${excerpt}`;
  if (start + maxLines < lines.length) excerpt += `\n[${lines.length - start - maxLines} later line(s) omitted]`;
  return excerpt || '(gate produced no output)';
}

function executeGate(command, { cwd, env, logPath, logLimit }) {
  return new Promise((resolvePromise) => {
    const started = process.hrtime.bigint();
    let keptBytes = 0;
    let omittedBytes = 0;
    const chunks = [];
    const childEnvironment = { ...env };
    // A gate launched by a Node test must still be an independent test run;
    // inheriting this private marker makes node --test suppress its own files.
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(command, { cwd, env: childEnvironment, shell: true });
    const capture = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, logLimit - keptBytes);
      if (remaining) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(kept);
        keptBytes += kept.length;
      }
      omittedBytes += Math.max(0, buffer.length - remaining);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', (error) => capture(Buffer.from(`\n${error.stack || error.message}\n`)));
    child.once('close', (status, signal) => {
      const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      let output = Buffer.concat(chunks).toString('utf8');
      if (omittedBytes) output += `\n[SDLC LOG TRUNCATED: ${omittedBytes} byte(s) omitted after ${logLimit} byte cap]\n`;
      writeFileSync(logPath, output, { mode: 0o600 });
      chmodSync(logPath, 0o600);
      resolvePromise({
        status: status ?? 1,
        signal: signal ?? null,
        durationMs,
        output,
        logPath,
        truncatedBytes: omittedBytes,
        counts: countSummary(output),
      });
    });
  });
}

export async function runGates({
  cwd = process.cwd(),
  target,
  adHocCommands = [],
  env = process.env,
  config,
  now = Date.now(),
  commonDirectory,
  temporaryDirectory,
  logLimit = GATE_LOG_LIMIT,
} = {}) {
  config ??= readProjectConfig(primaryCheckout(cwd));
  if (config.errors?.length) throw new TypeError(config.errors.join(' '));
  const commands = configuredGateCommands(config, target, adHocCommands);
  // Both storage locations are proved writable before the first command runs.
  const logRoot = selectGateLogRoot({ cwd, commonDirectory, temporaryDirectory });
  const directory = join(logRoot.path, runName(now));
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  chmodSync(directory, 0o700);
  pruneRuns(logRoot.path);

  const results = [];
  for (const [index, gate] of commands.entries()) {
    const logPath = join(directory, `${String(index + 1).padStart(2, '0')}.log`);
    const execution = await executeGate(gate.command, { cwd, env, logPath, logLimit });
    const result = { command: gate.command, source: gate.source, ...execution };
    if (execution.status !== 0) result.excerpt = failureExcerpt(execution.output);
    results.push(result);
    if (execution.status !== 0) break;
  }

  const summary = {
    version: 1,
    createdAt: new Date(now).toISOString(),
    cwd: resolve(cwd),
    target: target ?? null,
    storage: logRoot.storage,
    warning: logRoot.warning ?? null,
    ok: results.length === commands.length && results.every((result) => result.status === 0),
    commands: results.map((result) => ({
      command: result.command,
      source: result.source,
      status: result.status,
      durationMs: result.durationMs,
      counts: result.counts,
      logPath: result.logPath,
      truncatedBytes: result.truncatedBytes,
    })),
  };
  const summaryPath = join(directory, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  chmodSync(summaryPath, 0o600);
  return { ...summary, directory, summaryPath, results };
}

function quote(value) {
  return JSON.stringify(String(value));
}

export function formatGateRun(run) {
  const lines = [];
  for (const result of run.results) {
    const counts = Object.entries(result.counts).map(([key, value]) => `${key}=${value}`).join(' ');
    if (result.status === 0) {
      lines.push(`PASS command=${quote(result.command)} source=${result.source} duration_ms=${result.durationMs}${counts ? ` ${counts}` : ''}`);
    } else {
      lines.push(`FAIL command=${quote(result.command)} source=${result.source} exit=${result.status} duration_ms=${result.durationMs}${counts ? ` ${counts}` : ''}`);
      lines.push('--- bounded failure excerpt ---');
      lines.push(result.excerpt);
      lines.push('--- end excerpt ---');
      lines.push(`log=${result.logPath}`);
    }
  }
  if (run.storage === 'temporary') lines.push(`warning=git-common-unwritable logs=${run.directory}`);
  return lines.join('\n');
}

export function gateExitCode(run) {
  return run.ok ? 0 : run.results.find((result) => result.status !== 0)?.status || 1;
}

export function latestGateSummary(cwd = process.cwd(), { temporaryDirectory = tmpdir() } = {}) {
  const candidates = [];
  let common;
  try {
    common = gitCommonDirectory(cwd);
    candidates.push(join(common, 'sdlc', 'logs'));
  } catch {
    // The fallback candidate below remains available outside a Git worktree.
  }
  candidates.push(join(temporaryDirectory, `sdlc-gates-${repositoryFingerprint(common || git(cwd, ['rev-parse', '--show-toplevel']) || cwd)}`));
  for (const root of candidates) {
    try {
      const runs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, 'summary.json'))
        .filter((path) => {
          try { return statSync(path).isFile(); } catch { return false; }
        })
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
      if (runs[0]) return JSON.parse(readFileSync(runs[0], 'utf8'));
    } catch {
      // Try the next deterministic storage location.
    }
  }
  return null;
}
