import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CHORE_LANE_SENTINEL,
  aggregateVerdict,
  normalizeReviewVerdict,
  parseReviewArtifact,
  renderReviewTemplate,
  reviewConvergence,
} from '../lib/review-artifact.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sdlc.mjs');

const codeSha = 'a'.repeat(40);
const planSha = 'b'.repeat(64);
const planCommit = 'c'.repeat(40);

function cleanEvidence() {
  return `### Clean-Pass Evidence

- Ticket intent and ACs checked: AC-001.
- Plan steps and deviations checked: no deviation.
- Canonical repository siblings and conventions inspected: lib/sibling.mjs.
- Tests and failure paths examined: npm test and invalid input.
- Risk surfaces considered: security, data, performance, accessibility, and operational risk.
`;
}

function structuredReview({
  round = 1,
  componentVerdict = 'APPROVED',
  overallVerdict = componentVerdict,
  findingText = '',
  fix = 'N/A',
  planHash = planSha,
  commit = planCommit,
  evidence = cleanEvidence(),
} = {}) {
  return `# Automated Review — 023 round ${round}
Reviewed code SHA: ${codeSha}
Approved plan SHA256: ${planHash}
Approved plan commit: ${commit}
Reviewers: backend-code-reviewer

## backend-code-reviewer

## Review — export
${findingText}
${evidence}
Verdict: ${componentVerdict}

## Overall

Scope-Check: PASS - unplanned=none
AC-Coverage: PASS - verified=AC-001; missing=none
Fix-Disposition: ${fix}

- backend-code-reviewer: ${componentVerdict}

Verdict: ${overallVerdict}
`;
}

test('structured clean review parses all integrity fields', () => {
  const parsed = parseReviewArtifact(structuredReview());
  assert.equal(parsed.valid, true, parsed.errors.join('\n'));
  assert.equal(parsed.verdict.value, 'APPROVED');
  assert.equal(parsed.approvedPlanSha256, planSha);
  assert.deepEqual(parsed.acceptanceCoverage.verified, ['AC-001']);
  assert.equal(parsed.components[0].cleanPassEvidence.length, 5);
});

test('chore lane requires the paired explicit approved-plan sentinel', () => {
  const parsed = parseReviewArtifact(structuredReview({ planHash: 'N/A - chore lane', commit: 'N/A - chore lane' }));
  assert.equal(parsed.valid, true, parsed.errors.join('\n'));
  assert.equal(parsed.choreLane, true);
  const malformed = parseReviewArtifact(structuredReview({ planHash: 'N/A - chore lane' }));
  assert.equal(malformed.valid, false);
  assert(malformed.errors.some((error) => error.includes('both approved-plan fields')));
});

test('clean approval without evidence and a non-final verdict are malformed', () => {
  const noEvidence = parseReviewArtifact(structuredReview({ evidence: '' }));
  assert(noEvidence.errors.some((error) => error.includes('Clean-Pass Evidence')));
  const trailing = parseReviewArtifact(`${structuredReview()}trailing prose\n`);
  assert(trailing.errors.some((error) => error.includes('final non-empty line')));
});

test('structured identity headers must each appear exactly once', () => {
  const duplicated = parseReviewArtifact(structuredReview()
    .replace(`Reviewed code SHA: ${codeSha}`, `Reviewed code SHA: ${codeSha}\nReviewed code SHA: ${codeSha}`)
    .replace('Reviewers: backend-code-reviewer', 'Reviewers: backend-code-reviewer\nReviewers: backend-code-reviewer'));
  assert(duplicated.errors.some((error) => error.includes('exactly one valid Reviewed code SHA')));
  assert(duplicated.errors.some((error) => error.includes('exactly one Reviewers line')));

  const misplacedDuplicates = parseReviewArtifact(structuredReview().replace(
    'Scope-Check: PASS - unplanned=none',
    `Reviewed code SHA: ${codeSha}
Approved plan SHA256: ${planSha}
Approved plan commit: ${planCommit}
Reviewers: backend-code-reviewer

## backend-code-reviewer

Scope-Check: PASS - unplanned=none`,
  ));
  assert(misplacedDuplicates.errors.some((error) => error.includes('exactly one valid Reviewed code SHA')));
  assert(misplacedDuplicates.errors.some((error) => error.includes('exactly one Approved plan SHA256')));
  assert(misplacedDuplicates.errors.some((error) => error.includes('exactly one Approved plan commit')));
  assert(misplacedDuplicates.errors.some((error) => error.includes('exactly one Reviewers line')));
  assert(misplacedDuplicates.errors.some((error) => error.includes('exactly one component section')));
});

