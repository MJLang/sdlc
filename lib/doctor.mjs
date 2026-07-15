import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parsePlan, parseTicket } from './artifacts.mjs';
import { collectNativeDiagnostics, createBeadsAdapter, inspectBeadsInstallation, issueMetadata } from './beads.mjs';
import { readProjectConfig } from './config.mjs';
import { fingerprintContent, fingerprintFile } from './fingerprint.mjs';
import { parseReviewArtifact } from './review-artifact.mjs';

export const DOCTOR_EXIT_CODES = Object.freeze({
  healthy: 0,
  ready_for_approval: 0,
  ready_for_planning: 0,
  reapproval_required: 2,
  legacy: 2,
  blocked: 3,
});

function posixPath(path) {
  return path.split(sep).join('/');
}

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

export function resolvePrimaryCheckout(cwd = process.cwd()) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const worktrees = git(top, ['worktree', 'list', '--porcelain']);
  const primary = worktrees?.match(/^worktree (.+)$/m)?.[1];
  return resolve(primary || top);
}

function artifactCandidates(root, directory, number) {
  const path = join(root, 'thoughts', directory);
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((file) => new RegExp(`^${number}-.+\\.md$`).test(file))
    .sort()
    .map((file) => join(path, file));
}

function applicablePlanCandidates(paths, ticket) {
  const parsed = paths.map((path) => ({ path, parsed: parsePlan(readFileSync(path, 'utf8'), { path }) }));
  const active = parsed.filter(({ parsed: plan }) => !['merged', 'cancelled'].includes(plan.status));
  if (active.length) return active;
  if (ticket?.status === 'implemented') return parsed.filter(({ parsed: plan }) => plan.status === 'merged');
  if (ticket?.status === 'cancelled') return parsed.filter(({ parsed: plan }) => plan.status === 'cancelled');
  return [];
}

function latestReviewFiles(worktree, number) {
  const directory = join(worktree, 'thoughts', 'reviews');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((file) => ({ file, round: Number(file.match(new RegExp(`^${number}-round(\\d+)\\.md$`))?.[1]) }))
    .filter(({ round }) => Number.isInteger(round) && round > 0)
    .sort((left, right) => left.round - right.round)
    .map(({ file, round }) => ({ path: join(directory, file), round }));
}

export function parseApprovalRecords(notes) {
  const text = typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.join('\n') : '';
  const lines = text.split(/\r?\n/).filter((line) => /\bapproval\s*:/i.test(line));
  const records = [];
  const malformed = [];
  for (const line of lines) {
    const match = line.trim().match(/^approval:[ \t]*plan-sha256=([0-9a-f]{64})[ \t]+ticket-sha256=([0-9a-f]{64})[ \t]+commit=([0-9a-f]{7,64})$/);
    if (!match) malformed.push(line.trim());
    else records.push({ planSha256: match[1], ticketSha256: match[2], commit: match[3], line: line.trim() });
  }
  return { records, malformed };
}

export function parseReviewApprovalRecords(notes) {
  const text = typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.join('\n') : '';
  const records = [];
  const malformed = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!/\breview\s*:[ \t]*APPROVED\b/.test(line)) continue;
    const match = line.trim().match(/^review:[ \t]*APPROVED[ \t]+sha=([0-9a-f]{7,64})[ \t]+code-sha=([0-9a-f]{7,64})[ \t]+plan-sha256=([0-9a-f]{64}|N\/A)[ \t]+plan-commit=([0-9a-f]{7,64}|N\/A)[ \t]+rounds=([1-9]\d*)$/);
    if (!match) malformed.push(line.trim());
    else records.push({ artifactSha: match[1], codeSha: match[2], planSha256: match[3], planCommit: match[4], rounds: Number(match[5]), line: line.trim(), index });
  }
  return { records, malformed };
}

export function parseRebaseRecords(notes) {
  const text = typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.join('\n') : '';
  const records = [];
  const malformed = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!/\brebased\s*:/i.test(line)) continue;
    const match = line.trim().match(/^rebased:[ \t]*([0-9a-f]{7,64})[ \t]*(?:->|→)[ \t]*([0-9a-f]{7,64})[ \t]+gates=pass$/);
    if (!match) malformed.push(line.trim());
    else records.push({ oldSha: match[1], newSha: match[2], line: line.trim(), index });
  }
  return { records, malformed };
}

export function parseWaiverRecords(notes) {
  const text = typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.join('\n') : '';
  const records = [];
  const malformed = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/\bwaiver\s*:/i.test(line)) continue;
    const match = line.trim().match(/^waiver:[ \t]*id[ \t]*=[ \t]*((?:AC|PC)-\d{3})[ \t]*;[ \t]*reason[ \t]*=[ \t]*(.+)$/i);
    const reason = match?.[2]?.trim();
    if (!match || !reason || /^(?:none|n\/a|tbd|todo)$/i.test(reason) || /[<>]/.test(reason)) malformed.push(line.trim());
    else records.push({ id: match[1].toUpperCase(), reason, line: line.trim() });
  }
  return { records, malformed };
}

function issueNotes(issue) {
  const value = issue?.notes ?? issue?.note ?? '';
  if (Array.isArray(value)) return value.map((note) => typeof note === 'string' ? note : note?.text ?? note?.body ?? '').join('\n');
  return String(value ?? '');
}

