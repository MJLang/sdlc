import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parsePlan } from './artifacts.mjs';
import { createBeadsAdapter, repositorySessionActor } from './beads.mjs';
import { createDoctorInspectionContext, issueId, issueStatus } from './doctor.mjs';
import { resolveWorkingTree } from './working-tree.mjs';

function posixPath(path) {
  return path.split(sep).join('/');
}

function gitLines(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return (result.stdout ?? '').split('\n').filter(Boolean);
}

function capLines(lines, limit = 20) {
  if (lines.length <= limit) return lines.join('\n');
  return [...lines.slice(0, limit), `… and ${lines.length - limit} more`].join('\n');
}

function mergeSlotAge(data, now) {
  const updatedAt = data.updated_at ?? data.updatedAt ?? null;
  const millis = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isNaN(millis) ? null : Math.max(0, Math.floor((now - millis) / 1000));
}

function findApplicablePlan(primary, number) {
  const directory = join(primary, 'thoughts', 'plans');
  if (!existsSync(directory)) return { plan: null, error: `No applicable plan exists for ${number}.` };
  const files = readdirSync(directory).filter((file) => new RegExp(`^${number}-.+\\.md$`).test(file)).sort();
  const candidates = [];
  for (const file of files) {
    const path = join(directory, file);
    const relativePath = posixPath(relative(primary, path));
    const parsed = parsePlan(readFileSync(path, 'utf8'), { path: relativePath });
    if (!['merged', 'cancelled'].includes(parsed.status)) candidates.push(parsed);
  }
  if (!candidates.length) return { plan: null, error: `No applicable plan exists for ${number}.` };
  if (candidates.length > 1) {
    return { plan: null, error: `Multiple applicable plans exist for ${number}: ${candidates.map((entry) => entry.path).join(', ')}.` };
  }
  const [plan] = candidates;
  if (!plan.beadsEpic) return { plan: null, error: `Plan ${plan.path} has no Beads Epic mapping.` };
  return { plan, error: null };
}

/**
 * Pure precondition check: resolves the plan, working tree and merge-slot
 * state and reports every failing precondition. Mutates nothing.
 */
export function inspectResume(number, { cwd = process.cwd(), actor, inspectionContext, now = Date.now() } = {}) {
  const normalizedNumber = String(number).padStart(3, '0');
  const shared = inspectionContext ?? createDoctorInspectionContext({ cwd, now });
  if (!shared.primary) {
    return { number: normalizedNumber, ok: false, errors: [{ code: 'plan-unresolved', detail: `Git repository could not be resolved: ${shared.errors[0] ?? 'unknown error'}` }] };
  }
  const primary = shared.primary;
  const resolvedActor = actor ?? process.env.BEADS_ACTOR ?? null;
  const errors = [];

  const { plan, error: planError } = findApplicablePlan(primary, normalizedNumber);
  if (planError) errors.push({ code: 'plan-unresolved', detail: planError });

  let workingTree = null;
  if (plan) {
    workingTree = resolveWorkingTree(plan, { primary, worktrees: shared.native?.worktrees?.data ?? [], cwd });
    if (!workingTree.git) {
      errors.push({ code: 'worktree-dirty', detail: `Working tree at ${workingTree.path} could not be inspected.` });
    } else {
      if (workingTree.git.dirty) {
        const detail = capLines(gitLines(workingTree.path, ['status', '--short']));
        errors.push({ code: 'worktree-dirty', detail: `Working tree at ${workingTree.path} has uncommitted changes:\n${detail}` });
      }
      const unpushed = workingTree.git.unpushed ?? 0;
      if (unpushed > 0) {
        const baseline = workingTree.git.publicationBaseline;
        const detail = capLines(gitLines(workingTree.path, ['log', '--oneline', `${baseline}..HEAD`]));
        errors.push({ code: 'unpushed-commits', detail: `Working tree at ${workingTree.path} has ${unpushed} unpushed commit${unpushed === 1 ? '' : 's'} ahead of ${baseline}:\n${detail}` });
      }
    }
  }

  const mergeSlotData = shared.native?.mergeSlot?.data ?? null;
  const holder = mergeSlotData?.holder ?? mergeSlotData?.metadata?.holder ?? null;
  if (holder && holder !== resolvedActor) {
    const age = mergeSlotAge(mergeSlotData, now);
    errors.push({ code: 'merge-slot-held', detail: `Merge slot is held by ${holder}${age === null ? '' : ` (age ${age}s)`}.` });
  }

  if (errors.length) return { number: normalizedNumber, ok: false, errors };

  let epicId = plan.beadsEpic;
  let priorActor = null;
  let children = [];
  if (shared.adapter) {
    const epic = shared.adapter.showIssue(plan.beadsEpic);
    epicId = issueId(epic) ?? plan.beadsEpic;
    priorActor = epic?.assignee ?? null;
    children = shared.adapter.listChildren(plan.beadsEpic)
      .filter((child) => issueStatus(child) === 'in_progress')
      .map((child) => ({ id: issueId(child), assignee: child.assignee ?? null }))
      .filter((child) => child.id);
  }

  return {
    number: normalizedNumber,
    ok: true,
    errors: [],
    primary,
    plan: { path: plan.path, beadsEpic: plan.beadsEpic },
    epic: { id: epicId, assignee: priorActor },
    children,
    workingTree: { path: workingTree.path, mode: workingTree.mode },
  };
}

