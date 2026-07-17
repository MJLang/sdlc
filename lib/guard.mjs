import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sectionBody } from './artifacts.mjs';
import { createDoctorInspectionContext, doctorExitCode, gateBlockedId, inspectDoctor, issueId, issueStatus } from './doctor.mjs';

export const GUARD_STAGES = Object.freeze(['plan', 'approve', 'implement', 'review', 'land']);

export const GUARD_ACCEPTANCE_MATRIX = Object.freeze({
  plan: Object.freeze([
    Object.freeze({ mode: 'new-plan', states: Object.freeze(['ready_for_planning']), warnings: 'report' }),
  ]),
  approve: Object.freeze([
    Object.freeze({ mode: 'first-approval', states: Object.freeze(['ready_for_approval']), warnings: 'report' }),
    Object.freeze({ mode: 'amendment', states: Object.freeze(['reapproval_required']), warnings: 'report', constraint: 'approved plan with an intentional canonical artifact drift only' }),
    Object.freeze({ mode: 'no-op', states: Object.freeze(['healthy']), warnings: 'report' }),
  ]),
  implement: Object.freeze([
    Object.freeze({ mode: 'execute', states: Object.freeze(['healthy']), warnings: 'report', constraint: 'compatible claim owner and at least one ungated ready child' }),
    Object.freeze({ mode: 'review', states: Object.freeze(['healthy']), warnings: 'report', constraint: 'all active children closed, clean worktree, no gate or escalation' }),
  ]),
  review: Object.freeze([
    Object.freeze({ mode: 'pending', states: Object.freeze(['healthy']), warnings: 'report', constraint: 'all children closed, clean worktree, no gate or escalation' }),
    Object.freeze({ mode: 'existing', states: Object.freeze(['healthy']), warnings: 'report', constraint: 'existing aggregate artifact is mechanically valid' }),
  ]),
  land: Object.freeze([
    Object.freeze({ mode: 'normal', states: Object.freeze(['healthy']), warnings: 'report', constraint: 'children closed, consent gates resolved, clean worktree, approved bound review' }),
    Object.freeze({ mode: 'post-merge-recovery', states: Object.freeze(['blocked']), warnings: 'semantic-proof-required', constraint: 'merged/implemented artifacts and one matching main commit' }),
  ]),
});

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

function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./,:=@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function recovery(stage, number, code) {
  if (code === 'reapproval-required') return `/sdlc-approve ${number}`;
  if (code === 'legacy') return `migrate ${number} explicitly`;
  if (code === 'gated') return 'resolve the reported dedicated gate from a fresh authorized root';
  if (code === 'foreign-claim') return 'verify the prior actor is inactive, then perform explicit claim recovery';
  if (code === 'review-missing' || code === 'review-invalid' || code === 'review-not-approved') return `/sdlc-implement ${number}`;
  if (code === 'approval-consent-missing') return 'resolve a dedicated gate whose record names the applicable AA-NNN';
  if (code === 'worktree-dirty') return 'reconcile the worktree without discarding user changes';
  if (stage === 'plan') return `sdlc doctor ${number} --json`;
  return `sdlc doctor ${number} --json`;
}

function refusal(stage, diagnosis, code, detail, exitCode) {
  return {
    ok: false,
    stage,
    number: diagnosis.number,
    state: diagnosis.state,
    exitCode: exitCode ?? (doctorExitCode(diagnosis) || 3),
    errors: [{ code, detail, recovery: recovery(stage, diagnosis.number, code) }],
  };
}

function accepted(stage, diagnosis, mode, fields = {}, extraWarnings = []) {
  return {
    ok: true,
    exitCode: 0,
    fields: {
      stage,
      number: diagnosis.number,
      mode,
      state: diagnosis.state,
      ...fields,
      warnings: [...new Set([...diagnosis.warnings.map(warningCode), ...extraWarnings])].sort().join(',') || 'none',
    },
  };
}

function childrenState(diagnosis) {
  const children = diagnosis.inspection?.children ?? [];
  const open = children.filter((child) => !['closed', 'cancelled'].includes(issueStatus(child)));
  const readyIds = new Set(diagnosis.inspection?.context?.native?.ready?.data?.map(issueId).filter(Boolean) ?? []);
  const blockedIds = new Set(diagnosis.inspection?.context?.native?.gates?.data?.map(gateBlockedId).filter(Boolean) ?? []);
  const ready = open.map(issueId).filter((id) => readyIds.has(id) && !blockedIds.has(id)).sort();
  return { children, open, ready };
}