function commitFile(root, commit, path) {
  const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

function resolveCommit(root, revision) {
  if (!revision || revision === 'N/A') return null;
  const result = gitResult(root, ['rev-parse', '--verify', `${revision}^{commit}`], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function commitsMatch(root, left, right) {
  const leftCommit = resolveCommit(root, left);
  const rightCommit = resolveCommit(root, right);
  return Boolean(leftCommit && rightCommit && leftCommit === rightCommit);
}

function reviewHeadBinding(root, artifactSha, branchHead, records) {
  const start = resolveCommit(root, artifactSha);
  const target = resolveCommit(root, branchHead);
  if (!start) return { valid: false, hops: [], reason: `Review artifact commit ${artifactSha || '<missing>'} does not resolve.` };
  if (!target) return { valid: false, hops: [], reason: 'Current review branch HEAD does not resolve.' };
  if (start === target) return { valid: true, hops: [] };

  const normalized = records.map((record) => ({
    ...record,
    oldCommit: resolveCommit(root, record.oldSha),
    newCommit: resolveCommit(root, record.newSha),
  }));
  const visited = new Set([start]);
  const hops = [];
  let current = start;
  let cursor = -1;
  while (current !== target) {
    const nextIndex = normalized.findIndex((record, index) => index > cursor && record.oldCommit === current);
    if (nextIndex < 0) {
      return { valid: false, hops, reason: 'Review approval note does not bind the current branch HEAD through a complete recorded clean-rebase chain.' };
    }
    const record = normalized[nextIndex];
    if (!record.newCommit) return { valid: false, hops, reason: `Recorded rebase target ${record.newSha} does not resolve.` };
    if (visited.has(record.newCommit)) return { valid: false, hops, reason: 'Recorded clean-rebase chain contains a cycle.' };
    hops.push(record);
    visited.add(record.newCommit);
    current = record.newCommit;
    cursor = nextIndex;
  }
  return { valid: true, hops };
}

function approvalValidity(root, record, ticketPath, planPath) {
  const commitExists = gitResult(root, ['cat-file', '-e', `${record.commit}^{commit}`], { allowFailure: true }).status === 0;
  if (!commitExists) return { valid: false, reason: `approval commit ${record.commit} does not exist` };
  const reachable = gitResult(root, ['merge-base', '--is-ancestor', record.commit, 'main'], { allowFailure: true }).status === 0;
  if (!reachable) return { valid: false, reason: `approval commit ${record.commit} is not reachable from main` };
  const ticket = commitFile(root, record.commit, ticketPath);
  const plan = commitFile(root, record.commit, planPath);
  if (ticket === undefined || plan === undefined) return { valid: false, reason: `approval commit ${record.commit} does not contain both gate artifacts` };
  try {
    if (fingerprintContent(ticket) !== record.ticketSha256) return { valid: false, reason: `ticket hash does not reproduce at ${record.commit}` };
    if (fingerprintContent(plan) !== record.planSha256) return { valid: false, reason: `plan hash does not reproduce at ${record.commit}` };
  } catch (error) {
    return { valid: false, reason: `approval artifacts at ${record.commit} cannot be fingerprinted: ${error.message}` };
  }
  const committedPlan = parsePlan(plan);
  if (committedPlan.sourceTicketSha256 && committedPlan.sourceTicketSha256 !== record.ticketSha256) {
    return { valid: false, reason: `plan source-ticket hash disagrees at ${record.commit}` };
  }
  return { valid: true };
}

export function latestReproducibleApproval({ root, records, ticketPath, planPath }) {
  const rejected = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const validity = approvalValidity(root, records[index], ticketPath, planPath);
    if (validity.valid) return { record: records[index], rejected };
    rejected.push({ record: records[index], reason: validity.reason });
  }
  return { record: null, rejected };
}

function objectsWithSeverity(value, severity, found = []) {
  if (Array.isArray(value)) for (const child of value) objectsWithSeverity(child, severity, found);
  else if (value && typeof value === 'object') {
    if (String(value.severity ?? '').toLowerCase() === severity) found.push(value);
    for (const child of Object.values(value)) objectsWithSeverity(child, severity, found);
  }
  return found;
}

function nativeDiagnosticErrors(native, { includeInProgress = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!native.health.ok || !native.health.data) errors.push(`Beads health could not be established: ${native.health.error || 'empty diagnostic response'}`);
  const blocking = objectsWithSeverity(native.health.data, 'blocking');
  if (blocking.length) errors.push(`Beads doctor reports ${blocking.length} blocking health issue${blocking.length === 1 ? '' : 's'}.`);
  const degraded = objectsWithSeverity(native.health.data, 'degraded');
  if (degraded.length) warnings.push(`Beads doctor reports ${degraded.length} degraded health issue${degraded.length === 1 ? '' : 's'}.`);
  if (native.serverHealth) {
    if (!native.serverHealth.ok || !native.serverHealth.data) errors.push(`Beads server health could not be established: ${native.serverHealth.error || 'empty diagnostic response'}`);
    const serverBlocking = objectsWithSeverity(native.serverHealth.data, 'blocking');
    if (serverBlocking.length) errors.push(`Beads server doctor reports ${serverBlocking.length} blocking issue${serverBlocking.length === 1 ? '' : 's'}.`);
  }
  const diagnostics = { context: native.context, ready: native.ready, cycles: native.cycles, worktrees: native.worktrees, gates: native.gates, escalations: native.escalations, stale: native.stale, orphans: native.orphans };
  if (includeInProgress) diagnostics.inProgress = native.inProgress;
  for (const [name, result] of Object.entries(diagnostics)) {
    if (!result?.ok) errors.push(`Beads ${name} diagnostics failed: ${result?.error ?? 'unavailable'}`);
  }
  if (native.cycles.ok && native.cycles.data.length) errors.push(`Beads dependency graph contains ${native.cycles.data.length} cycle${native.cycles.data.length === 1 ? '' : 's'}.`);
  if (native.mergeSlot && !native.mergeSlot.data && !native.mergeSlot.ok) errors.push(`Configured merge-slot state is unavailable: ${native.mergeSlot.error}`);
  if (native.mergeSlot?.data?.error === 'not found') errors.push('Configured merge slot does not exist; initialize it from a fresh authorized root with BEADS_ACTOR="<new-session-actor>" bd merge-slot create.');
  return { errors, warnings };
}

function detectedBeadsMode(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = detectedBeadsMode(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const key of ['mode', 'connection_mode', 'backend_mode', 'dolt_mode', 'database_mode']) {
    const candidate = String(value[key] ?? '').toLowerCase();
    if (candidate === 'server' || candidate === 'embedded') return candidate;
  }
  if (typeof value.server_mode === 'boolean') return value.server_mode ? 'server' : 'embedded';
  for (const child of Object.values(value)) {
    const found = detectedBeadsMode(child);
    if (found) return found;
  }
  return null;
}

export function issueId(issue) {
  return issue?.id ?? issue?.issue_id ?? issue?.issueId;
}

function issueSpecId(issue) {
  return issue?.spec_id ?? issue?.specId ?? issue?.spec;
}

export function issueStatus(issue) {
  return String(issue?.status ?? '').toLowerCase();
}

function issueDependencies(issue) {
  const dependencies = issue?.dependencies ?? issue?.depends_on ?? issue?.blocked_by ?? [];
  if (!Array.isArray(dependencies)) return [];
  return dependencies
    .filter((dependency) => {
      if (typeof dependency === 'string') return true;
      const type = dependency?.dependency_type ?? dependency?.type;
      return !type || type === 'blocks';
    })
    .map((dependency) => typeof dependency === 'string'
      ? dependency
      : dependency?.depends_on_id ?? dependency?.to_id ?? dependency?.id ?? dependency?.issue_id)
    .filter(Boolean);
}

export function gateBlockedId(gate) {
  return gate?.blocks ?? gate?.blocks_id ?? gate?.blocked_issue_id ?? gate?.blockedIssueId ?? gate?.blocked_issue_ids?.[0] ?? issueMetadata(gate).blocks;
}

function validateBeadsMapping({ plan, ticketPath, planPath, epic, children, childDetails }) {
  const errors = [];
  const warnings = [];
  const expectedIdentity = { sdlc_ticket: ticketPath, sdlc_plan: planPath };
  const checkBase = (issue, label) => {
    if (issueSpecId(issue) !== planPath) errors.push(`${label} spec-id does not equal ${planPath}.`);
    const metadata = issueMetadata(issue);
    for (const [key, value] of Object.entries(expectedIdentity)) if (String(metadata[key] ?? '') !== value) errors.push(`${label} metadata ${key} is not ${value}.`);
    for (const forbidden of ['plan_sha256', 'ticket_sha256', 'sdlc_plan_sha256', 'sdlc_ticket_sha256']) {
      if (Object.hasOwn(metadata, forbidden)) errors.push(`${label} metadata duplicates authoritative hash field ${forbidden}.`);
    }
  };
  checkBase(epic, 'Epic');

  const byStep = new Map();
  for (const child of children) {
    const metadata = issueMetadata(child);
    const rawStep = metadata.sdlc_step;
    const step = Number(rawStep);
    if (!Number.isInteger(step) || step < 1 || String(step) !== String(rawStep)) {
      errors.push(`Beads child ${issueId(child) || '<unknown>'} has missing or invalid sdlc_step metadata.`);
      continue;
    }
    if (byStep.has(step)) errors.push(`Plan step ${step} maps to multiple Beads children.`);
    else byStep.set(step, child);
  }
  for (const step of plan.activeSteps) {
    const child = byStep.get(step.number);
    if (!child) {
      errors.push(`Active plan step ${step.number} has no Beads child mapping.`);
      continue;
    }
    checkBase(child, `Step ${step.number} child`);
    const detail = childDetails.get(issueId(child)) ?? child;
    const actualDependencies = new Set(issueDependencies(detail));
    const expectedDependencies = step.dependencies.map((number) => issueId(byStep.get(number))).filter(Boolean);
    for (const dependency of expectedDependencies) if (!actualDependencies.has(dependency)) errors.push(`Step ${step.number} is missing Beads dependency ${dependency}.`);
    for (const dependency of actualDependencies) if (!expectedDependencies.includes(dependency)) errors.push(`Step ${step.number} has an undeclared Beads dependency ${dependency}.`);
    const description = String(detail?.description ?? detail?.body ?? '');
    if (issueStatus(detail) !== 'closed' && step.files?.some((file) => !description.includes(file))) {
      errors.push(`Open step ${step.number} description does not reflect its current Files scope.`);
    }
  }
  for (const step of plan.removedSteps) {
    const child = byStep.get(step.number);
    if (child) {
      checkBase(child, `Removed step ${step.number} child`);
      if (issueStatus(child) !== 'closed') errors.push(`Removed plan step ${step.number} retains an open Beads child.`);
    }
  }
  for (const [number] of byStep) {
    if (!plan.steps.some((step) => step.number === number)) errors.push(`Beads child maps to unknown plan step ${number}.`);
  }
  return { errors, warnings, byStep };
}

function gitWorktreeState(path, branch) {
  if (!path || !existsSync(path)) return null;
  const actualBranch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
  const head = git(path, ['rev-parse', 'HEAD'], { allowFailure: true });
  const dirty = Boolean(git(path, ['status', '--short'], { allowFailure: true }));
  const stashes = git(path, ['stash', 'list'], { allowFailure: true })?.split('\n').filter(Boolean).length ?? 0;
  const upstream = git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
  const publicationBaseline = upstream || (git(path, ['rev-parse', '--verify', 'main'], { allowFailure: true }) ? 'main' : null);
  const unpushed = publicationBaseline ? Number(git(path, ['rev-list', '--count', `${publicationBaseline}..HEAD`], { allowFailure: true }) ?? 0) : null;
  const lastCommitAt = Number(git(path, ['log', '-1', '--format=%ct'], { allowFailure: true })) || null;
  return { path, branch: actualBranch || branch, head, dirty, stashes, upstream: upstream || null, publicationBaseline, unpushed, lastCommitAt };
}

function nativeWorktreeFor(nativeWorktrees, expectedBranch, primary) {
  return nativeWorktrees.find((worktree) => {
    const branch = String(worktree.branch ?? worktree.branch_name ?? '').replace(/^refs\/heads\//, '');
    const path = resolve(primary, worktree.path ?? worktree.worktree ?? '');
    return branch === expectedBranch && path !== primary;
  });
}

export function pathMatchesScope(path, declared) {
  const clean = declared.replace(/^`|`$/g, '').replace(/^\.\//, '');
  if (!/[?*]/.test(clean)) return path === clean || path.startsWith(`${clean.replace(/\/$/, '')}/`);
  let expression = '';
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index];
    if (character === '*' && clean[index + 1] === '*') {
      if (clean[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(path);
}

function changedPaths(worktree) {
  const base = git(worktree, ['merge-base', 'main', 'HEAD'], { allowFailure: true });
  if (!base) return [];
  return (git(worktree, ['diff', '--name-only', `${base}...HEAD`], { allowFailure: true }) ?? '')
    .split('\n').filter(Boolean).filter((path) => !path.startsWith('thoughts/reviews/'));
}

function validateReview({ files, worktree, plan, ticket, approval, epicNotes }) {
  const errors = [];
  const warnings = [];
  if (!files.length) return { artifact: null, errors, warnings };
  let previous;
  const parsed = [];
  for (const [index, file] of files.entries()) {
    if (file.round !== index + 1) errors.push(`Review artifact sequence expected round ${index + 1}, found round ${file.round}.`);
    if (file.round > 3) errors.push(`Plan review round ${file.round} exceeds the three-round cap.`);
    const source = readFileSync(file.path, 'utf8');
    const artifact = parseReviewArtifact(source, { previous });
    if (artifact.version === 'structured' && artifact.round !== file.round) errors.push(`Review filename round ${file.round} disagrees with its title round ${artifact.round ?? '<missing>'}.`);
    if (artifact.version === 'structured' && previous?.version === 'structured' && artifact.round !== previous.round + 1) {
      errors.push(`Structured review rounds are not contiguous at round ${artifact.round ?? '<missing>'}.`);
    }
    if (!artifact.valid) errors.push(...artifact.errors.map((error) => `Review round ${file.round}: ${error}`));
    parsed.push({ ...file, artifact, source });
    if (artifact.valid) previous = artifact;
  }
  const latest = parsed.at(-1);
  const artifact = latest.artifact;
  warnings.push(...artifact.warnings.map((warning) => `Review: ${warning}`));
  if (artifact.version === 'legacy' && plan.sourceTicketSha256) {
    errors.push('A plan using the new hash contract requires a structured aggregate review artifact.');
  }
  if (artifact.version === 'structured') {
    if (artifact.approvedPlanSha256 !== approval?.planSha256) errors.push('Review is bound to a different approved plan hash.');
    if (!commitsMatch(worktree, artifact.approvedPlanCommit, approval?.commit)) errors.push('Review is bound to a different approved plan commit.');
    const live = ticket.activeAcceptanceCriteria.filter((id) => !plan.coverage.waived.includes(id)).sort();
    const verified = artifact.acceptanceCoverage?.verified?.slice().sort() ?? [];
    const missing = artifact.acceptanceCoverage?.missing?.slice().sort() ?? [];
    const reported = [...new Set([...verified, ...missing])].sort();
    if (live.join(',') !== reported.join(',')) errors.push('Review AC-Coverage does not account for every live, unwaived acceptance criterion exactly once.');
    if (artifact.verdict?.approved && missing.length) errors.push('Approved review AC-Coverage still reports missing acceptance criteria.');
    const changed = changedPaths(worktree);
    const declared = plan.activeSteps.flatMap((step) => step.files ?? []);
    const unplanned = changed.filter((path) => !declared.some((scope) => pathMatchesScope(path, scope)));
    if ((artifact.scope?.unplanned ?? []).slice().sort().join(',') !== unplanned.sort().join(',')) {
      errors.push('Review Scope-Check does not match the actual branch diff.');
    }
  }

  const notes = parseReviewApprovalRecords(epicNotes);
  if (notes.malformed.length) warnings.push(`${notes.malformed.length} malformed review approval note${notes.malformed.length === 1 ? '' : 's'} ignored.`);
  const note = notes.records.at(-1);
  const branchHead = git(worktree, ['rev-parse', 'HEAD'], { allowFailure: true });
  const rebases = parseRebaseRecords(epicNotes);
  if (rebases.malformed.length) warnings.push(`${rebases.malformed.length} malformed clean-rebase record${rebases.malformed.length === 1 ? '' : 's'} ignored.`);
  const headBinding = note && branchHead
    ? reviewHeadBinding(worktree, note.artifactSha, branchHead, rebases.records.filter((record) => record.index > note.index))
    : null;
  if (artifact.reviewedCodeSha) {
    if (gitResult(worktree, ['cat-file', '-e', `${artifact.reviewedCodeSha}^{commit}`], { allowFailure: true }).status !== 0) {
      errors.push('Reviewed code SHA does not resolve to a commit in the worktree repository.');
    } else if (!note && branchHead && gitResult(worktree, ['merge-base', '--is-ancestor', artifact.reviewedCodeSha, branchHead], { allowFailure: true }).status !== 0) {
      errors.push('Reviewed code SHA is not an ancestor of the current branch HEAD.');
    }
  }
  if (note) {
    if (!headBinding?.valid) errors.push(headBinding?.reason ?? 'Review approval note does not bind the current branch HEAD.');
    if (!commitsMatch(worktree, note.codeSha, artifact.reviewedCodeSha)) errors.push('Review approval note code-sha disagrees with the aggregate artifact.');
    if (note.planSha256 !== approval?.planSha256 || !commitsMatch(worktree, note.planCommit, approval?.commit)) errors.push('Review approval note is bound to a stale plan approval.');
    if (note.rounds !== artifact.round) errors.push('Review approval note round count disagrees with the aggregate artifact.');
    if (artifact.reviewedCodeSha && gitResult(worktree, ['merge-base', '--is-ancestor', artifact.reviewedCodeSha, note.artifactSha], { allowFailure: true }).status !== 0) {
      errors.push('Reviewed code SHA is not an ancestor of the approved artifact commit.');
    }
    const artifactPath = posixPath(relative(worktree, latest.path));
    const approvedSource = commitFile(worktree, note.artifactSha, artifactPath);
    if (approvedSource === undefined) errors.push('Review approval commit does not contain the aggregate artifact.');
    else if (fingerprintContent(approvedSource) !== fingerprintContent(latest.source)) {
      errors.push('Current aggregate artifact differs from the artifact bound by the review approval note.');
    }
  } else if (artifact.verdict?.approved) warnings.push('Approved review artifact has no matching epic approval note yet.');
  return {
    artifact: {
      path: latest.path,
      ...artifact,
      approvalNote: note ?? null,
      rebaseChain: headBinding?.hops ?? [],
      valid: artifact.valid && errors.length === 0,
    },
    errors,
    warnings,
  };
}

function serializeIssue(issue) {
  if (!issue) return null;
  const blocks = gateBlockedId(issue);
  const reason = issue.reason ?? String(issue.description ?? '').match(/(?:^|\n)Reason:[ \t]*(.+)(?:\n|$)/i)?.[1]?.trim();
  return {
    id: issueId(issue),
    title: issue.title ?? null,
    status: issueStatus(issue),
    assignee: issue.assignee ?? null,
    updatedAt: issue.updated_at ?? issue.updatedAt ?? null,
    ...(blocks ? { blocks } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function evaluateArtifactState({ ticket, plan, ticketSha256, planSha256, approval, approvalRecordsExist = false }) {
  if (!ticket) return { state: 'blocked', errors: ['Ticket could not be resolved.'] };
  if (!ticket.activeAcceptanceCriteria.length) return { state: 'legacy', errors: ['Ticket has no active AC-NNN contract.'] };
  if (ticket.errors.length) return { state: 'blocked', errors: ticket.errors };
  if (!plan) {
    if (ticket.frontmatter.Type === 'chore') {
      return { state: 'blocked', errors: ['Chore-lane ticket intentionally has no plan; resume or recover it through /chore, not /plan.'] };
    }
    if (ticket.status === 'approved') return { state: 'ready_for_planning', errors: [] };
    return { state: 'blocked', errors: [`Ticket status ${ticket.status || '<missing>'} is not approved.`] };
  }
  if (!plan.sourceTicketSha256 && !plan.sourceTicketHashPresent) return { state: 'legacy', errors: ['Plan has no Source Ticket Hash.'] };
  if (plan.errors.length) return { state: 'blocked', errors: plan.errors };
  if (!plan.sourceTicketSha256) return { state: 'blocked', errors: ['Plan Source Ticket Hash is invalid.'] };
  if (plan.status === 'merged') {
    return { state: 'blocked', errors: ['Plan is merged; this is a terminal/recovery projection, not an implementation candidate.'] };
  }
  if (plan.status === 'cancelled') {
    return { state: 'blocked', errors: ['Plan is cancelled and has no legal autonomous transition.'] };
  }
  if (ticket.status !== 'approved') return { state: 'blocked', errors: [`Ticket status ${ticket.status || '<missing>'} is incompatible with an active plan.`] };
  if (plan.sourceTicketSha256 !== ticketSha256) return { state: 'reapproval_required', errors: ['Plan source-ticket hash differs from the canonical ticket.'] };
  if (plan.status === 'review') return { state: 'ready_for_approval', errors: [] };
  if (plan.status !== 'approved') return { state: 'blocked', errors: [`Plan status ${plan.status || '<missing>'} is not review or approved.`] };
  if (!approval) {
    return approvalRecordsExist
      ? { state: 'blocked', errors: ['No approval record is reproducible from main.'] }
      : { state: 'reapproval_required', errors: ['Approved plan has no approval record.'] };
  }
  if (approval.ticketSha256 !== ticketSha256 || approval.planSha256 !== planSha256) {
    return { state: 'reapproval_required', errors: ['Canonical ticket or plan differs from the latest reproducible approval.'] };
  }
  return { state: 'healthy', errors: [] };
}

/**
 * Collect repository-wide inspection state once so callers that inspect more
 * than one pipeline number do not repeat native Beads diagnostics. The object
 * is shallowly frozen and all exposed message arrays are frozen; consumers
 * must treat adapter/native payloads as read-only snapshots.
 */
export function createDoctorInspectionContext({
  cwd = process.cwd(),
  beadsExecutable = 'bd',
  beadsRunner,
  now = Date.now(),
  includeInProgress = false,
} = {}) {
  let primary;
  try {
    primary = resolvePrimaryCheckout(cwd);
  } catch (error) {
    return Object.freeze({
      primary: null,
      head: null,
      now,
      dependencyUnavailable: true,
      installation: { available: false, coreCapabilitiesValid: false, version: null, capabilities: {}, errors: [] },
      config: { mode: 'embedded', mergeSlotEnabled: false, errors: [] },
      adapter: null,
      native: null,
      errors: Object.freeze([`Git repository could not be resolved: ${error.message}`]),
      warnings: Object.freeze([]),
    });
  }

  const projectConfig = readProjectConfig(primary);
  const config = Object.freeze({
    ...projectConfig,
    mode: projectConfig.beadsMode,
  });
  const errors = [...config.errors];
  const warnings = [];
  const installation = inspectBeadsInstallation({
    cwd: primary,
    executable: beadsExecutable,
    ...(beadsRunner ? { runner: beadsRunner } : {}),
  });
  if (!installation.available || !installation.coreCapabilitiesValid) errors.push(...installation.errors);

  let adapter = null;
  let native = null;
  if (installation.coreCapabilitiesValid) {
    adapter = createBeadsAdapter({
      cwd: primary,
      executable: beadsExecutable,
      ...(beadsRunner ? { runner: beadsRunner } : {}),
    });
    native = collectNativeDiagnostics(adapter, config);
    // Plain doctor keeps its established error surface. Snapshot callers opt
    // into treating the additional global in-progress inventory as required.
    const nativeMessages = nativeDiagnosticErrors(native, { includeInProgress });
    errors.push(...nativeMessages.errors);
    warnings.push(...nativeMessages.warnings);
    const detectedMode = native.context.ok ? detectedBeadsMode(native.context.data) : null;
    if (detectedMode && detectedMode !== config.mode) errors.push(`Configured Beads mode is ${config.mode}, but the active context is ${detectedMode}.`);
    else if (!detectedMode && native.context.ok) warnings.push('Beads connection mode could not be derived from bd context output.');
  }

  return Object.freeze({
    primary,
    head: git(primary, ['rev-parse', 'HEAD'], { allowFailure: true }) ?? null,
    now,
    dependencyUnavailable: !installation.available,
    installation: Object.freeze(installation),
    config,
    adapter: adapter ? Object.freeze(adapter) : null,
    native,
    errors: Object.freeze(uniqueMessages(errors)),
    warnings: Object.freeze(uniqueMessages(warnings)),
  });
}

export function inspectDoctor(number, {
  cwd = process.cwd(),
  beadsExecutable = 'bd',
  beadsRunner,
  now = Date.now(),
  inspectionContext,
} = {}) {
  const normalizedNumber = String(number).padStart(3, '0');
  const errors = [];
  const warnings = [];
  const shared = inspectionContext ?? createDoctorInspectionContext({ cwd, beadsExecutable, beadsRunner, now });
  const primary = shared.primary;
  const inspectionNow = shared.now ?? now;
  if (!primary) {
    return {
      number: normalizedNumber,
      state: 'blocked',
      dependencyUnavailable: true,
      ticket: null,
      plan: null,
      beads: { capabilitiesValid: false },
      worktree: null,
      mergeSlot: { enabled: false, holder: null },
      review: null,
      errors: [...shared.errors],
      warnings,
    };
  }

  const ticketPaths = artifactCandidates(primary, 'tickets', normalizedNumber);
  if (ticketPaths.length !== 1) errors.push(`Expected exactly one ticket for ${normalizedNumber}; found ${ticketPaths.length}.`);
  const ticketPath = ticketPaths[0];
  let ticket = null;
  let ticketSha256 = null;
  if (ticketPath) {
    try {
      const source = readFileSync(ticketPath);
      ticket = parseTicket(source.toString('utf8'), { path: posixPath(relative(primary, ticketPath)) });
      ticketSha256 = fingerprintContent(source);
    } catch (error) {
      errors.push(`Canonical ticket ${posixPath(relative(primary, ticketPath))} could not be read and fingerprinted: ${error.message}`);
    }
  }

  let planCandidates = [];
  try {
    planCandidates = applicablePlanCandidates(artifactCandidates(primary, 'plans', normalizedNumber), ticket);
  } catch (error) {
    errors.push(`Plan candidates for ${normalizedNumber} could not be read: ${error.message}`);
  }
  if (planCandidates.length > 1) errors.push(`Expected at most one applicable plan for ${normalizedNumber}; found ${planCandidates.length}.`);
  const planPath = planCandidates[0]?.path;
  let plan = null;
  let planSha256 = null;
  if (planPath) {
    try {
      const source = readFileSync(planPath);
      plan = parsePlan(source.toString('utf8'), { path: posixPath(relative(primary, planPath)), ticket });
      planSha256 = fingerprintContent(source);
    } catch (error) {
      errors.push(`Canonical plan ${posixPath(relative(primary, planPath))} could not be read and fingerprinted: ${error.message}`);
    }
  }
  warnings.push(...(plan?.warnings ?? []));

  errors.push(...shared.errors);
  warnings.push(...shared.warnings);
  const { installation, config, native, adapter } = shared;
  let epic;
  let children = [];
  let mapping;
  let approval;
  let approvalRecordsExist = false;
  let epicNotes = '';
  const approvalSyncErrors = [];
  if (installation.coreCapabilitiesValid && adapter) {
    if (plan?.beadsEpic) {
      try {
        epic = adapter.showIssue(plan.beadsEpic);
        epicNotes = issueNotes(epic);
        children = adapter.listChildren(plan.beadsEpic);
      } catch (error) {
        errors.push(`Beads epic ${plan.beadsEpic} could not be resolved: ${error.message}`);
      }
    } else if (plan?.status === 'approved') approvalSyncErrors.push('Approved plan has no Beads Epic mapping.');

    if (epic && plan) {
      const details = new Map();
      for (const child of children) {
        try {
          details.set(issueId(child), adapter.showIssue(issueId(child)));
        } catch (error) {
          errors.push(`Beads child ${issueId(child)} could not be inspected: ${error.message}`);
        }
      }
      mapping = validateBeadsMapping({
        plan,
        ticketPath: ticket.path,
        planPath: plan.path,
        epic,
        children,
        childDetails: details,
      });
      approvalSyncErrors.push(...mapping.errors);
      warnings.push(...mapping.warnings);

      const parsed = parseApprovalRecords(epicNotes);
      approvalRecordsExist = parsed.records.length > 0;
      if (parsed.malformed.length) warnings.push(`${parsed.malformed.length} malformed approval record${parsed.malformed.length === 1 ? '' : 's'} ignored.`);
      const reproducible = latestReproducibleApproval({
        root: primary,
        records: parsed.records,
        ticketPath: ticket.path,
        planPath: plan.path,
      });
      approval = reproducible.record;
      for (const rejected of reproducible.rejected) warnings.push(`Ignored unreproducible approval: ${rejected.reason}.`);

      const waiverIds = [
        ...plan.coverage.waived,
        ...plan.critique.findings.filter((finding) => finding.disposition === 'waived').map((finding) => finding.id),
      ];
      const waiverRecords = parseWaiverRecords(epicNotes);
      if (waiverRecords.malformed.length) warnings.push(`${waiverRecords.malformed.length} malformed waiver record${waiverRecords.malformed.length === 1 ? '' : 's'} ignored.`);
      const recordedWaiverIds = new Set(waiverRecords.records.map((record) => record.id));
      for (const id of new Set(waiverIds)) {
        if (!recordedWaiverIds.has(id)) approvalSyncErrors.push(`Waiver ${id} is not recorded with a reason in epic notes.`);
      }
    }
  }

  const artifactState = evaluateArtifactState({ ticket, plan, ticketSha256, planSha256, approval, approvalRecordsExist });
  if (['reapproval_required', 'legacy'].includes(artifactState.state) && plan?.status === 'approved') {
    warnings.push(...approvalSyncErrors.map((error) => `Pending /approve sync: ${error}`));
  } else {
    errors.push(...approvalSyncErrors);
  }

  let worktree = null;
  let review = null;
  const branch = planPath ? basename(planPath, '.md') : null;
  if (native?.worktrees.ok && branch) {
    const registered = nativeWorktreeFor(native.worktrees.data, branch, primary);
    if (registered) {
      const path = resolve(primary, registered.path ?? registered.worktree);
      const gitState = gitWorktreeState(path, branch);
      const beadsState = registered.beads_state ?? registered.beadsState ?? registered.state ?? null;
      if (!['local', 'shared', 'redirect'].includes(beadsState)) errors.push(`Plan worktree Beads state is ${beadsState || 'unknown'}, not a supported native shared-store state.`);
      if (gitState?.branch !== branch) errors.push(`Plan worktree branch is ${gitState?.branch}, expected ${branch}.`);
      let snapshotMatchesApprovedPlan = null;
      const snapshot = join(path, plan.path);
      if (existsSync(snapshot) && approval) {
        try {
          snapshotMatchesApprovedPlan = fingerprintFile(snapshot) === approval.planSha256;
          if (!snapshotMatchesApprovedPlan) warnings.push('Worktree plan snapshot differs from the approved canonical plan; canonical main remains authoritative.');
        } catch (error) {
          warnings.push(`Worktree plan snapshot could not be fingerprinted: ${error.message}`);
        }
      }
      worktree = { ...gitState, beadsState, snapshotMatchesApprovedPlan, snapshotSeverity: snapshotMatchesApprovedPlan === false ? 'warning' : null };
      if (gitState?.dirty) warnings.push('Plan worktree has uncommitted changes.');
      if (gitState?.unpushed > 0) warnings.push(`Plan worktree has ${gitState.unpushed} unpushed commit${gitState.unpushed === 1 ? '' : 's'}.`);
      if (gitState?.stashes > 0) warnings.push(`Plan worktree has ${gitState.stashes} stash${gitState.stashes === 1 ? '' : 'es'}; native removal will refuse.`);
      try {
        const reviewResult = validateReview({ files: latestReviewFiles(path, normalizedNumber), worktree: path, plan, ticket, approval, epicNotes });
        review = reviewResult.artifact;
        errors.push(...reviewResult.errors);
        warnings.push(...reviewResult.warnings);
      } catch (error) {
        errors.push(`Review artifacts could not be validated: ${error.message}`);
      }
    }
  }
  if (epic && issueStatus(epic) === 'in_progress' && !worktree) {
    errors.push('Epic is claimed/in_progress but no Beads-visible plan worktree exists; recover the claim explicitly.');
  }

  if (native && mapping) {
    const planIssueIds = new Set([issueId(epic), ...children.map(issueId)]);
    const openGates = native.gates.data.filter((gate) => planIssueIds.has(gateBlockedId(gate)));
    if (openGates.length) {
      const childIds = new Set(children.map(issueId));
      const readyChildIds = new Set(native.ready.data.map(issueId).filter((id) => childIds.has(id)));
      const message = `Plan has ${openGates.length} open human gate${openGates.length === 1 ? '' : 's'}; resolve from a fresh authorized root with BEADS_ACTOR="<new-session-actor>" bd gate resolve <gate-id> --reason="...".`;
      if (readyChildIds.size) warnings.push(`${message} ${readyChildIds.size} unrelated child${readyChildIds.size === 1 ? ' remains' : 'ren remain'} ready.`);
      else errors.push(message);
    }
    const stale = native.stale.data.filter((issue) => planIssueIds.has(issueId(issue)));
    if (stale.length) {
      const corroborated = !worktree || (!worktree.dirty && worktree.lastCommitAt && inspectionNow / 1000 - worktree.lastCommitAt >= 86400);
      if (corroborated) errors.push(`Plan has ${stale.length} stale in-progress Beads issue${stale.length === 1 ? '' : 's'} corroborated by worktree inactivity.`);
      else warnings.push('Beads reports candidate stale work, but current Git/worktree activity does not corroborate abandonment.');
    }
    const orphans = native.orphans.data.filter((item) => planIssueIds.has(issueId(item) ?? item.issue?.id));
    if (orphans.length) errors.push(`Plan has ${orphans.length} orphaned issue-referencing commit${orphans.length === 1 ? '' : 's'}; inspect with bd --readonly orphans --json and recover explicitly.`);
    const escalations = native.escalations.data.filter((issue) => planIssueIds.has(issueId(issue)));
    if (escalations.length) errors.push(`Plan has ${escalations.length} unresolved human escalation${escalations.length === 1 ? '' : 's'}.`);
  }

  let mergeSlot = { enabled: config.mergeSlotEnabled, holder: null };
  if (native?.mergeSlot?.data) {
    const data = native.mergeSlot.data;
    const updatedAt = data.updated_at ?? data.updatedAt ?? null;
    const updatedAtMilliseconds = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    mergeSlot = {
      enabled: true,
      id: data.id ?? null,
      holder: data.holder ?? data.metadata?.holder ?? null,
      updatedAt,
      ageSeconds: Number.isNaN(updatedAtMilliseconds) ? null : Math.max(0, Math.floor((inspectionNow - updatedAtMilliseconds) / 1000)),
      available: data.available ?? String(data.status ?? '').toLowerCase() === 'open',
      error: data.error ?? null,
    };
    if (mergeSlot.holder) warnings.push(`Merge slot is held by ${mergeSlot.holder}${mergeSlot.ageSeconds === null ? '' : ` (age ${mergeSlot.ageSeconds}s)`}.`);
  }

  const invariantErrors = errors.length;
  const state = invariantErrors ? 'blocked' : artifactState.state;
  if (!invariantErrors && artifactState.errors.length) errors.push(...artifactState.errors);
  const openGates = native?.gates?.data?.filter((gate) => mapping?.byStep && [...mapping.byStep.values()].some((issue) => issueId(issue) === gateBlockedId(gate))) ?? [];
  const staleClaims = native?.stale?.data?.filter((issue) => [issueId(epic), ...children.map(issueId)].includes(issueId(issue))) ?? [];
  const orphans = native?.orphans?.data?.filter((item) => [issueId(epic), ...children.map(issueId)].includes(issueId(item) ?? item.issue?.id)) ?? [];
  const escalations = native?.escalations?.data?.filter((issue) => [issueId(epic), ...children.map(issueId)].includes(issueId(issue))) ?? [];

  const result = {
    number: normalizedNumber,
    state,
    dependencyUnavailable: !installation.available,
    primaryCheckout: primary,
    ticket: ticket ? { path: ticket.path, sha256: ticketSha256, status: ticket.status, acceptanceCriteria: ticket.activeAcceptanceCriteria } : null,
    plan: plan ? {
      path: plan.path,
      sha256: planSha256,
      status: plan.status,
      sourceTicketSha256: plan.sourceTicketSha256,
      approvedCommit: approval?.commit ?? null,
      acceptanceCoverage: plan.coverage,
    } : null,
    beads: {
      version: installation.version,
      mode: config.mode,
      capabilities: installation.capabilities,
      capabilitiesValid: installation.coreCapabilitiesValid,
      healthValid: native
        ? native.health.ok
          && Boolean(native.health.data)
          && !objectsWithSeverity(native.health.data, 'blocking').length
          && (!native.serverHealth || (native.serverHealth.ok
            && Boolean(native.serverHealth.data)
            && !objectsWithSeverity(native.serverHealth.data, 'blocking').length))
        : false,
      healthSupported: native ? Boolean(native.health.data) && native.health.data?.supported !== false : false,
      epic: serializeIssue(epic),
      mappingValid: mapping ? mapping.errors.length === 0 : null,
      dependenciesValid: native ? native.cycles.ok && native.cycles.data.length === 0 : false,
      openGates: openGates.map(serializeIssue),
      escalations: escalations.map(serializeIssue),
      staleClaim: staleClaims[0] ? serializeIssue(staleClaims[0]) : null,
      orphans,
    },
    worktree,
    mergeSlot,
    review: review ? {
      artifact: posixPath(relative(primary, review.path)),
      verdict: review.verdict?.value ?? null,
      codeSha: review.reviewedCodeSha ?? null,
      approvedPlanSha256: review.approvedPlanSha256 ?? null,
      approvedPlanCommit: review.approvedPlanCommit ?? null,
      round: review.round ?? null,
      rebaseHops: review.rebaseChain?.length ?? 0,
      valid: review.valid,
    } : null,
    errors: uniqueMessages(errors),
    warnings: uniqueMessages(warnings),
  };
  Object.defineProperty(result, 'inspection', {
    enumerable: false,
    value: Object.freeze({
      ticket,
      plan,
      approval,
      epic,
      children: Object.freeze(children.slice()),
      epicNotes,
      mapping,
      context: shared,
    }),
  });
  return result;
}

function uniqueMessages(messages) {
  return [...new Set(messages.filter(Boolean))];
}

export function doctorExitCode(result) {
  if (result.dependencyUnavailable) return 1;
  return DOCTOR_EXIT_CODES[result.state] ?? 1;
}

export function formatDoctor(result) {
  const lines = [`${result.number}: ${result.state}`];
  if (result.ticket) lines.push(`ticket: ${result.ticket.path} (sha256=${result.ticket.sha256})`);
  if (result.plan) lines.push(`plan: ${result.plan.path} (sha256=${result.plan.sha256})`);
  if (result.plan?.approvedCommit) lines.push(`approval: ${result.plan.approvedCommit}`);
  if (result.beads?.version) lines.push(`beads: ${result.beads.version} (${result.beads.mode})`);
  if (result.review) lines.push(`review: ${result.review.valid ? result.review.verdict : 'invalid'} @ ${result.review.codeSha || 'unknown'}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  for (const error of result.errors) lines.push(`error: ${error}`);
  return lines.join('\n');
}
