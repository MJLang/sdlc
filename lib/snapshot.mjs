import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { issueMetadata } from './beads.mjs';
import { createDoctorInspectionContext, gateBlockedId, inspectDoctor, issueId, issueStatus, pathMatchesScope } from './doctor.mjs';

export const SNAPSHOT_SCHEMA = 'sdlc.snapshot.v1';
export const SNAPSHOT_FRESHNESS_MS = 30_000;

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.trim() : '';
}

function activeNumbers(primary) {
  const numbers = new Set();
  for (const directory of ['tickets', 'plans']) {
    const path = join(primary, 'thoughts', directory);
    if (!existsSync(path)) continue;
    for (const file of readdirSync(path)) {
      const number = file.match(/^(\d+)-.+\.md$/)?.[1];
      if (number) numbers.add(number.padStart(3, '0'));
    }
  }
  return [...numbers].sort((left, right) => Number(left) - Number(right) || left.localeCompare(right));
}

function staticPrefix(scope) {
  return String(scope ?? '').replace(/^`|`$/g, '').replace(/^\.\//, '').split(/[?*]/, 1)[0].replace(/\/$/, '');
}

export function declaredScopeOverlap(left, right) {
  const a = String(left ?? '').replace(/^`|`$/g, '').replace(/^\.\//, '');
  const b = String(right ?? '').replace(/^`|`$/g, '').replace(/^\.\//, '');
  if (!a || !b) return false;
  if (pathMatchesScope(a, b) || pathMatchesScope(b, a)) return true;
  const aPrefix = staticPrefix(a);
  const bPrefix = staticPrefix(b);
  return Boolean(aPrefix && bPrefix && (aPrefix === bPrefix || aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`)));
}

function overlapEvidence(candidate, diagnoses) {
  const ownScopes = candidate.inspection?.plan?.activeSteps.flatMap((step) => step.files ?? []) ?? [];
  for (const other of diagnoses) {
    if (other.number === candidate.number || !other.plan) continue;
    const otherInspection = other.inspection;
    const inFlight = Boolean(other.worktree)
      || issueStatus(otherInspection?.epic) === 'in_progress'
      || (otherInspection?.children ?? []).some((child) => issueStatus(child) === 'in_progress');
    if (!inFlight) continue;
    const otherScopes = otherInspection?.plan?.activeSteps.flatMap((step) => step.files ?? []) ?? [];
    for (const left of ownScopes) {
      for (const right of otherScopes) {
        if (declaredScopeOverlap(left, right)) return { plan: other.number, path: left === right ? left : `${left}<->${right}` };
      }
    }
  }
  return null;
}

function warningCode(message) {
  if (/degraded health/i.test(message)) return 'degraded-health';
  if (/uncommitted changes/i.test(message)) return 'worktree-dirty';
  if (/unpushed commit/i.test(message)) return 'unpushed-commits';
  if (/stash/i.test(message)) return 'worktree-stashes';
  if (/merge slot is held/i.test(message)) return 'merge-slot-held';
  if (/candidate stale/i.test(message)) return 'stale-unconfirmed';
  if (/snapshot differs/i.test(message)) return 'artifact-snapshot-skew';
  if (/no matching epic approval note/i.test(message)) return 'review-note-missing';
  return 'diagnostic-warning';
}

function recoveryFor(diagnosis) {
  if (diagnosis.state === 'ready_for_approval' || diagnosis.state === 'reapproval_required') return `/sdlc-approve ${diagnosis.number}`;
  if (diagnosis.state === 'legacy') return `migrate ${diagnosis.number} explicitly, then rerun doctor`;
  return diagnosis.errors[0] ?? `sdlc doctor ${diagnosis.number} --json`;
}

function implementCandidate(diagnosis, diagnoses, actor) {
  const inspection = diagnosis.inspection;
  const children = inspection?.children ?? [];
  const openChildren = children.filter((child) => !['closed', 'cancelled'].includes(issueStatus(child)));
  const readyIds = new Set(inspection?.context?.native?.ready?.data?.map(issueId).filter(Boolean) ?? []);
  const blockedIds = new Set(inspection?.context?.native?.gates?.data?.map(gateBlockedId).filter(Boolean) ?? []);
  const ready = openChildren.map(issueId).filter((id) => readyIds.has(id) && !blockedIds.has(id)).sort();
  const epic = inspection?.epic;
  const owner = epic?.assignee ?? null;
  const foreignClaim = issueStatus(epic) === 'in_progress' && owner && owner !== actor;
  const staleCorroborated = Boolean(diagnosis.beads?.staleClaim)
    && diagnosis.errors.some((error) => /stale in-progress.*corroborated/i.test(error));
  const overlap = overlapEvidence(diagnosis, diagnoses);
  const reasons = [];

  if (!diagnosis.beads?.capabilitiesValid || !diagnosis.beads?.healthValid) reasons.push('unhealthy');
  if (foreignClaim) reasons.push('foreign-claim');
  if (diagnosis.beads?.orphans?.length) reasons.push('orphan-recovery');
  if (staleCorroborated) reasons.push('stale-candidate');
  if (diagnosis.beads?.escalations?.length) reasons.push('human-escalation');
  if (overlap) reasons.push(`file-overlap:${overlap.path}`);
  if (diagnosis.state === 'reapproval_required') reasons.push('reapproval-required');
  else if (diagnosis.state === 'legacy') reasons.push('legacy');
  if (!openChildren.length) reasons.push(diagnosis.review?.valid && /^APPROVED/.test(diagnosis.review.verdict ?? '') ? 'review-approved' : 'implementation-complete');
  else if (!ready.length) reasons.push(diagnosis.beads?.openGates?.length ? 'gated' : 'no-ready-work');
  if (diagnosis.state !== 'healthy' && !reasons.length) reasons.push('unhealthy');
  const rejectionCodes = [...new Set(reasons)];

  return compact({
    number: diagnosis.number,
    transition: 'implement',
    eligible: rejectionCodes.length === 0,
    reasons: rejectionCodes,
    ticket: diagnosis.ticket?.path,
    plan: diagnosis.plan?.path,
    planSha256: diagnosis.plan?.sha256,
    approvalCommit: diagnosis.plan?.approvedCommit,
    epic: diagnosis.beads?.epic?.id,
    owner,
    ready,
    overlap,
    warnings: [...new Set(diagnosis.warnings.map(warningCode))].sort(),
  });
}

function planningCandidate(diagnosis) {
  const reasons = diagnosis.state === 'ready_for_planning' ? [] : [diagnosis.state === 'legacy' ? 'legacy' : 'not-ready-for-planning'];
  return compact({
    number: diagnosis.number,
    transition: 'plan',
    eligible: reasons.length === 0,
    reasons,
    ticket: diagnosis.ticket?.path,
    ticketSha256: diagnosis.ticket?.sha256,
    warnings: [...new Set(diagnosis.warnings.map(warningCode))].sort(),
  });
}

function humanEntries(diagnosis) {
  const entries = [];
  if (diagnosis.ticket?.status === 'draft') entries.push({ number: diagnosis.number, code: 'ticket-approval', action: `set ${diagnosis.ticket.path} Status to approved` });
  if (diagnosis.state === 'ready_for_approval') entries.push({ number: diagnosis.number, code: 'approval', action: `/sdlc-approve ${diagnosis.number}` });
  if (diagnosis.state === 'reapproval_required') entries.push({ number: diagnosis.number, code: 'reapproval', action: `/sdlc-approve ${diagnosis.number}` });
  if (diagnosis.state === 'legacy') entries.push({ number: diagnosis.number, code: 'legacy', action: recoveryFor(diagnosis) });
  if (diagnosis.review?.valid && /^APPROVED/.test(diagnosis.review.verdict ?? '')) entries.push({ number: diagnosis.number, code: 'land', action: `/sdlc-land ${diagnosis.number}` });
  for (const gate of diagnosis.beads?.openGates ?? []) {
    entries.push({
      number: diagnosis.number,
      code: 'gate',
      gate: gate.id,
      blocked: gate.blocks,
      reason: gate.reason,
      action: `BEADS_ACTOR="<new-session-actor>" bd gate resolve ${gate.id} --reason="<resolution>"`,
    });
  }
  for (const escalation of diagnosis.beads?.escalations ?? []) entries.push({ number: diagnosis.number, code: 'human-escalation', issue: escalation.id, action: 'resolve the recorded escalation explicitly' });
  if (diagnosis.beads?.orphans?.length) entries.push({ number: diagnosis.number, code: 'orphan-recovery', action: 'verify the issue-bearing commit and gates before an explicit close' });
  if (diagnosis.beads?.staleClaim && diagnosis.errors.some((error) => /stale in-progress.*corroborated/i.test(error))) {
    entries.push({ number: diagnosis.number, code: 'stale-candidate', issue: diagnosis.beads.staleClaim.id, action: `BEADS_ACTOR="<new-session-actor>" bd update ${diagnosis.beads.staleClaim.id} --status=open --assignee="" --append-notes="claim recovery: <evidence>"` });
  }
  if (diagnosis.mergeSlot?.holder) entries.push({ number: diagnosis.number, code: 'merge-slot-held', holder: diagnosis.mergeSlot.holder, ageSeconds: diagnosis.mergeSlot.ageSeconds, action: 'prove primary main clean before authorized stale-holder recovery' });
  if (diagnosis.state === 'blocked' && !entries.length) {
    entries.push({ number: diagnosis.number, code: 'blocked', action: recoveryFor(diagnosis) });
  }
  return entries.map(compact);
}

function inFlightEntry(diagnosis) {
  if (!diagnosis.plan) {
    const context = diagnosis.inspection?.context;
    const issue = context?.native?.inProgress?.data?.find((candidate) => issueMetadata(candidate).sdlc_ticket === diagnosis.ticket?.path);
    if (!issue) return null;
    const registered = context.native?.worktrees?.data?.find((worktree) => {
      const branch = String(worktree.branch ?? worktree.branch_name ?? '').replace(/^refs\/heads\//, '');
      return branch.startsWith(`${diagnosis.number}-c-`);
    });
    let worktree;
    if (registered) {
      const path = registered.path ?? registered.worktree;
      const worktreePath = resolve(context.primary, path);
      const branch = String(registered.branch ?? registered.branch_name ?? '').replace(/^refs\/heads\//, '');
      worktree = compact({
        path: worktreePath,
        branch,
        head: git(worktreePath, ['rev-parse', 'HEAD']),
        dirty: Boolean(git(worktreePath, ['status', '--short'])),
        lastCommitAt: Number(git(worktreePath, ['log', '-1', '--format=%ct'])) || undefined,
      });
    }
    return compact({
      number: diagnosis.number,
      kind: 'chore',
      ticket: diagnosis.ticket?.path,
      state: diagnosis.state,
      issue: issueId(issue),
      owner: issue.assignee,
      worktree,
    });
  }
  const children = diagnosis.inspection?.children ?? [];
  const closed = children.filter((child) => issueStatus(child) === 'closed').length;
  const inFlight = Boolean(diagnosis.worktree)
    || issueStatus(diagnosis.inspection?.epic) === 'in_progress'
    || children.some((child) => issueStatus(child) === 'in_progress');
  if (!inFlight) return null;
  return compact({
    number: diagnosis.number,
    plan: diagnosis.plan.path,
    state: diagnosis.state,
    progress: `${closed}/${children.length}`,
    owner: diagnosis.beads?.epic?.assignee,
    worktree: diagnosis.worktree ? compact({
      path: diagnosis.worktree.path,
      branch: diagnosis.worktree.branch,
      head: diagnosis.worktree.head,
      dirty: diagnosis.worktree.dirty,
      unpushed: diagnosis.worktree.unpushed,
      stashes: diagnosis.worktree.stashes,
      lastCommitAt: diagnosis.worktree.lastCommitAt,
    }) : undefined,
  });
}

function recentLandings(primary) {
  const output = git(primary, ['log', '-5', '--format=%H%x09%ct%x09%s', 'main']);
  if (!output) return [];
  return output.split('\n').map((line) => {
    const [commit, timestamp, ...subject] = line.split('\t');
    const title = subject.join('\t');
    const number = title.match(/\(ticket[ \t]+(\d+)\)/i)?.[1];
    return number ? { number: number.padStart(3, '0'), commit, committedAt: Number(timestamp), title } : null;
  }).filter(Boolean);
}

function compact(value) {
  if (Array.isArray(value)) {
    const array = value.map(compact).filter((item) => item !== undefined);
    return array.length ? array : undefined;
  }
  if (value && typeof value === 'object') {
    const object = {};
    for (const [key, child] of Object.entries(value)) {
      const clean = compact(child);
      if (clean !== undefined && clean !== null && clean !== '') object[key] = clean;
    }
    return Object.keys(object).length ? object : undefined;
  }
  return value === undefined || value === null || value === '' ? undefined : value;
}

function fingerprintState(context, diagnoses) {
  const projection = {
    head: context.head,
    errors: context.errors ?? [],
    mode: context.config?.mode,
    ready: context.native?.ready?.data?.map(issueId).filter(Boolean).sort() ?? [],
    inProgress: context.native?.inProgress?.data?.map(issueId).filter(Boolean).sort() ?? [],
    gates: context.native?.gates?.data?.map(issueId).filter(Boolean).sort() ?? [],
    diagnoses: diagnoses.map((item) => [item.number, item.state, item.plan?.sha256, item.worktree?.head]),
  };
  return `sha256=${createHash('sha256').update(JSON.stringify(projection)).digest('hex')}`;
}

export function buildSnapshot({ view, context, diagnoses, actor = null, now = context.now ?? Date.now() }) {
  if (!['next', 'queue'].includes(view)) throw new TypeError('Snapshot view must be next or queue.');
  const implement = diagnoses.filter((diagnosis) => diagnosis.plan?.status === 'approved').map((diagnosis) => implementCandidate(diagnosis, diagnoses, actor));
  const plan = diagnoses.filter((diagnosis) => !diagnosis.plan && diagnosis.ticket?.status === 'approved').map(planningCandidate);
  const candidates = [...implement, ...plan];
  const humanQueue = diagnoses.flatMap(humanEntries).sort((left, right) => Number(left.number) - Number(right.number) || left.code.localeCompare(right.code));
  const base = {
    schema: SNAPSHOT_SCHEMA,
    view,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SNAPSHOT_FRESHNESS_MS).toISOString(),
    head: context.head,
    state: fingerprintState(context, diagnoses),
    beads: compact({
      version: context.installation?.version,
      mode: context.config?.mode,
      capabilitiesValid: context.installation?.coreCapabilitiesValid !== false,
      healthValid: !(context.errors?.length),
      errors: context.errors,
      warnings: context.warnings,
      mergeSlot: context.native?.mergeSlot?.data,
    }),
  };
  if (view === 'next') {
    return compact({
      ...base,
      candidates,
      selected: candidates.find((candidate) => candidate.eligible),
      humanQueue,
    });
  }
  return compact({
    ...base,
    sections: {
      needsYou: humanQueue,
      inFlight: diagnoses.map(inFlightEntry).filter(Boolean),
      ready: candidates.filter((candidate) => candidate.eligible),
      drafts: diagnoses.filter((diagnosis) => diagnosis.ticket?.status === 'draft').map((diagnosis) => ({ number: diagnosis.number, ticket: diagnosis.ticket.path })),
      recentlyLanded: recentLandings(context.primary),
    },
  });
}

export function inspectSnapshot(view, {
  cwd = process.cwd(),
  beadsExecutable = 'bd',
  beadsRunner,
  actor = process.env.BEADS_ACTOR ?? null,
  now = Date.now(),
  inspectionContext,
} = {}) {
  if (!['next', 'queue'].includes(view)) throw new TypeError('Snapshot view must be next or queue.');
  const context = inspectionContext ?? createDoctorInspectionContext({ cwd, beadsExecutable, beadsRunner, now, includeInProgress: true });
  if (!context.primary) throw new Error(context.errors[0] ?? 'Repository inspection is unavailable.');
  const diagnoses = activeNumbers(context.primary).map((number) => inspectDoctor(number, { inspectionContext: context, now }));
  return buildSnapshot({ view, context, diagnoses, actor, now });
}