test('structured controls reject status/list contradictions', () => {
  const scope = parseReviewArtifact(structuredReview().replace('Scope-Check: PASS - unplanned=none', 'Scope-Check: PASS - unplanned=src/extra.mjs'));
  assert(scope.errors.some((error) => error.includes('Scope-Check PASS requires')));
  const coverage = parseReviewArtifact(structuredReview().replace('AC-Coverage: PASS - verified=AC-001; missing=none', 'AC-Coverage: FAIL - verified=AC-001; missing=none'));
  assert(coverage.errors.some((error) => error.includes('AC-Coverage FAIL requires')));
  const overlap = parseReviewArtifact(structuredReview().replace('AC-Coverage: PASS - verified=AC-001; missing=none', 'AC-Coverage: FAIL - verified=AC-001; missing=AC-001'));
  assert(overlap.errors.some((error) => error.includes('both verified and missing')));
});

test('structured reviewer headers must be in deterministic name order', () => {
  const source = structuredReview()
    .replace('Reviewers: backend-code-reviewer', 'Reviewers: general-code-reviewer, backend-code-reviewer')
    .replace('## backend-code-reviewer', `## general-code-reviewer\n\n## Review — export\n${cleanEvidence()}Verdict: APPROVED\n\n## backend-code-reviewer`)
    .replace('- backend-code-reviewer: APPROVED', '- general-code-reviewer: APPROVED\n- backend-code-reviewer: APPROVED');
  const parsed = parseReviewArtifact(source);
  assert(parsed.errors.some((error) => error.includes('deterministic reviewer-name order')));
});

test('blocked finding IDs reconcile across rounds', () => {
  const first = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001: bug',
    evidence: '',
  }));
  assert.equal(first.valid, true, first.errors.join('\n'));
  const second = parseReviewArtifact(structuredReview({
    round: 2,
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001 [fixed]: repaired.\n- MF-backend-002 [new]: regression.',
    fix: 'fixed=MF-backend-001; persists=none; new=MF-backend-002',
    evidence: '',
  }), { previous: first });
  assert.equal(second.valid, true, second.errors.join('\n'));
  assert.deepEqual(second.currentFindingIds, ['MF-backend-002']);
  assert.deepEqual(reviewConvergence(first, second), {
    action: 'escalate',
    reason: 'non-decreasing-must-fix-count',
    consumesRound: true,
  });
});

test('finding IDs stay in the reviewer namespace and later dispositions are explicit', () => {
  const foreign = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-general-001: bug',
    evidence: '',
  }));
  assert(foreign.errors.some((error) => error.includes('outside its MF-backend-NNN namespace')));

  const first = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001: bug',
    evidence: '',
  }));
  const implicit = parseReviewArtifact(structuredReview({
    round: 2,
    componentVerdict: 'APPROVED',
    overallVerdict: 'APPROVED',
    findingText: '- MF-backend-001: repaired.',
    fix: 'fixed=MF-backend-001; persists=none; new=none',
  }), { previous: first });
  assert(implicit.errors.some((error) => error.includes('must be marked [fixed]')));
});

test('missing prior disposition is malformed and decreasing count can continue', () => {
  const prior = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED — 2 MUST FIX',
    overallVerdict: 'BLOCKED — 2 MUST FIX',
    findingText: '- MF-backend-001: bug\n- MF-backend-002: bug',
    evidence: '',
  }));
  const bad = parseReviewArtifact(structuredReview({
    round: 2,
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001 [persists]: still broken',
    fix: 'fixed=none; persists=MF-backend-001; new=none',
    evidence: '',
  }), { previous: prior });
  assert.equal(bad.valid, false);
  assert(bad.errors.some((error) => error.includes('lack a disposition')));

  const good = parseReviewArtifact(structuredReview({
    round: 2,
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001 [persists]: still broken\n- MF-backend-002 [fixed]: repaired',
    fix: 'fixed=MF-backend-002; persists=MF-backend-001; new=none',
    evidence: '',
  }), { previous: prior });
  assert.equal(good.valid, true, good.errors.join('\n'));
  assert.equal(reviewConvergence(prior, good).action, 'fix-and-review');
});

