import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function gitResult(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const message = result.stderr?.trim() || result.error?.message || `git ${args.join(' ')} failed`;
    throw new Error(message);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function git(cwd, args, options) {
  const result = gitResult(cwd, args, options);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolvePrimary(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const list = git(top, ['worktree', 'list', '--porcelain']);
  const primary = list?.match(/^worktree (.+)$/m)?.[1];
  return resolve(primary || top);
}

export function gitWorkingTreeState(path, fallbackBranch) {
  if (!path || !existsSync(path)) return null;
  const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
  const head = git(path, ['rev-parse', 'HEAD'], { allowFailure: true });
  const dirty = Boolean(git(path, ['status', '--short'], { allowFailure: true }));
  const stashes = git(path, ['stash', 'list'], { allowFailure: true })?.split('\n').filter(Boolean).length ?? 0;
  const upstream = git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
  const publicationBaseline = upstream || (git(path, ['rev-parse', '--verify', 'main'], { allowFailure: true }) ? 'main' : null);
  const unpushed = publicationBaseline ? Number(git(path, ['rev-list', '--count', `${publicationBaseline}..HEAD`], { allowFailure: true }) ?? 0) : null;
  const lastCommitAt = Number(git(path, ['log', '-1', '--format=%ct'], { allowFailure: true })) || null;
  return { branch: branch || fallbackBranch, head, dirty, stashes, upstream: upstream || null, publicationBaseline, unpushed, lastCommitAt };
}

function findRegistered(worktrees, primary, conventional, planName) {
  const byConvention = worktrees.find((entry) => resolve(primary, entry.path ?? entry.worktree ?? '') === conventional);
  if (byConvention) return byConvention;
  return worktrees.find((entry) => {
    const branch = String(entry.branch ?? entry.branch_name ?? '').replace(/^refs\/heads\//, '');
    const path = resolve(primary, entry.path ?? entry.worktree ?? '');
    return branch === planName && path !== primary;
  });
}

export function resolveWorkingTree(plan, { primary, worktrees = [], cwd } = {}) {
  const planPath = typeof plan === 'string' ? plan : plan?.path;
  const planName = basename(planPath, '.md');
  const root = primary || resolvePrimary(cwd ?? process.cwd());
  const conventional = join(root, '.worktrees', planName);

  const registered = findRegistered(worktrees, root, conventional, planName);
  const registeredPath = registered ? resolve(root, registered.path ?? registered.worktree ?? '') : null;
  const mode = registered && existsSync(registeredPath) ? 'worktree' : 'branch';
  const path = mode === 'worktree' ? registeredPath : root;
  const beadsState = registered ? (registered.beads_state ?? registered.beadsState ?? registered.state ?? null) : null;
  const git = gitWorkingTreeState(path, planName);

  return {
    mode,
    path,
    planName,
    onPlanBranch: git?.branch === planName,
    registered: registered ?? null,
    beadsState,
    git,
  };
}