/**
 * Adopts the plan epic under a fresh actor once every precondition passes.
 * `sdlc resume` is not a repair tool: it never touches gates, escalations,
 * issue status beyond claim adoption, the merge slot, or Git.
 */
export function runResume(number, {
  cwd = process.cwd(),
  runtime = process.env.SDLC_RUNTIME || 'agent',
  actor,
  inspectionContext,
  now = Date.now(),
  beadsExecutable = 'bd',
  beadsRunner,
} = {}) {
  const context = inspectionContext ?? createDoctorInspectionContext({ cwd, now, beadsExecutable, beadsRunner });
  const inspection = inspectResume(number, { cwd, actor, inspectionContext: context, now });
  if (!inspection.ok) return inspection;

  const newActor = repositorySessionActor({ cwd: inspection.primary, runtime, fresh: true });
  const adapter = createBeadsAdapter({
    cwd: inspection.primary,
    actor: newActor,
    executable: beadsExecutable,
    ...(beadsRunner ? { runner: beadsRunner } : {}),
  });

  const priorActor = inspection.epic.assignee;
  try {
    adapter.claim(inspection.epic.id);
  } catch {
    // bd update --claim does not adopt an issue held by a different actor
    // (verified empirically); fall back to an explicit reassignment.
    adapter.mutateJson(['update', inspection.epic.id, '--assignee', newActor, '--status', 'in_progress']);
  }

  const resetChildIds = [];
  for (const child of inspection.children) {
    if (child.assignee === newActor) continue;
    adapter.mutateJson(['update', child.id, '--status', 'open', '--assignee', '']);
    resetChildIds.push(child.id);
  }

  const adoptedAt = new Date(now).toISOString();
  adapter.appendNote(inspection.epic.id, `resume: adopted from ${priorActor ?? '<none>'} at ${adoptedAt}; tree clean, 0 unpushed`);

  return {
    number: inspection.number,
    ok: true,
    errors: [],
    epic: inspection.epic.id,
    newActor,
    priorActor: priorActor ?? '<none>',
    resetChildIds,
    workingTree: inspection.workingTree,
  };
}

export function resumeExitCode(result) {
  return result.ok ? 0 : 3;
}

export function formatResume(result) {
  if (result.ok) {
    const lines = [`resume ${result.number}: epic ${result.epic} adopted by ${result.newActor} (was ${result.priorActor})`];
    if (result.resetChildIds.length) lines.push(`reset ${result.resetChildIds.length} orphaned child claim${result.resetChildIds.length === 1 ? '' : 's'}: ${result.resetChildIds.join(', ')}`);
    return lines.join('\n');
  }
  const lines = [`REFUSED resume ${result.number}`];
  for (const error of result.errors) lines.push(`error (${error.code}): ${error.detail}`);
  return lines.join('\n');
}