function approvalAttention(source) {
  const body = sectionBody(source, 'Approval Attention');
  if (!body || /^\s*None\b/im.test(body)) return [];
  const records = [];
  for (const line of body.split('\n')) {
    const columns = line.split('|').map((column) => column.trim()).filter(Boolean);
    const id = columns[0]?.match(/^AA-\d{3}$/)?.[0];
    if (!id) continue;
    const status = String(columns.at(-1) ?? '').toLowerCase();
    records.push({ id, status, consentRequired: !['approved', 'approved-in-plan', 'resolved', 'waived', 'not-required', 'n/a', 'closed'].includes(status) });
  }
  return records;
}

function resolvedConsentIds(gates) {
  const ids = new Set();
  for (const gate of gates ?? []) {
    if (!['closed', 'resolved'].includes(issueStatus(gate))) continue;
    const source = JSON.stringify(gate);
    for (const match of source.matchAll(/\bAA-\d{3}\b/g)) ids.add(match[0]);
  }
  return ids;
}

function matchingMergeCommit(primary, number) {
  const result = spawnSync('git', ['log', '--all-match', '--fixed-strings', '--grep', `(ticket ${number})`, '--format=%H', '-1', 'main'], { cwd: primary, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function wrongDoctorState(stage, diagnosis, acceptedStates) {
  if (diagnosis.state === 'reapproval_required') return refusal(stage, diagnosis, 'reapproval-required', diagnosis.errors[0] ?? 'Canonical approval drifted.', 2);
  if (diagnosis.state === 'legacy') return refusal(stage, diagnosis, 'legacy', diagnosis.errors[0] ?? 'Legacy artifact requires explicit migration.', 2);
  if (!acceptedStates.includes(diagnosis.state)) return refusal(stage, diagnosis, 'wrong-state', diagnosis.errors[0] ?? `State ${diagnosis.state} is not accepted by ${stage}.`);
  return null;
}

export function evaluateGuard(stage, diagnosis, {
  actor = process.env.BEADS_ACTOR ?? null,
  allGates = [],
  planSource,
  mergeCommit,
} = {}) {
  if (!GUARD_STAGES.includes(stage)) throw new TypeError(`Unknown guard stage ${JSON.stringify(stage)}.`);
  if (!diagnosis || typeof diagnosis !== 'object') throw new TypeError('A doctor diagnosis is required.');

  if (stage === 'plan') {
    const refused = wrongDoctorState(stage, diagnosis, ['ready_for_planning']);
    if (refused) return refused;
    return accepted(stage, diagnosis, 'new-plan', {
      ticket: diagnosis.ticket.path,
      ticketSha256: diagnosis.ticket.sha256,
    });
  }

  if (stage === 'approve') {
    const status = diagnosis.plan?.status;
    let mode;
    if (diagnosis.state === 'ready_for_approval' && status === 'review') mode = 'first-approval';
    else if (diagnosis.state === 'reapproval_required' && status === 'approved' && diagnosis.beads?.epic?.id) mode = 'amendment';
    else if (diagnosis.state === 'healthy' && status === 'approved') mode = 'no-op';
    if (!mode) {
      const refused = wrongDoctorState(stage, diagnosis, ['ready_for_approval', 'reapproval_required', 'healthy']);
      return refused ?? refusal(stage, diagnosis, 'illegal-approval-mode', `Plan status ${status ?? '<missing>'} cannot use the ${diagnosis.state} approval path.`);
    }
    return accepted(stage, diagnosis, mode, {
      ticket: diagnosis.ticket?.path,
      ticketSha256: diagnosis.ticket?.sha256,
      plan: diagnosis.plan?.path,
      planSha256: diagnosis.plan?.sha256,
      epic: diagnosis.beads?.epic?.id ?? 'none',
    });
  }

  if (stage === 'implement') {
    const refused = wrongDoctorState(stage, diagnosis, ['healthy']);
    if (refused) return refused;
    if (!diagnosis.plan?.approvedCommit || !diagnosis.beads?.epic?.id) return refusal(stage, diagnosis, 'identity-missing', 'Approved plan, approval commit, and epic are required.');
    const owner = diagnosis.beads.epic.assignee;
    if (issueStatus(diagnosis.inspection?.epic) === 'in_progress' && (!owner || !actor || owner !== actor)) {
      return refusal(stage, diagnosis, 'foreign-claim', `Epic is owned by ${owner ?? '<unknown>'}, not ${actor ?? '<no actor>'}.`);
    }
    if (diagnosis.beads.openGates?.length && !childrenState(diagnosis).ready.length) return refusal(stage, diagnosis, 'gated', 'Every remaining child is blocked by a dedicated gate.');
    if (diagnosis.beads.escalations?.length) return refusal(stage, diagnosis, 'human-escalation', 'A non-gating human escalation remains unresolved.');
    const children = childrenState(diagnosis);
    if (children.open.length && !children.ready.length) return refusal(stage, diagnosis, 'no-ready-work', 'Open children exist but none is ready.');
    const mode = children.open.length ? 'execute' : 'review';
    if (mode === 'review' && !diagnosis.worktree) return refusal(stage, diagnosis, 'worktree-missing', 'Completed implementation has no Beads-visible worktree for review.');
    if (mode === 'review' && diagnosis.worktree?.dirty) return refusal(stage, diagnosis, 'worktree-dirty', 'Review requires a clean worktree.');
    return accepted(stage, diagnosis, mode, {
      planSha256: diagnosis.plan.sha256,
      approval: diagnosis.plan.approvedCommit,
      epic: diagnosis.beads.epic.id,
      ready: children.ready.join(',') || 'none',
      worktree: diagnosis.worktree?.path ?? 'none',
    });
  }

  if (stage === 'review') {
    const refused = wrongDoctorState(stage, diagnosis, ['healthy']);
    if (refused) return refused;
    const children = childrenState(diagnosis);
    if (children.open.length) return refusal(stage, diagnosis, 'children-open', `${children.open.length} active child issue(s) remain open.`);
    if (diagnosis.beads.openGates?.length) return refusal(stage, diagnosis, 'gated', 'A dedicated gate remains open.');
    if (diagnosis.beads.escalations?.length) return refusal(stage, diagnosis, 'human-escalation', 'A non-gating human escalation remains unresolved.');
    if (!diagnosis.worktree) return refusal(stage, diagnosis, 'worktree-missing', 'No Beads-visible worktree exists.');
    if (diagnosis.worktree.dirty) return refusal(stage, diagnosis, 'worktree-dirty', 'Review requires a clean worktree.');
    if (diagnosis.inspection?.ticket?.frontmatter.Type === 'discovery' && !diagnosis.discovery?.valid) return refusal(stage, diagnosis, 'discovery-result-invalid', diagnosis.discovery?.errors?.[0] ?? 'Discovery result artifact is missing or malformed.');
    if (diagnosis.review && !diagnosis.review.valid) return refusal(stage, diagnosis, 'review-invalid', 'The latest aggregate artifact is invalid.');
    return accepted(stage, diagnosis, diagnosis.review ? 'existing' : 'pending', {
      worktree: diagnosis.worktree.path,
      head: diagnosis.worktree.head,
      planSha256: diagnosis.plan.sha256,
      approval: diagnosis.plan.approvedCommit,
      review: diagnosis.review?.artifact ?? 'none',
      verdict: diagnosis.review?.verdict ?? 'none',
    });
  }

  const terminalRecovery = diagnosis.plan?.status === 'merged' && diagnosis.ticket?.status === 'implemented';
  if (terminalRecovery) {
    const commit = mergeCommit ?? matchingMergeCommit(diagnosis.primaryCheckout, diagnosis.number);
    const unrelatedErrors = diagnosis.errors.filter((error) => !/Plan is merged; this is a terminal\/recovery projection/i.test(error));
    if (!commit || unrelatedErrors.length) return refusal(stage, diagnosis, 'post-merge-proof-required', unrelatedErrors[0] ?? 'No matching main merge commit could be proven.');
    return accepted(stage, diagnosis, 'post-merge-recovery', {
      plan: diagnosis.plan.path,
      merge: commit,
      epic: diagnosis.beads?.epic?.id ?? 'none',
    }, ['semantic-recovery-proof-required']);
  }

  const refused = wrongDoctorState(stage, diagnosis, ['healthy']);
  if (refused) return refused;
  const children = childrenState(diagnosis);
  if (children.open.length) return refusal(stage, diagnosis, 'children-open', `${children.open.length} active child issue(s) remain open.`);
  if (diagnosis.beads.openGates?.length) return refusal(stage, diagnosis, 'gated', 'A dedicated gate remains open.');
  if (diagnosis.beads.escalations?.length) return refusal(stage, diagnosis, 'human-escalation', 'A non-gating human escalation remains unresolved.');
  if (diagnosis.beads.orphans?.length) return refusal(stage, diagnosis, 'orphan-recovery', 'Orphaned issue-bearing commits require explicit recovery.');
  if (!diagnosis.worktree) return refusal(stage, diagnosis, 'worktree-missing', 'No Beads-visible worktree exists.');
  if (diagnosis.worktree.dirty) return refusal(stage, diagnosis, 'worktree-dirty', 'Landing requires a clean worktree.');
  if (diagnosis.inspection?.ticket?.frontmatter.Type === 'discovery' && !diagnosis.discovery?.valid) return refusal(stage, diagnosis, 'discovery-result-invalid', diagnosis.discovery?.errors?.[0] ?? 'Discovery result artifact is missing or malformed.');
  if (!diagnosis.review) return refusal(stage, diagnosis, 'review-missing', 'No aggregate review artifact exists.');
  if (!diagnosis.review.valid) return refusal(stage, diagnosis, 'review-invalid', 'The aggregate review artifact is invalid.');
  if (!/^APPROVED(?:\b|\s|—)/.test(diagnosis.review.verdict ?? '')) return refusal(stage, diagnosis, 'review-not-approved', `Aggregate verdict is ${diagnosis.review.verdict ?? '<missing>'}.`);

  const source = planSource ?? (diagnosis.plan?.path ? readFileSync(join(diagnosis.primaryCheckout, diagnosis.plan.path), 'utf8') : '');
  const requiredConsent = approvalAttention(source).filter((item) => item.consentRequired).map((item) => item.id);
  const resolved = resolvedConsentIds(allGates);
  const missing = requiredConsent.filter((id) => !resolved.has(id));
  if (missing.length) return refusal(stage, diagnosis, 'approval-consent-missing', `Missing resolved dedicated-gate evidence for ${missing.join(',')}.`);

  return accepted(stage, diagnosis, 'normal', {
    planSha256: diagnosis.plan.sha256,
    approval: diagnosis.plan.approvedCommit,
    review: diagnosis.review.artifact,
    codeSha: diagnosis.review.codeSha,
    worktree: diagnosis.worktree.path,
    consent: requiredConsent.join(',') || 'none',
  });
}

export function inspectGuard(stage, number, {
  cwd = process.cwd(),
  beadsExecutable = 'bd',
  beadsRunner,
  actor = process.env.BEADS_ACTOR ?? null,
  now = Date.now(),
  inspectionContext,
} = {}) {
  if (!GUARD_STAGES.includes(stage)) throw new TypeError(`Unknown guard stage ${JSON.stringify(stage)}.`);
  const context = inspectionContext ?? createDoctorInspectionContext({ cwd, beadsExecutable, beadsRunner, now });
  const diagnosis = inspectDoctor(number, { inspectionContext: context, now });
  let allGates = [];
  if (stage === 'land' && context.adapter) {
    try {
      allGates = context.adapter.listGates({ all: true });
    } catch (error) {
      return refusal(stage, diagnosis, 'gate-history-unavailable', error.message, 3);
    }
  }
  return evaluateGuard(stage, diagnosis, { actor, allGates });
}

export function formatGuard(result) {
  if (result.ok) return `OK ${Object.entries(result.fields).map(([key, value]) => `${key}=${quote(value)}`).join(' ')}`;
  const lines = [`REFUSED stage=${result.stage} number=${result.number} state=${result.state}`];
  for (const error of result.errors) lines.push(`ERROR code=${error.code} detail=${quote(error.detail)} recovery=${quote(error.recovery)}`);
  return lines.join('\n');
}

export function guardExitCode(result) {
  return result.ok ? 0 : result.exitCode ?? 3;
}
