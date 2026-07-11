#!/usr/bin/env node
/**
 * @mlangroman/sdlc — project bootstrapper for the ticket → plan → implement → land pipeline.
 *
 * Usage:
 *   npx @mlangroman/sdlc setup [--claude|--codex] [--force] [--skip-skills] [--skip-beads]
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

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
const installClaude = flags.has('--claude') || !flags.has('--codex');
const installCodex = flags.has('--codex');

const SKILLS_DIR = join(pkgRoot, 'skills');
const THOUGHTS_SUBDIRS = ['tickets', 'plans', 'designs', 'docs', 'reviews'];
const CODEX_AGENT_MODELS = {
  // Code review benefits from the frontier model's deeper reasoning.
  'backend-code-reviewer': 'gpt-5.6',
  'frontend-code-reviewer': 'gpt-5.6',
  'general-code-reviewer': 'gpt-5.6',
  // This role is mechanical fact gathering, so use the cost-sensitive tier.
  'pipeline-snapshot': 'gpt-5.6-luna',
};
const CODEX_AGENT_REASONING_EFFORTS = {
  'backend-code-reviewer': 'high',
  'frontend-code-reviewer': 'high',
  'general-code-reviewer': 'high',
  'pipeline-snapshot': 'medium',
};

function help() {
  console.log(`
${c('1', '@mlangroman/sdlc')} — ticket → plan → implement → land pipeline for agentic development

Usage:
  npx @mlangroman/sdlc setup [options]     Set up the pipeline in the current directory
  sdlc review <NNN> [options]               Prepare a plan worktree for local human review

Options:
  --force, -f      Overwrite existing thoughts/AGENTS.md, root AGENTS.md, skills, and agents
  --claude         Install skills and bundled agents for Claude Code (default)
  --codex          Install skills and bundled agents for Codex
  --skip-skills    Do not install skills
  --skip-agents    Do not install bundled agents
  --skip-beads     Do not run bd init

Review options:
  --editor         Open the configured review editor
  --artifact       Open the latest persisted automated-review artifact
  --diff           Show the branch diff against main
  --preview        Start the configured local preview in the background
  --port <number>  Port to use for --preview (when the preview command uses {port})

What setup does:
  1. git init (if not already a repository)
  2. Creates thoughts/{${THOUGHTS_SUBDIRS.join(',')}} + thoughts/AGENTS.md (+ CLAUDE.md symlink)
  3. Creates a root AGENTS.md (if missing) and a root CLAUDE.md → AGENTS.md symlink
  4. Installs pipeline skills into .claude/skills/ (Claude) or .agents/skills/ (Codex)
  5. Installs three code reviewers plus pipeline-snapshot into .claude/agents/ (Claude) or .codex/agents/ (Codex)
  6. Initializes beads (bd init), if bd is installed

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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function configCommand(config, label) {
  const prefix = `^-\\s*\\*\\*${escapeRegex(label)}:\\*\\*\\s*`;
  const match = config.match(new RegExp(`${prefix}\\\`([^\\\`]+)\\\``, 'm'));
  return match?.[1].trim();
}

function substitute(value, variables) {
  return value.replace(/\{(worktree|port)\}/g, (_, key) => String(variables[key]));
}

function findWorktree(branch) {
  const output = git(['worktree', 'list', '--porcelain']);
  if (!output) return undefined;

  let current;
  for (const line of `${output}\n`.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch refs/heads/') && current) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (!line && current) {
      if (current.branch === branch) return current.path;
      current = undefined;
    }
  }
  return undefined;
}

function findPlan(number) {
  const plansDir = join(cwd, 'thoughts', 'plans');
  if (!existsSync(plansDir)) return undefined;
  const matches = readdirSync(plansDir)
    .filter((file) => new RegExp(`^${escapeRegex(number)}-[^.]+\\.md$`).test(file))
    .sort();
  if (matches.length !== 1) return undefined;
  return matches[0];
}

function findTicket(number) {
  const ticketsDir = join(cwd, 'thoughts', 'tickets');
  if (!existsSync(ticketsDir)) return undefined;
  return readdirSync(ticketsDir)
    .filter((file) => new RegExp(`^${escapeRegex(number)}-[^.]+\\.md$`).test(file))
    .sort()[0];
}

function latestReviewArtifact(worktree, number) {
  const reviewsDir = join(worktree, 'thoughts', 'reviews');
  if (!existsSync(reviewsDir)) return undefined;
  const matches = readdirSync(reviewsDir)
    .filter((file) => new RegExp(`^${escapeRegex(number)}-round\\d+\\.md$`).test(file))
    .sort((a, b) => {
      const round = (file) => Number(file.match(/-round(\d+)\.md$/)?.[1] ?? 0);
      return round(a) - round(b);
    });
  return matches.length ? join(reviewsDir, matches.at(-1)) : undefined;
}

const VALID_REVIEW_VERDICT = /^(?:APPROVED(?: — [1-9]\d* NIT)?|BLOCKED — [1-9]\d* MUST FIX)$/;

function aggregateVerdict(componentVerdicts) {
  let mustFix = 0;
  let nits = 0;

  for (const verdict of componentVerdicts) {
    if (!VALID_REVIEW_VERDICT.test(verdict)) return undefined;
    const blocked = verdict.match(/^BLOCKED — ([1-9]\d*) MUST FIX$/);
    const approvedWithNits = verdict.match(/^APPROVED — ([1-9]\d*) NIT$/);
    if (blocked) mustFix += Number(blocked[1]);
    else if (approvedWithNits) nits += Number(approvedWithNits[1]);
  }

  if (mustFix) return `BLOCKED — ${mustFix} MUST FIX`;
  if (nits) return `APPROVED — ${nits} NIT`;
  return 'APPROVED';
}

function verdictFrom(artifact) {
  if (!artifact) return undefined;
  const contents = readFileSync(artifact, 'utf8').replace(/\r\n/g, '\n');
  const overallSections = [...contents.matchAll(/^## Overall[ \t]*$/gm)];

  if (overallSections.length) {
    const marker = overallSections.at(-1);
    const componentSection = contents.slice(0, marker.index);
    const section = contents.slice(marker.index + marker[0].length);
    const verdicts = section.match(/^Verdict:[ \t]*(.+)[ \t]*$/gm) ?? [];
    if (verdicts.length !== 1) return undefined;

    const overallVerdict = verdicts[0].replace(/^Verdict:[ \t]*/, '').trim();
    if (!VALID_REVIEW_VERDICT.test(overallVerdict)) return undefined;

    const firstComponentHeading = componentSection.search(/^##[ \t]+/m);
    const header = firstComponentHeading >= 0 ? componentSection.slice(0, firstComponentHeading) : componentSection;
    const reviewedSha = header.match(/^Reviewed code SHA:[ \t]*([0-9a-f]{7,64})[ \t]*$/m)?.[1];
    const reviewerList = header.match(/^Reviewers:[ \t]*(.+)[ \t]*$/m)?.[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    if (!reviewedSha || !reviewerList?.length || new Set(reviewerList).size !== reviewerList.length) return undefined;

    const componentLines = componentSection.match(/^Verdict:[ \t]*(.+)[ \t]*$/gm) ?? [];
    if (componentLines.length !== reviewerList.length) return undefined;
    const componentVerdicts = componentLines.map((line) => line.replace(/^Verdict:[ \t]*/, '').trim());
    return aggregateVerdict(componentVerdicts) === overallVerdict ? overallVerdict : undefined;
  }

  // Backward compatibility for pre-aggregation artifacts.
  const verdicts = contents.match(/^Verdict:[ \t]*(.+)[ \t]*$/gm);
  const verdict = verdicts?.at(-1)?.replace(/^Verdict:[ \t]*/, '').trim();
  return verdict && VALID_REVIEW_VERDICT.test(verdict) ? verdict : undefined;
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
  const planFile = findPlan(normalizedNumber);
  if (!planFile) {
    console.error(`Could not resolve exactly one plan for ${normalizedNumber} in thoughts/plans/.`);
    process.exitCode = 1;
    return;
  }

  const planName = planFile.replace(/\.md$/, '');
  const worktree = findWorktree(planName);
  if (!worktree || !existsSync(worktree)) {
    console.error(`No registered worktree found for ${planName}. Expected .worktrees/${planName}.`);
    process.exitCode = 1;
    return;
  }

  const ticketFile = findTicket(normalizedNumber);
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
  console.log(`\nTicket: ${ticketFile ? join(cwd, 'thoughts', 'tickets', ticketFile) : 'not found'}`);
  console.log(`Plan: ${join(cwd, 'thoughts', 'plans', planFile)}`);
  console.log(`Automated review: ${artifact ? verdictFrom(artifact) ?? 'invalid review verdict' : 'not found'}`);
  console.log(`Artifact: ${artifact ?? 'not found'}`);
  console.log(`Worktree status: ${dirty ? 'dirty' : 'clean'}`);
  console.log(`\nChanged:\n${stat}`);
  console.log(`\nInspect: git -C ${JSON.stringify(worktree)} diff main...HEAD`);

  const configPath = join(cwd, 'thoughts', 'AGENTS.md');
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const editor = configCommand(config, 'Review editor');
  const preview = configCommand(config, 'Local preview');
  const previewUrl = configCommand(config, 'Preview URL');

  if (flags.has('--editor')) {
    if (!editor) console.error('\nNo Review editor is configured in thoughts/AGENTS.md.');
    else {
      const command = substitute(editor, { worktree, port: '' });
      const result = spawnSync(command, { cwd: worktree, shell: true, stdio: 'inherit' });
      if (result.error || result.status !== 0) console.error(`Could not launch review editor: ${command}`);
    }
  }

  if (flags.has('--artifact')) {
    if (!artifact) console.error('\nNo review artifact exists yet. Run /implement first.');
    else if (openPath(artifact).error) console.error(`Could not open ${artifact}`);
  }

  if (flags.has('--diff')) {
    const result = spawnSync('git', ['-C', worktree, 'diff', 'main...HEAD'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) console.error('Could not show the diff against main.');
  }

  if (flags.has('--preview')) {
    if (!preview || !previewUrl) {
      console.error('\nLocal preview is not configured. Add Local preview and Preview URL to thoughts/AGENTS.md.');
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

function copyIfMissing(src, dest, label) {
  if (existsSync(dest) && !force) {
    skip(`${label} exists (use --force to overwrite)`);
    return;
  }
  cpSync(src, dest);
  ok(label);
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

function setup() {
  console.log(c('1', '\nSetting up the sdlc pipeline in ') + cwd);

  head('git');
  if (existsSync(join(cwd, '.git'))) {
    skip('already a git repository');
  } else {
    const r = spawnSync('git', ['init'], { cwd, stdio: 'pipe' });
    if (r.status === 0) ok('git init (the pipeline uses worktrees and branches)');
    else warn('git init failed — run it yourself; the pipeline requires git');
  }

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
    const skillTargets = [
      ...(installClaude ? [{ label: 'skills → .claude/skills/', dir: join(cwd, '.claude', 'skills') }] : []),
      ...(installCodex ? [{ label: 'skills → .agents/skills/', dir: join(cwd, '.agents', 'skills') }] : []),
    ];
    for (const target of skillTargets) {
      head(target.label);
      for (const name of readdirSync(SKILLS_DIR)) {
        const src = join(SKILLS_DIR, name);
        const dest = join(target.dir, name);
        if (existsSync(dest) && !force) {
          skip(`${name} exists (use --force to overwrite)`);
          continue;
        }
        mkdirSync(dest, { recursive: true });
        cpSync(src, dest, { recursive: true, force: true });
        ok(name);
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
  }

  if (!flags.has('--skip-beads')) {
    head('beads');
    const bd = spawnSync('bd', ['--version'], { stdio: 'pipe' });
    if (bd.error || bd.status !== 0) {
      warn('bd (beads) not found — install it from https://github.com/gastownhall/beads, then run: bd init');
    } else if (existsSync(join(cwd, '.beads'))) {
      skip('.beads/ exists');
    } else {
      const r = spawnSync('bd', ['init'], { cwd, stdio: 'inherit' });
      if (r.status === 0) ok('bd init');
      else warn('bd init failed — run it yourself');
    }
  }

  console.log(`
${c('1', 'Done. Next steps:')}
  1. Edit the ${c('1', 'Project Configuration')} section in thoughts/AGENTS.md
     (targets, quality gates, reviewers, product docs)
  2. Drop your product/context docs into thoughts/docs/
  3. In your agent: ${c('1', '/ticket <your first idea>')}

Pipeline: /ticket → approve by hand → /plan → /approve → /implement → /land
Dashboard: /queue    Autonomous: /loop /next    Small fixes: /chore
`);
}

if (command === 'setup') setup();
else if (command === 'review') await review();
else help();