test('aggregate verdict and legacy compatibility remain stable', () => {
  assert.equal(aggregateVerdict(['APPROVED — 2 NIT', 'BLOCKED — 1 MUST FIX']), 'BLOCKED — 1 MUST FIX');
  const legacy = parseReviewArtifact('review body\nVerdict: APPROVED\n');
  assert.equal(legacy.version, 'legacy');
  assert.equal(legacy.valid, true);
  assert.equal(legacy.verdict.value, 'APPROVED');
  const aggregate = parseReviewArtifact(`# Automated Review — 023 round 1
Reviewed code SHA: ${codeSha}
Reviewers: backend-code-reviewer

## backend-code-reviewer
Verdict: APPROVED

## Overall
- backend-code-reviewer: APPROVED

Verdict: APPROVED
`);
  assert.equal(aggregate.version, 'legacy');
  assert.equal(aggregate.valid, true, aggregate.errors.join('\n'));
});

test('review convergence handles malformed retries, approval, and the round cap', () => {
  const prior = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001: bug',
    evidence: '',
  }));
  assert.equal(prior.valid, true, prior.errors.join('\n'));

  const evidencelessCleanPass = parseReviewArtifact(structuredReview({
    round: 2,
    findingText: '- MF-backend-001 [fixed]: repaired.',
    fix: 'fixed=MF-backend-001; persists=none; new=none',
    evidence: '',
  }), { previous: prior });
  assert.equal(evidencelessCleanPass.valid, false);
  assert.deepEqual(reviewConvergence(prior, evidencelessCleanPass), { action: 'malformed-retry', consumesRound: false });

  const approved = parseReviewArtifact(structuredReview({
    round: 2,
    findingText: '- MF-backend-001 [fixed]: repaired.',
    fix: 'fixed=MF-backend-001; persists=none; new=none',
  }), { previous: prior });
  assert.equal(approved.valid, true, approved.errors.join('\n'));
  assert.deepEqual(reviewConvergence(prior, approved), { action: 'approved', consumesRound: true });

  const first = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED — 2 MUST FIX',
    overallVerdict: 'BLOCKED — 2 MUST FIX',
    findingText: '- MF-backend-001: bug\n- MF-backend-002: bug',
    evidence: '',
  }));
  const second = parseReviewArtifact(structuredReview({
    round: 2,
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001 [persists]: still broken\n- MF-backend-002 [fixed]: repaired',
    fix: 'fixed=MF-backend-002; persists=MF-backend-001; new=none',
    evidence: '',
  }), { previous: first });
  assert.equal(second.valid, true, second.errors.join('\n'));
  const third = parseReviewArtifact(structuredReview({
    round: 3,
    componentVerdict: 'BLOCKED — 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001 [persists]: still broken',
    fix: 'fixed=none; persists=MF-backend-001; new=none',
    evidence: '',
  }), { previous: second });
  assert.equal(third.valid, true, third.errors.join('\n'));
  assert.deepEqual(reviewConvergence(second, third), { action: 'escalate', reason: 'round-cap', consumesRound: true });
});

function fillTemplate(template, reviewer = 'backend-code-reviewer', verdict = 'APPROVED') {
  return template
    .replace('<!-- component report -->', `${cleanEvidence()}\nVerdict: ${verdict}`)
    .replace(/^Scope-Check:$/m, 'Scope-Check: PASS - unplanned=none')
    .replace(/^AC-Coverage:$/m, 'AC-Coverage: PASS - verified=AC-001; missing=none')
    .replace(/^Fix-Disposition:$/m, 'Fix-Disposition: N/A')
    .replace(new RegExp(`^- ${reviewer}:$`, 'm'), `- ${reviewer}: ${verdict}`)
    .replace(/\nVerdict:\n$/, `\nVerdict: ${verdict}\n`);
}

