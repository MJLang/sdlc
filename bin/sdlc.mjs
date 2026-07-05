#!/usr/bin/env node
/**
 * @mlangroman/sdlc — project bootstrapper for the ticket → plan → implement → land pipeline.
 *
 * Usage:
 *   npx @mlangroman/sdlc setup [--force] [--skip-skills] [--skip-beads]
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

const SKILLS_DIR = join(pkgRoot, 'skills');
const THOUGHTS_SUBDIRS = ['tickets', 'plans', 'designs', 'docs', 'reviews'];

function help() {
  console.log(`
${c('1', '@mlangroman/sdlc')} — ticket → plan → implement → land pipeline for agentic development

Usage:
  npx @mlangroman/sdlc setup [options]     Set up the pipeline in the current directory

Options:
  --force, -f      Overwrite existing thoughts/AGENTS.md, root AGENTS.md, skills, and agents
  --skip-skills    Do not install skills into .claude/skills/
  --skip-agents    Do not install reviewer agents into .claude/agents/
  --skip-beads     Do not run bd init

What setup does:
  1. git init (if not already a repository)
  2. Creates thoughts/{${THOUGHTS_SUBDIRS.join(',')}} + thoughts/AGENTS.md (+ CLAUDE.md symlink)
  3. Creates a root AGENTS.md (if missing) and a root CLAUDE.md → AGENTS.md symlink
  4. Installs the pipeline skills into .claude/skills/
  5. Installs the reviewer agents (backend/frontend-code-reviewer) into .claude/agents/
  6. Initializes beads (bd init), if bd is installed

Skills can also be installed on their own, for any supported agent, via the skills CLI:
  npx skills add MJLang/sdlc
`);
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
    head('skills → .claude/skills/');
    for (const name of readdirSync(SKILLS_DIR)) {
      const src = join(SKILLS_DIR, name);
      const dest = join(cwd, '.claude', 'skills', name);
      if (existsSync(dest) && !force) {
        skip(`${name} exists (use --force to overwrite)`);
        continue;
      }
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true, force: true });
      ok(name);
    }
    console.log(`    ${c('90', 'other agents (cursor, codex, …): npx skills add MJLang/sdlc')}`);
  }

  if (!flags.has('--skip-agents')) {
    head('reviewer agents → .claude/agents/');
    const agentsDir = join(pkgRoot, 'template', 'agents');
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    for (const file of readdirSync(agentsDir)) {
      const dest = join(cwd, '.claude', 'agents', file);
      if (existsSync(dest) && !force) {
        skip(`${file} exists (use --force to overwrite)`);
        continue;
      }
      cpSync(join(agentsDir, file), dest);
      ok(file.replace(/\.md$/, ''));
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
else help();
