#!/usr/bin/env node
/**
 * @mlangroman/sdlc — project bootstrapper for the ticket → plan → implement → land pipeline.
 *
 * Usage:
 *   npx @mlangroman/sdlc setup [--claude|--codex|--pi] [--force] [--skip-skills] [--skip-beads]
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createSessionActor, inspectBeadsInstallation, repositorySessionActor } from '../lib/beads.mjs';
import { configProjection, detectLegacyConfigSection, effectiveSettings, readProjectConfig } from '../lib/config.mjs';
import { doctorExitCode, formatDoctor, inspectDoctor, resolvePrimaryCheckout } from '../lib/doctor.mjs';
import { fingerprintContent, fingerprintFile, formatFingerprint } from '../lib/fingerprint.mjs';
import { formatGateRun, gateExitCode, runGates } from '../lib/gates.mjs';
import { formatGuard, guardExitCode, inspectGuard } from '../lib/guard.mjs';
import { CHORE_LANE_SENTINEL, parseReviewArtifact, parseReviewerList, renderReviewTemplate, reviewConvergence } from '../lib/review-artifact.mjs';
import { createReviewPackets, formatReviewPacket, reviewerNamesFor } from '../lib/review-packet.mjs';
import { formatResume, resumeExitCode, runResume } from '../lib/resume.mjs';
import { inspectSnapshot } from '../lib/snapshot.mjs';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = process.cwd();

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (s) => console.log(`  ${c('32', '✓')} ${s}`);
const skip = (s) => console.log(`  ${c('90', '•')} ${s}`);
const warn = (s) => console.log(`  ${c('33', '!')} ${s}`);
const head = (s) => console.log(`\n${c('1', s)}`);

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-'));
const flags = new Set(args.filter((a) => a.startsWith('-')));
const force = flags.has('--force') || flags.has('-f');
const hasAgentTarget = flags.has('--claude') || flags.has('--codex') || flags.has('--pi');
const installClaude = flags.has('--claude') || !hasAgentTarget;
const installCodex = flags.has('--codex');
const installPi = flags.has('--pi');

const SKILLS_DIR = join(pkgRoot, 'skills');
const LEGACY_SKILL_NAMES = ['approve', 'cancel', 'chore', 'implement', 'land', 'next', 'plan', 'queue', 'review', 'ticket'];
const THOUGHTS_SUBDIRS = ['tickets', 'plans', 'designs', 'docs', 'reviews'];
const CODEX_AGENT_MODELS = {
  // Code review benefits from the frontier model's deeper reasoning.
  'backend-code-reviewer': 'gpt-5.6',
  'frontend-code-reviewer': 'gpt-5.6',
  'general-code-reviewer': 'gpt-5.6',
  'plan-reviewer': 'gpt-5.6',
};
const CODEX_AGENT_REASONING_EFFORTS = {
  'backend-code-reviewer': 'high',
  'frontend-code-reviewer': 'high',
  'general-code-reviewer': 'high',
  'plan-reviewer': 'high',
};

function help() {
  console.log(`
${c('1', '@mlangroman/sdlc')} — ticket → plan → implement → land pipeline for agentic development

Usage:
  npx @mlangroman/sdlc setup [options]     Set up the pipeline in the current directory
  sdlc config [--json] [--field <path>]     Print resolved project configuration
  sdlc actor [runtime] [--new]              Print a session-scoped Beads actor
  sdlc hash <file> [--rev <commit>]         Print the canonical full-file SHA-256
  sdlc doctor <NNN> [--json]                Validate pipeline and native Beads integrity
  sdlc snapshot --view=next|queue --json    Collect one deterministic read-only pipeline snapshot
  sdlc guard <stage> <NNN> [--json]         Validate one stage and print a terse result
  sdlc resume <NNN> [--runtime <name>]      Adopt an abandoned plan epic under a fresh actor
  sdlc gates [--cwd <dir>] [--target <t>]   Run configured quality gates with bounded output
  sdlc review-packet <NNN> [options]         Build deterministic lane-scoped reviewer context
  sdlc review-artifact [options]            Generate or validate one aggregate review artifact
  sdlc review <NNN> [options]               Prepare a plan worktree for local human review

Options:
  --force, -f      Overwrite existing thoughts/AGENTS.md, root AGENTS.md, skills, and agents
  --claude         Install skills and bundled agents for Claude Code (default)
  --codex          Install skills and bundled agents for Codex
  --pi             Install skills and pi-subagents-compatible reviewer profiles for Pi
  --skip-skills    Do not install skills
  --skip-agents    Do not install bundled agents
  --skip-beads     Do not run bd init

Config options:
  --field <path>   Narrow output to one dotted-key setting (e.g. beads.mode)
  --json           Emit the resolved configuration as JSON

Review options:
  --editor         Open the configured review editor
  --artifact       Open the latest persisted automated-review artifact
  --diff           Show the branch diff against main
  --preview        Start the configured local preview in the background
  --port <number>  Port to use for --preview (when the preview command uses {port})

Gate options:
  --cwd <dir>      Worktree in which to run gates (defaults to the current directory)
  --target <t>     Include configured gates for one known target
  --command <cmd>  Add an explicit ad-hoc command (repeatable and reported as ad-hoc)

Review-packet options:
  --reviewer <name>  Select one reviewer (repeatable; default derives configured reviewers)
  --base <revision>  Diff base (default: main)
  --head <revision>  Reviewed revision (default: HEAD)
  --json             Emit packet objects as compact JSON instead of Markdown

Review-artifact options:
  --template <NNN>   Emit the aggregate skeleton with doctor-known identity pre-filled
  --round <n>        Review round for --template (required, positive integer)
  --reviewers a,b,c  Override the derived reviewer set for --template
  --base <revision>  Diff base used to derive reviewers (default: main)
  --head <revision>  Reviewed revision (default: HEAD)
  --validate <path>  Parse one artifact and report every failure with its line number
  --json             Emit the validation result as JSON

What setup does:
  1. git init (if not already a repository)
  2. Installs .agents/sdlc.json (project configuration, never overwritten) plus its
     generated JSON Schemas, and ignores the machine-scoped .agents/sdlc.local.json overlay
  3. Creates thoughts/{${THOUGHTS_SUBDIRS.join(',')}} + compact instructions/docs index (+ CLAUDE.md symlink)
  4. Creates a root AGENTS.md (if missing) and a root CLAUDE.md → AGENTS.md symlink
  5. Installs pipeline skills into .agents/skills/ (symlinked into .claude/skills/ for Claude)
  6. Installs four bundled read-only reviewer profiles into .claude/agents/ (Claude), .codex/agents/ (Codex), or .pi/agents/ (Pi with pi-subagents)
  7. Verifies Beads >= 1.1.0 and initializes it (unless --skip-beads)
  8. Installs/updates a minimal .beads/PRIME.md with no memory bodies

Skills can also be installed on their own, for any supported agent, via the skills CLI:
  npx skills add MJLang/sdlc
`);
}

function commandOutput(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

function git(args, options = {}) {
  return commandOutput('git', args, options);
}

function substitute(value, variables) {
  return value.replace(/\{(worktree|port)\}/g, (_, key) => String(variables[key]));
}

// `thoughts/reviews/{NNN}-round{n}.md` — the one place this CLI spells the
// convention, for both "the latest round" and "the round before this one".
function reviewArtifactRound(file) {
  const match = basename(file).match(/^(\d+)-round(\d+)\.md$/);
  return match ? { number: match[1], round: Number(match[2]) } : undefined;
}

function latestReviewArtifact(worktree, number) {
  const reviewsDir = join(worktree, 'thoughts', 'reviews');
  if (!existsSync(reviewsDir)) return undefined;
  const matches = readdirSync(reviewsDir)
    .map((file) => ({ file, parsed: reviewArtifactRound(file) }))
    .filter((entry) => entry.parsed?.number === number)
    .sort((a, b) => a.parsed.round - b.parsed.round);
  return matches.length ? join(reviewsDir, matches.at(-1).file) : undefined;
}

function verdictFrom(artifact) {
  if (!artifact) return undefined;
  const parsed = parseReviewArtifact(readFileSync(artifact, 'utf8'));
  return parsed.valid ? parsed.verdict?.value : undefined;
}

function openPath(path) {
  if (process.platform === 'darwin') return spawnSync('open', [path], { stdio: 'ignore' });
  if (process.platform === 'win32') return spawnSync('cmd.exe', ['/c', 'start', '', path], { stdio: 'ignore' });
  return spawnSync('xdg-open', [path], { stdio: 'ignore' });
}

function availablePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(preferred, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function positionalAfter(name, { skipOptionValues = new Set() } = {}) {
  const commandIndex = args.indexOf(name);
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    if (skipOptionValues.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith('-')) return args[index];
  }
  return undefined;
}

function optionValue(name) {
  const assignment = args.find((argument) => argument.startsWith(`${name}=`));
  if (assignment) return assignment.slice(name.length + 1);
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function optionValues(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      if (args[index + 1] !== undefined && !args[index + 1].startsWith('--')) values.push(args[index + 1]);
      index += 1;
    } else if (args[index].startsWith(`${name}=`)) values.push(args[index].slice(name.length + 1));
  }
  return values;
}

function actor() {
  const runtimeFlag = args.findIndex((argument) => argument === '--runtime');
  const runtimeAssignment = args.find((argument) => argument.startsWith('--runtime='));
  const runtime = runtimeFlag >= 0
    ? args[runtimeFlag + 1]
    : runtimeAssignment?.slice('--runtime='.length) || positionalAfter('actor');
  if (runtimeFlag >= 0 && !runtime) {
    console.error('Usage: sdlc actor [runtime] [--new]');
    process.exitCode = 1;
    return;
  }
  try {
    console.log(repositorySessionActor({ cwd, runtime, fresh: flags.has('--new') }));
  } catch (error) {
    console.error(`Could not establish the session actor: ${error.message}`);
    process.exitCode = 1;
  }
}

function hash() {
  const path = positionalAfter('hash', { skipOptionValues: new Set(['--rev']) });
  const rev = optionValue('--rev');
  if (!path) {
    console.error('Usage: sdlc hash <file> [--rev <commit>]');
    process.exitCode = 1;
    return;
  }
  try {
    if (!rev) {
      console.log(formatFingerprint(fingerprintFile(path)));
      return;
    }
    const primary = resolvePrimaryCheckout(cwd);
    const requestedPath = resolve(cwd, path);
    let absolutePath = requestedPath;
    try {
      absolutePath = realpathSync(requestedPath);
    } catch {
      // The path may not exist in the working tree (for example, deleted since
      // <rev>); fall back to the resolved literal so a historical read can still succeed.
    }
    const relativePath = relative(primary, absolutePath).split(sep).join('/');
    const commit = git(['-C', primary, 'rev-parse', '--verify', `${rev}^{commit}`]);
    if (!commit) {
      console.error(`Could not hash ${path}: revision '${rev}' does not resolve to a commit.`);
      process.exitCode = 1;
      return;
    }
    const result = spawnSync('git', ['show', `${commit}:${relativePath}`], { cwd: primary, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      console.error(`Could not hash ${path}: no such path '${relativePath}' at ${rev} (${commit}).`);
      process.exitCode = 1;
      return;
    }
    console.log(formatFingerprint(fingerprintContent(result.stdout)));
  } catch (error) {
    console.error(`Could not hash ${path}: ${error.message}`);
    process.exitCode = 1;
  }
}

// Scalars render bare; arrays and objects render as compact JSON, so a
// dotted-key line stays exactly one line regardless of the value's shape.
function formatSettingValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatSetting(setting) {
  return `${setting.key}=${formatSettingValue(setting.value)} (${setting.source})`;
}

function configCommand() {
  const field = optionValue('--field');
  if (args.includes('--field') && !field) {
    console.error('Usage: sdlc config [--json] [--field <dotted.path>]');
    process.exitCode = 1;
    return;
  }
  const projectConfig = readProjectConfig(cwd);
  if (projectConfig.errors.length) {
    for (const error of projectConfig.errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  const settings = effectiveSettings(projectConfig);
  if (field) {
    const setting = settings.find((entry) => entry.key === field);
    if (!setting) {
      console.error(`Unknown configuration field '${field}'. See docs/configuration.md for the supported keys.`);
      process.exitCode = 1;
      return;
    }
    console.log(flags.has('--json') ? JSON.stringify({ value: setting.value, source: setting.source }) : formatSetting(setting));
    return;
  }
  console.log(flags.has('--json') ? JSON.stringify(configProjection(projectConfig), null, 2) : settings.map(formatSetting).join('\n'));
}

function doctor() {
  const number = positionalAfter('doctor');
  if (!number || !/^\d+$/.test(number)) {
    console.error('Usage: sdlc doctor <NNN> [--json]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = inspectDoctor(number, { cwd });
    console.log(flags.has('--json') ? JSON.stringify(result, null, 2) : formatDoctor(result));
    process.exitCode = doctorExitCode(result);
  } catch (error) {
    console.error(`Doctor failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function snapshot() {
  const view = optionValue('--view');
  if (!['next', 'queue'].includes(view)) {
    console.error('Usage: sdlc snapshot --view=next|queue --json');
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(inspectSnapshot(view, { cwd })));
  } catch (error) {
    console.error(`Snapshot failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function guard() {
  const commandIndex = args.indexOf('guard');
  const stage = args.slice(commandIndex + 1).find((argument) => !argument.startsWith('-'));
  const stageIndex = args.indexOf(stage, commandIndex + 1);
  const number = args.slice(stageIndex + 1).find((argument) => !argument.startsWith('-'));
  if (!stage || !number || !/^\d+$/.test(number)) {
    console.error('Usage: sdlc guard <plan|approve|implement|review|land> <NNN>');
    process.exitCode = 1;
    return;
  }
  try {
    const result = inspectGuard(stage, number, { cwd });
    console.log(flags.has('--json') ? JSON.stringify(result, null, 2) : formatGuard(result));
    process.exitCode = guardExitCode(result);
  } catch (error) {
    console.error(`Guard failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function resume() {
  const number = positionalAfter('resume', { skipOptionValues: new Set(['--runtime']) });
  if (!number || !/^\d+$/.test(number)) {
    console.error('Usage: sdlc resume <NNN> [--runtime <name>] [--json]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = runResume(number, { cwd, runtime: optionValue('--runtime') || process.env.SDLC_RUNTIME || 'agent' });
    console.log(flags.has('--json') ? JSON.stringify(result, null, 2) : formatResume(result));
    process.exitCode = resumeExitCode(result);
  } catch (error) {
    console.error(`Resume failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function gates() {
  const gateCwd = optionValue('--cwd') || cwd;
  const target = optionValue('--target');
  const adHocCommands = optionValues('--command');
  if ((args.includes('--cwd') && !optionValue('--cwd')) || (args.includes('--target') && !target) || (args.includes('--command') && !adHocCommands.length)) {
    console.error('Usage: sdlc gates [--cwd <dir>] [--target <t>] [--command <cmd>]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runGates({ cwd: gateCwd, target, adHocCommands });
    console.log(formatGateRun(result));
    process.exitCode = gateExitCode(result);
  } catch (error) {
    console.error(`Gates refused: ${error.message}`);
    process.exitCode = 1;
  }
}

function reviewPacket() {
  const number = positionalAfter('review-packet', { skipOptionValues: new Set(['--reviewer', '--base', '--head']) });
  if (!number || !/^\d+$/.test(number)) {
    console.error('Usage: sdlc review-packet <NNN> [--reviewer <name>] [--base <revision>] [--head <revision>] [--json]');
    process.exitCode = 1;
    return;
  }
  try {
    const packets = createReviewPackets(number, {
      cwd,
      base: optionValue('--base') || 'main',
      head: optionValue('--head') || 'HEAD',
      reviewerNames: optionValues('--reviewer'),
    });
    console.log(flags.has('--json') ? JSON.stringify(packets) : packets.map(formatReviewPacket).join('\n---\n\n'));
  } catch (error) {
    console.error(`Review packet failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function reviewArtifactUsage() {
  console.error('Usage: sdlc review-artifact --template <NNN> --round <n> [--reviewers a,b,c] [--base <revision>] [--head <revision>]');
  console.error('       sdlc review-artifact --validate <path> [--json]');
  process.exitCode = 1;
}

function reviewArtifact() {
  const templateNumber = optionValue('--template');
  const validatePath = optionValue('--validate');
  if (Boolean(templateNumber) === Boolean(validatePath)) return reviewArtifactUsage();
  if (templateNumber) return reviewArtifactTemplate(templateNumber);
  return reviewArtifactValidate(validatePath);
}

function reviewArtifactTemplate(number) {
  const round = optionValue('--round');
  if (!/^\d+$/.test(number) || !round || !/^[1-9]\d*$/.test(round)) return reviewArtifactUsage();
  const normalized = number.padStart(3, '0');
  try {
    const head = optionValue('--head') || 'HEAD';
    const reviewedCodeSha = git(['rev-parse', '--verify', `${head}^{commit}`]);
    if (!reviewedCodeSha) {
      console.error(`Could not resolve a reviewed code HEAD from '${head}'.`);
      process.exitCode = 1;
      return;
    }
    // Identity comes from doctor so the template cannot disagree with the gate.
    const diagnosis = inspectDoctor(normalized, { cwd });
    const choreLane = !diagnosis.plan;
    const approvedPlanSha256 = choreLane ? CHORE_LANE_SENTINEL : diagnosis.plan.sha256;
    const approvedPlanCommit = choreLane ? CHORE_LANE_SENTINEL : diagnosis.plan.approvedCommit;
    if (!approvedPlanSha256 || !approvedPlanCommit) {
      console.error(`Approved plan identity for ${normalized} is unavailable (doctor state=${diagnosis.state}); the template will not invent it.`);
      if (diagnosis.errors?.[0]) console.error(`  ${diagnosis.errors[0]}`);
      process.exitCode = 1;
      return;
    }
    const declared = optionValue('--reviewers');
    const reviewers = declared
      ? parseReviewerList(declared)
      : reviewerNamesFor({ cwd, base: optionValue('--base') || 'main', head });
    console.log(renderReviewTemplate({
      number: normalized,
      round: Number(round),
      reviewedCodeSha,
      approvedPlanSha256,
      approvedPlanCommit,
      reviewers,
    }));
  } catch (error) {
    console.error(`Review template failed: ${error.message}`);
    process.exitCode = 1;
  }
}

// Round n reconciles against round n-1, so validation reads the sibling artifact
// rather than trusting the round under test to describe its own history.
function previousRoundArtifact(path) {
  const parsed = reviewArtifactRound(path);
  if (!parsed || parsed.round <= 1) return undefined;
  const sibling = join(dirname(path), `${parsed.number}-round${parsed.round - 1}.md`);
  return existsSync(sibling) ? parseReviewArtifact(readFileSync(sibling, 'utf8')) : undefined;
}

function reviewArtifactValidate(path) {
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) {
    console.error(`Review artifact not found: ${path}`);
    process.exitCode = 1;
    return;
  }
  const relativePath = relative(cwd, absolute).split(sep).join('/');
  const displayPath = !relativePath || relativePath.startsWith('..') ? absolute : relativePath;
  const previous = previousRoundArtifact(absolute);
  const parsed = parseReviewArtifact(readFileSync(absolute, 'utf8'), { previous });
  const convergence = reviewConvergence(previous, parsed);
  if (flags.has('--json')) {
    console.log(JSON.stringify({
      path: displayPath,
      valid: parsed.valid,
      version: parsed.version,
      number: parsed.number ?? null,
      round: parsed.round ?? null,
      verdict: parsed.verdict?.value ?? null,
      reviewers: parsed.reviewers ?? [],
      previousRound: previous ? previous.round ?? null : null,
      convergence,
      diagnostics: parsed.diagnostics,
      warnings: parsed.warnings ?? [],
    }, null, 2));
  } else {
    const lines = [`${displayPath}: ${parsed.valid ? 'valid' : 'invalid'} (${parsed.version}${parsed.round ? `, round ${parsed.round}` : ''})`];
    if (parsed.verdict) lines.push(`verdict: ${parsed.verdict.value}`);
    lines.push(`convergence: ${convergence.action}${convergence.reason ? ` (${convergence.reason})` : ''}`);
    for (const warning of parsed.warnings ?? []) lines.push(`warning: ${warning}`);
    // Every failure, each with its line — one pass fixes the whole artifact.
    for (const diagnostic of parsed.diagnostics) lines.push(`${displayPath}:${diagnostic.line ?? '?'}: ${diagnostic.message}`);
    console.log(lines.join('\n'));
  }
  process.exitCode = parsed.valid ? 0 : 1;
}

async function review() {
  const reviewArgs = args.slice(args.indexOf('review') + 1);
  let number;
  for (let index = 0; index < reviewArgs.length; index += 1) {
    if (reviewArgs[index] === '--port') {
      index += 1;
      continue;
    }
    if (!reviewArgs[index].startsWith('-')) {
      number = reviewArgs[index];
      break;
    }
  }
  if (!number || !/^\d+$/.test(number)) {
    console.error('Usage: sdlc review <NNN> [--editor] [--artifact] [--diff] [--preview] [--port <number>]');
    process.exitCode = 1;
    return;
  }

  const normalizedNumber = number.padStart(3, '0');
  const diagnosis = inspectDoctor(normalizedNumber, { cwd });
  const ambiguousPlan = diagnosis.errors?.some((error) => error.includes('Expected at most one applicable plan'));
  if (!diagnosis.plan?.path || ambiguousPlan) {
    console.error(`Could not resolve exactly one applicable plan for ${normalizedNumber} in the canonical primary checkout.`);
    if (diagnosis.errors?.[0]) console.error(`Doctor state: ${diagnosis.state} — ${diagnosis.errors[0]}`);
    process.exitCode = 1;
    return;
  }

  const primary = diagnosis.primaryCheckout || cwd;
  const planFile = basename(diagnosis.plan.path);
  const planName = planFile.replace(/\.md$/, '');
  const worktree = diagnosis.worktree?.path;
  if (!worktree || !existsSync(worktree)) {
    console.error(`No Beads-visible worktree found for ${planName}. Expected .worktrees/${planName}.`);
    console.error(`Doctor state: ${diagnosis.state}${diagnosis.errors[0] ? ` — ${diagnosis.errors[0]}` : ''}`);
    process.exitCode = 1;
    return;
  }

  const artifact = latestReviewArtifact(worktree, normalizedNumber);
  const sha = git(['-C', worktree, 'rev-parse', '--short', 'HEAD']);
  const base = git(['-C', worktree, 'merge-base', 'main', 'HEAD']);
  const baseSha = base ? git(['-C', worktree, 'rev-parse', '--short', base]) : undefined;
  const stat = git(['-C', worktree, 'diff', '--stat', 'main...HEAD']) ?? 'unavailable (main is not comparable)';
  const dirty = git(['-C', worktree, 'status', '--short']);

  console.log(`\n${c('1', planName)}`);
  console.log(`Worktree: ${worktree}`);
  console.log(`Branch: ${planName}${sha ? ` @ ${sha}` : ''}`);
  console.log(`Base: ${baseSha ? `main @ ${baseSha}` : 'unavailable'}`);
  console.log(`\nTicket: ${diagnosis.ticket?.path ? join(primary, diagnosis.ticket.path) : 'not found'}`);
  console.log(`Plan: ${join(primary, diagnosis.plan.path)}`);
  console.log(`Approved plan: ${diagnosis.plan?.approvedCommit ? `${diagnosis.plan.sha256} @ ${diagnosis.plan.approvedCommit}` : 'not reproducibly approved'}`);
  console.log(`Doctor: ${diagnosis.state}${diagnosis.errors[0] ? ` — ${diagnosis.errors[0]}` : ''}`);
  console.log(`Automated review: ${artifact ? verdictFrom(artifact) ?? 'invalid review verdict' : 'not found'}`);
  console.log(`Artifact: ${artifact ?? 'not found'}`);
  console.log(`Worktree status: ${dirty ? 'dirty' : 'clean'}`);
  console.log(`\nChanged:\n${stat}`);
  console.log(`\nInspect: git -C ${JSON.stringify(worktree)} diff main...HEAD`);

  const config = readProjectConfig(primary);
  const editor = config.reviewEditor;
  const preview = config.localPreview;
  const previewUrl = config.previewUrl;

  if (flags.has('--editor')) {
    if (!editor) console.error('\nNo local.reviewEditor is configured in .agents/sdlc.json or .agents/sdlc.local.json.');
    else {
      const command = substitute(editor, { worktree, port: '' });
      const result = spawnSync(command, { cwd: worktree, shell: true, stdio: 'inherit' });
      if (result.error || result.status !== 0) console.error(`Could not launch review editor: ${command}`);
    }
  }

  if (flags.has('--artifact')) {
    if (!artifact) console.error('\nNo review artifact exists yet. Run /sdlc-implement first.');
    else if (openPath(artifact).error) console.error(`Could not open ${artifact}`);
  }

  if (flags.has('--diff')) {
    const result = spawnSync('git', ['-C', worktree, 'diff', 'main...HEAD'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) console.error('Could not show the diff against main.');
  }

  if (flags.has('--preview')) {
    if (!preview || !previewUrl) {
      console.error('\nLocal preview is not configured. Set local.preview.command and local.preview.url in .agents/sdlc.json or .agents/sdlc.local.json.');
    } else {
      const portFlag = args.indexOf('--port');
      const requestedPort = portFlag >= 0 ? Number(args[portFlag + 1]) : 4173;
      if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
        console.error('Preview port must be an integer between 1 and 65535.');
        process.exitCode = 1;
        return;
      }
      let port;
      try {
        port = await availablePort(requestedPort);
      } catch (error) {
        if (error?.code === 'EADDRINUSE') {
          console.error(`Preview port ${requestedPort} is already in use; choose one with --port <number>.`);
        } else {
          console.error(`Could not verify preview port ${requestedPort}${error?.code ? ` (${error.code})` : ''}.`);
        }
        process.exitCode = 1;
        return;
      }
      const command = substitute(preview, { worktree, port });
      const child = spawn(command, { cwd: worktree, shell: true, detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`\nPreview started (PID ${child.pid}): ${substitute(previewUrl, { worktree, port })}`);
    }
  }
}

// Symlink CLAUDE.md → AGENTS.md (relative). Falls back to a copy where symlinks are unavailable.
function linkClaudeMd(dir, label) {
  const link = join(dir, 'CLAUDE.md');
  if (existsSync(link) || (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink())) {
    const st = lstatSync(link);
    if (st.isSymbolicLink()) skip(`${label}/CLAUDE.md symlink exists`);
    else warn(`${label}/CLAUDE.md exists as a regular file — leaving it; consider merging it into AGENTS.md and symlinking`);
    return;
  }
  try {
    symlinkSync('AGENTS.md', link);
    ok(`${label}/CLAUDE.md → AGENTS.md symlink`);
  } catch {
    cpSync(join(dir, 'AGENTS.md'), link);
    warn(`${label}/CLAUDE.md created as a copy (symlinks unavailable on this system)`);
  }
}

function linkSkill(claudeSkillsDir, agentsSkillsDir, name) {
  const link = join(claudeSkillsDir, name);
  const target = join(agentsSkillsDir, name);
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing && !force) {
    skip(`${name} exists (use --force to overwrite)`);
    return;
  }
  if (existing) rmSync(link, { recursive: true, force: true });
  // Relative link so the pair survives the project being moved or checked out elsewhere.
  const rel = relative(claudeSkillsDir, target);
  try {
    symlinkSync(rel, link);
    ok(`${name} → ${rel}`);
  } catch {
    cpSync(target, link, { recursive: true, force: true });
    warn(`${name} copied (symlinks unavailable on this system)`);
  }
}

function copyIfMissing(src, dest, label) {
  if (existsSync(dest) && !force) {
    skip(`${label} exists (use --force to overwrite)`);
    return;
  }
  cpSync(src, dest);
  ok(label);
}

function copyIfAbsent(src, dest, label) {
  if (existsSync(dest)) {
    skip(`${label} exists`);
    return;
  }
  cpSync(src, dest);
  ok(label);
}

function installManagedFile(src, dest, label) {
  const source = readFileSync(src);
  if (existsSync(dest) && readFileSync(dest).equals(source)) {
    skip(`${label} is current`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, source);
  ok(existsSync(dest) ? `${label} installed/updated` : label);
}

// `.agents/sdlc.local.json` is machine-scoped and never committed. Creates
// `.gitignore` when absent; otherwise appends the entry only when no
// existing line already ignores the path (exact trimmed match against both
// the bare and the `/`-prefixed forms), so reruns never duplicate it
// (AC-008, AA-006). The two generated schema files are deliberately left out
// - they are useful committed.
function ensureLocalConfigIgnored(root) {
  const entry = '.agents/sdlc.local.json';
  const gitignorePath = join(root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`);
    ok('.gitignore (created, ignoring .agents/sdlc.local.json)');
    return;
  }
  const contents = readFileSync(gitignorePath, 'utf8');
  const alreadyIgnored = contents.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === entry || trimmed === `/${entry}`;
  });
  if (alreadyIgnored) {
    skip('.gitignore already ignores .agents/sdlc.local.json');
    return;
  }
  const separator = contents.length && !contents.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${contents}${separator}${entry}\n`);
  ok('.gitignore (added .agents/sdlc.local.json)');
}

function frontmatterValue(frontmatter, key) {
  const line = frontmatter.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}:`));
  if (!line) return undefined;

  const value = line.slice(key.length + 1).trim();
  if (!value) return undefined;
  return value.startsWith('"') ? JSON.parse(value) : value.replace(/^'|'$/g, '');
}

function renderCodexAgent(source) {
  const contents = readFileSync(source, 'utf8');
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`Reviewer template is missing frontmatter: ${source}`);

  const name = frontmatterValue(match[1], 'name');
  const description = frontmatterValue(match[1], 'description');
  if (!name || !description) throw new Error(`Reviewer template is missing name or description: ${source}`);

  const body = contents
    .slice(match[0].length)
    .trim()
    .replaceAll('.claude/skills/', '.agents/skills/')
    .replaceAll('frontend-code-reviewer sub-agent', 'frontend-code-reviewer Codex custom agent');
  const developerInstructions = [
    '## Codex operating constraints',
    '',
    'This is a read-only agent. Use only available read and terminal tools for inspection. Do not edit, stage, or commit files, and do not run commands that mutate the repository, worktree, or beads.',
    '',
    body,
  ].join('\n');

  return [
    `name = ${JSON.stringify(name)}`,
    `description = ${JSON.stringify(description)}`,
    ...(CODEX_AGENT_MODELS[name] ? [`model = ${JSON.stringify(CODEX_AGENT_MODELS[name])}`] : []),
    ...(CODEX_AGENT_REASONING_EFFORTS[name] ? [`model_reasoning_effort = ${JSON.stringify(CODEX_AGENT_REASONING_EFFORTS[name])}`] : []),
    'sandbox_mode = "read-only"',
    `developer_instructions = ${JSON.stringify(developerInstructions)}`,
    '',
  ].join('\n');
}

function renderPiAgent(source) {
  const contents = readFileSync(source, 'utf8');
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`Reviewer template is missing frontmatter: ${source}`);

  const name = frontmatterValue(match[1], 'name');
  const description = frontmatterValue(match[1], 'description');
  if (!name || !description) throw new Error(`Reviewer template is missing name or description: ${source}`);

  const body = contents
    .slice(match[0].length)
    .trim()
    .replaceAll('.claude/skills/', '.agents/skills/')
    .replaceAll('frontend-code-reviewer sub-agent', 'frontend-code-reviewer Pi subagent');
  const instructions = [
    '## Pi operating constraints',
    '',
    'This is a read-only reviewer. Use tools only for inspection and diagnostics. Do not edit, stage, or commit files, and do not run commands that mutate the repository, worktree, or Beads.',
    '',
    body,
  ].join('\n');

  return [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    'tools: read, grep, find, ls, bash',
    'inheritProjectContext: true',
    'inheritSkills: true',
    'completionGuard: false',
    '---',
    '',
    instructions,
    '',
  ].join('\n');
}

function setup() {
  const legacyLabels = detectLegacyConfigSection(cwd);
  if (legacyLabels.length) {
    console.error('\nCannot set up the pipeline: thoughts/AGENTS.md still carries a legacy "## Project Configuration" section.');
    console.error(`  Move these settings to .agents/sdlc.json (see template/sdlc.template.json), then delete the section: ${legacyLabels.join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  let beadsInstallation;
  if (!flags.has('--skip-beads')) {
    beadsInstallation = inspectBeadsInstallation({ cwd });
    if (!beadsInstallation.coreCapabilitiesValid) {
      console.error('\nCannot set up the Beads-backed workflow:');
      for (const error of beadsInstallation.errors) console.error(`  - ${error}`);
      console.error('Install or upgrade Beads, or pass --skip-beads to scaffold files without enabling workflow transitions.');
      process.exitCode = 1;
      return;
    }
  }

  console.log(c('1', '\nSetting up the sdlc pipeline in ') + cwd);

  head('git');
  if (existsSync(join(cwd, '.git'))) {
    skip('already a git repository');
  } else {
    const r = spawnSync('git', ['init'], { cwd, stdio: 'pipe' });
    if (r.status === 0) ok('git init (the pipeline uses worktrees and branches)');
    else warn('git init failed — run it yourself; the pipeline requires git');
  }

  head('.agents/');
  mkdirSync(join(cwd, '.agents'), { recursive: true });
  // `copyIfAbsent`, not `copyIfMissing`: a project's configuration is never
  // overwritten, even under --force (AC-002, AC-012).
  copyIfAbsent(join(pkgRoot, 'template', 'sdlc.template.json'), join(cwd, '.agents', 'sdlc.json'), '.agents/sdlc.json (project configuration)');
  // These two are generated, never user-owned, so they always refresh.
  installManagedFile(join(pkgRoot, 'template', 'sdlc.schema.json'), join(cwd, '.agents', 'sdlc.schema.json'), '.agents/sdlc.schema.json (generated JSON Schema)');
  installManagedFile(join(pkgRoot, 'template', 'sdlc.local.schema.json'), join(cwd, '.agents', 'sdlc.local.schema.json'), '.agents/sdlc.local.schema.json (generated JSON Schema)');
  ensureLocalConfigIgnored(cwd);

  head('thoughts/');
  for (const d of THOUGHTS_SUBDIRS) {
    const p = join(cwd, 'thoughts', d);
    if (existsSync(p)) skip(`thoughts/${d}/ exists`);
    else {
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, '.gitkeep'), '');
      ok(`thoughts/${d}/`);
    }
  }
  copyIfMissing(join(pkgRoot, 'template', 'thoughts', 'AGENTS.md'), join(cwd, 'thoughts', 'AGENTS.md'), 'thoughts/AGENTS.md (pipeline instructions)');
  copyIfAbsent(join(pkgRoot, 'template', 'thoughts', 'docs', 'INDEX.md'), join(cwd, 'thoughts', 'docs', 'INDEX.md'), 'thoughts/docs/INDEX.md (documentation index)');
  linkClaudeMd(join(cwd, 'thoughts'), 'thoughts');

  head('root instructions');
  const rootAgents = join(cwd, 'AGENTS.md');
  const rootClaude = join(cwd, 'CLAUDE.md');
  if (!existsSync(rootAgents) && existsSync(rootClaude) && lstatSync(rootClaude).isFile()) {
    // Adopt an existing CLAUDE.md as the canonical AGENTS.md, then symlink back.
    renameSync(rootClaude, rootAgents);
    ok('moved existing CLAUDE.md → AGENTS.md (canonical file)');
  }
  copyIfMissing(join(pkgRoot, 'template', 'AGENTS.root.md'), rootAgents, 'AGENTS.md (root agent instructions)');
  linkClaudeMd(cwd, '.');

  if (!flags.has('--skip-skills')) {
    // Skills live canonically in .agents/skills/ for every target. The Claude
    // target additionally symlinks each skill into .claude/skills/ so Claude and
    // Codex share one copy on disk.
    const agentsSkillsDir = join(cwd, '.agents', 'skills');
    const skillNames = readdirSync(SKILLS_DIR);

    head('skills → .agents/skills/');
    for (const name of skillNames) {
      const src = join(SKILLS_DIR, name);
      const dest = join(agentsSkillsDir, name);
      if (existsSync(dest) && !force) {
        skip(`${name} exists (use --force to overwrite)`);
        continue;
      }
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true, force: true });
      ok(name);
    }

    const legacySkills = LEGACY_SKILL_NAMES.filter((name) =>
      existsSync(join(agentsSkillsDir, name)) || existsSync(join(cwd, '.claude', 'skills', name)),
    );
    if (legacySkills.length) {
      warn(`legacy unprefixed skill directories detected: ${legacySkills.join(', ')}; verify they belong to sdlc, then remove them to avoid native-command collisions`);
    }

    if (installClaude) {
      head('skills → .claude/skills/ (symlinked to .agents/skills/)');
      const claudeSkillsDir = join(cwd, '.claude', 'skills');
      mkdirSync(claudeSkillsDir, { recursive: true });
      for (const name of skillNames) {
        linkSkill(claudeSkillsDir, agentsSkillsDir, name);
      }
    }
  }

  if (!flags.has('--skip-agents')) {
    const agentsDir = join(pkgRoot, 'template', 'agents');
    const agentFiles = readdirSync(agentsDir).filter((file) => file.endsWith('.md'));

    if (installClaude) {
      head('agents → .claude/agents/');
      mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
      for (const file of agentFiles) {
        const dest = join(cwd, '.claude', 'agents', file);
        if (existsSync(dest) && !force) {
          skip(`${file} exists (use --force to overwrite)`);
          continue;
        }
        cpSync(join(agentsDir, file), dest);
        ok(file.replace(/\.md$/, ''));
      }
    }

    if (installCodex) {
      head('agents → .codex/agents/');
      mkdirSync(join(cwd, '.codex', 'agents'), { recursive: true });
      for (const file of agentFiles) {
        const name = file.replace(/\.md$/, '');
        const dest = join(cwd, '.codex', 'agents', `${name}.toml`);
        if (existsSync(dest) && !force) {
          skip(`${name} exists (use --force to overwrite)`);
          continue;
        }
        writeFileSync(dest, renderCodexAgent(join(agentsDir, file)));
        ok(name);
      }
    }

    if (installPi) {
      head('agents → .pi/agents/ (pi-subagents)');
      mkdirSync(join(cwd, '.pi', 'agents'), { recursive: true });
      for (const file of agentFiles) {
        const dest = join(cwd, '.pi', 'agents', file);
        if (existsSync(dest) && !force) {
          skip(`${file} exists (use --force to overwrite)`);
          continue;
        }
        writeFileSync(dest, renderPiAgent(join(agentsDir, file)));
        ok(file.replace(/\.md$/, ''));
      }
    }
  }

  if (!flags.has('--skip-beads')) {
    head('beads');
    ok(`bd ${beadsInstallation.version} (required native capabilities present)`);
    if (existsSync(join(cwd, '.beads'))) {
      skip('.beads/ exists');
    } else {
      const r = spawnSync('bd', ['init'], {
        cwd,
        env: { ...process.env, BEADS_ACTOR: createSessionActor({ runtime: 'setup', sessionId: null, existingActor: null, fresh: true }) },
        stdio: 'inherit',
      });
      if (r.status === 0) ok('bd init');
      else {
        console.error('  Beads initialization failed; setup is incomplete.');
        process.exitCode = 1;
        return;
      }
    }
    installManagedFile(join(pkgRoot, 'template', 'beads', 'PRIME.md'), join(cwd, '.beads', 'PRIME.md'), '.beads/PRIME.md (minimal project prime)');
  }

  console.log(`
${c('1', 'Done. Next steps:')}
  1. Edit ${c('1', '.agents/sdlc.json')} (targets, quality gates, reviewers, product docs;
     see docs/configuration.md, or run ${c('1', 'sdlc config')})
  2. Drop your product/context docs into thoughts/docs/
  3. In your agent: ${c('1', '/sdlc-ticket <your first idea>')}

Pipeline: /sdlc-ticket → approve by hand → /sdlc-plan → /sdlc-approve → /sdlc-implement → /sdlc-land
Dashboard: /sdlc-queue    Autonomous: /loop /sdlc-next    Small fixes: /sdlc-chore
`);
}

if (command === 'setup') setup();
else if (command === 'config') configCommand();
else if (command === 'actor') actor();
else if (command === 'hash') hash();
else if (command === 'doctor') doctor();
else if (command === 'snapshot') snapshot();
else if (command === 'guard') guard();
else if (command === 'resume') resume();
else if (command === 'gates') await gates();
else if (command === 'review-packet') reviewPacket();
else if (command === 'review-artifact') reviewArtifact();
else if (command === 'review') await review();
else help();