function validateCli(contents, extraArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-review-artifact-'));
  const path = join(root, '023-round1.md');
  writeFileSync(path, contents);
  try {
    const stdout = execFileSync(process.execPath, [cli, 'review-artifact', '--validate', path, ...extraArgs], { cwd: root, encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '' };
  }
}

test('every dash spelling of a verdict parses and normalizes to an em dash', () => {
  for (const dash of ['-', '–', '—']) {
    assert.equal(normalizeReviewVerdict(`BLOCKED ${dash} 2 MUST FIX`), 'BLOCKED — 2 MUST FIX');
    assert.equal(normalizeReviewVerdict(`APPROVED${dash}1 NIT`), 'APPROVED — 1 NIT');
    const parsed = parseReviewArtifact(structuredReview({
      componentVerdict: `BLOCKED ${dash} 1 MUST FIX`,
      overallVerdict: `BLOCKED ${dash} 1 MUST FIX`,
      findingText: '- MF-backend-001: bug',
      evidence: '',
    }));
    assert.equal(parsed.valid, true, `${dash}: ${parsed.errors.join('\n')}`);
    assert.equal(parsed.verdict.value, 'BLOCKED — 1 MUST FIX');
    assert.equal(parsed.components[0].verdict.value, 'BLOCKED — 1 MUST FIX');
  }
  assert.equal(normalizeReviewVerdict('BLOCKED / 1 MUST FIX'), undefined);
  assert.equal(normalizeReviewVerdict('BLOCKED — 0 MUST FIX'), undefined);
  assert.equal(aggregateVerdict(['APPROVED - 2 NIT', 'BLOCKED – 1 MUST FIX']), 'BLOCKED — 1 MUST FIX');
});

test('a component and its Overall summary may disagree on the dash but not the verdict', () => {
  const mixed = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED - 1 MUST FIX',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
    findingText: '- MF-backend-001: bug',
    evidence: '',
  }).replace('- backend-code-reviewer: BLOCKED - 1 MUST FIX', '- backend-code-reviewer: BLOCKED – 1 MUST FIX'));
  assert.equal(mixed.valid, true, mixed.errors.join('\n'));

  const disagreeing = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED - 2 MUST FIX',
    overallVerdict: 'BLOCKED — 2 MUST FIX',
    findingText: '- MF-backend-001: bug\n- MF-backend-002: bug',
    evidence: '',
  }).replace('- backend-code-reviewer: BLOCKED - 2 MUST FIX', '- backend-code-reviewer: BLOCKED – 1 MUST FIX'));
  assert.equal(disagreeing.valid, false);
  assert(disagreeing.errors.some((error) => error.includes('disagrees with its component verdict')));
});

test('loosening the dash does not loosen count reconciliation', () => {
  const undercounted = parseReviewArtifact(structuredReview({
    componentVerdict: 'BLOCKED - 1 MUST FIX',
    overallVerdict: 'BLOCKED - 1 MUST FIX',
    findingText: '- MF-backend-001: bug\n- MF-backend-002: bug',
    evidence: '',
  }));
  assert.equal(undercounted.valid, false);
  assert(undercounted.errors.some((error) => error.includes('does not match actionable finding IDs')));
});

