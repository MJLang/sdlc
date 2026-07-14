import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateVerdict, parseReviewArtifact, reviewConvergence } from '../lib/review-artifact.mjs';

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