test('the template pre-fills only mechanically known identity', () => {
  const template = renderReviewTemplate({
    number: '23',
    round: 2,
    reviewedCodeSha: codeSha,
    approvedPlanSha256: planSha,
    approvedPlanCommit: planCommit,
    reviewers: ['general-code-reviewer', 'backend-code-reviewer'],
  });
  assert.match(template, /^# Automated Review - 023 round 2$/m);
  assert.match(template, /^Reviewers: backend-code-reviewer, general-code-reviewer$/m);
  // Inert: no verdict, no finding, no control-line value is manufactured.
  assert.match(template, /^Scope-Check:$/m);
  assert.match(template, /^AC-Coverage:$/m);
  assert.match(template, /^Fix-Disposition:$/m);
  assert.match(template, /^Verdict:$/m);
  assert.equal(/\b(?:APPROVED|BLOCKED|PASS|FAIL|N\/A|MF-)/.test(template), false);

  const parsed = parseReviewArtifact(template);
  assert.equal(parsed.number, '023');
  assert.equal(parsed.round, 2);
  assert.equal(parsed.reviewedCodeSha, codeSha);
  assert.equal(parsed.approvedPlanSha256, planSha);
  assert.equal(parsed.approvedPlanCommit, planCommit);
  assert.deepEqual(parsed.reviewers, ['backend-code-reviewer', 'general-code-reviewer']);
  assert.equal(parsed.valid, false, 'an unfilled skeleton is not a valid review');
});

test('filled template output round-trips through the parser', () => {
  const template = renderReviewTemplate({
    number: '023',
    round: 1,
    reviewedCodeSha: codeSha,
    approvedPlanSha256: planSha,
    approvedPlanCommit: planCommit,
    reviewers: ['backend-code-reviewer'],
  });
  const parsed = parseReviewArtifact(fillTemplate(template));
  assert.equal(parsed.valid, true, parsed.errors.join('\n'));
  assert.equal(parsed.verdict.value, 'APPROVED');
  assert.equal(parsed.choreLane, false);
  assert.equal(reviewConvergence(undefined, parsed).action, 'approved');
});

test('the template carries the chore sentinel and rejects partial identity', () => {
  const chore = renderReviewTemplate({
    number: '023',
    round: 1,
    reviewedCodeSha: codeSha,
    approvedPlanSha256: CHORE_LANE_SENTINEL,
    approvedPlanCommit: CHORE_LANE_SENTINEL,
    reviewers: ['backend-code-reviewer'],
  });
  const parsed = parseReviewArtifact(fillTemplate(chore));
  assert.equal(parsed.valid, true, parsed.errors.join('\n'));
  assert.equal(parsed.choreLane, true);

  const base = { number: '023', round: 1, reviewedCodeSha: codeSha, approvedPlanSha256: planSha, approvedPlanCommit: planCommit, reviewers: ['backend-code-reviewer'] };
  assert.throws(() => renderReviewTemplate({ ...base, approvedPlanSha256: null }), /approved plan SHA-256/);
  assert.throws(() => renderReviewTemplate({ ...base, approvedPlanCommit: null }), /approved plan commit/);
  assert.throws(() => renderReviewTemplate({ ...base, approvedPlanCommit: CHORE_LANE_SENTINEL }), /both approved-plan fields/);
  assert.throws(() => renderReviewTemplate({ ...base, reviewedCodeSha: 'HEAD' }), /reviewed code SHA/);
  assert.throws(() => renderReviewTemplate({ ...base, round: 0 }), /positive integer round/);
  assert.throws(() => renderReviewTemplate({ ...base, reviewers: [] }), /at least one reviewer/);
  assert.throws(() => renderReviewTemplate({ ...base, reviewers: ['a', 'a'] }), /must be unique/);
});

test('every failure carries the line it was found on', () => {
  const parsed = parseReviewArtifact(structuredReview({
    componentVerdict: 'APPROVED',
    overallVerdict: 'BLOCKED — 1 MUST FIX',
  }).replace('Scope-Check: PASS - unplanned=none', 'Scope-Check: nonsense'));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.errors.length, parsed.diagnostics.length);
  assert.deepEqual(parsed.diagnostics.map((entry) => entry.message), parsed.errors);
  assert(parsed.diagnostics.length >= 2, 'reports every failure, not just the first');
  assert(parsed.diagnostics.every((entry) => Number.isInteger(entry.line) && entry.line > 0), JSON.stringify(parsed.diagnostics));

  const lines = structuredReview().split('\n');
  const scopeDiagnostic = parsed.diagnostics.find((entry) => entry.message.includes('Scope-Check'));
  assert.equal(lines[scopeDiagnostic.line - 1], 'Scope-Check: PASS - unplanned=none');
});

test('--validate rejects missing, duplicate and non-final verdict lines with line numbers', () => {
  const valid = validateCli(structuredReview());
  assert.equal(valid.status, 0, valid.stdout);
  assert.match(valid.stdout, /valid \(structured, round 1\)/);
  assert.match(valid.stdout, /convergence: approved/);

  const missing = validateCli(structuredReview().replace(/\nVerdict: APPROVED\n$/, '\n'));
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /023-round1\.md:\d+: Overall must contain exactly one Verdict line\./);
  assert.match(missing.stdout, /Overall Verdict must be the final non-empty line\./);

  const duplicated = validateCli(structuredReview().replace(/Verdict: APPROVED\n$/, 'Verdict: APPROVED\nVerdict: APPROVED\n'));
  assert.equal(duplicated.status, 1);
  assert.match(duplicated.stdout, /023-round1\.md:\d+: Overall must contain exactly one Verdict line\./);

  const trailing = validateCli(`${structuredReview()}trailing prose\n`);
  assert.equal(trailing.status, 1);
  assert.match(trailing.stdout, /023-round1\.md:\d+: Overall Verdict must be the final non-empty line\./);

  const json = validateCli(structuredReview().replace('Scope-Check: PASS - unplanned=none', 'Scope-Check: nonsense'), ['--json']);
  assert.equal(json.status, 1);
  const report = JSON.parse(json.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.round, 1);
  assert(report.diagnostics.every((entry) => entry.line > 0));
  assert.equal(report.convergence.action, 'malformed-retry');
});

test('--validate accepts a hyphen verdict without a retry', () => {
  const hyphenated = validateCli(structuredReview({
    componentVerdict: 'BLOCKED - 1 MUST FIX',
    overallVerdict: 'BLOCKED - 1 MUST FIX',
    findingText: '- MF-backend-001: bug',
    evidence: '',
  }));
  assert.equal(hyphenated.status, 0, hyphenated.stdout);
  assert.match(hyphenated.stdout, /verdict: BLOCKED — 1 MUST FIX/);
});
