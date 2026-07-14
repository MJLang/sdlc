export const VALID_REVIEW_VERDICT = /^(?:APPROVED(?: — [1-9]\d* NIT)?|BLOCKED — [1-9]\d* MUST FIX)$/;

function parseVerdict(value) {
  const verdict = String(value ?? '').trim();
  if (!VALID_REVIEW_VERDICT.test(verdict)) return undefined;
  const blocked = verdict.match(/^BLOCKED — ([1-9]\d*) MUST FIX$/);
  const nits = verdict.match(/^APPROVED — ([1-9]\d*) NIT$/);
  return {
    value: verdict,
    approved: !blocked,
    mustFixCount: blocked ? Number(blocked[1]) : 0,
    nitCount: nits ? Number(nits[1]) : 0,
  };
}

export function aggregateVerdict(componentVerdicts) {
  const parsed = componentVerdicts.map(parseVerdict);
  if (parsed.some((verdict) => !verdict)) return undefined;
  const mustFix = parsed.reduce((sum, verdict) => sum + verdict.mustFixCount, 0);
  const nits = parsed.reduce((sum, verdict) => sum + verdict.nitCount, 0);
  if (mustFix) return `BLOCKED — ${mustFix} MUST FIX`;
  if (nits) return `APPROVED — ${nits} NIT`;
  return 'APPROVED';
}

function unique(values) {
  return [...new Set(values)];
}

function listValue(value, pattern) {
  const trimmed = value.trim();
  if (trimmed === 'none') return [];
  const items = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length && items.every((item) => pattern.test(item)) && unique(items).length === items.length
    ? items
    : undefined;
}

function parseStructuredOverall(section, round, errors) {
  const scopeLines = section.match(/^Scope-Check:[ \t]*(.+)$/gm) ?? [];
  const acLines = section.match(/^AC-Coverage:[ \t]*(.+)$/gm) ?? [];
  const fixLines = section.match(/^Fix-Disposition:[ \t]*(.+)$/gm) ?? [];
  if (scopeLines.length !== 1) errors.push('Overall must contain exactly one Scope-Check line.');
  if (acLines.length !== 1) errors.push('Overall must contain exactly one AC-Coverage line.');
  if (fixLines.length !== 1) errors.push('Overall must contain exactly one Fix-Disposition line.');

  let scope;
  const scopeMatch = scopeLines[0]?.match(/^Scope-Check:[ \t]*(PASS|FAIL)[ \t]+-[ \t]+unplanned=(.+)$/);
  if (scopeMatch) {
    const unplanned = listValue(scopeMatch[2], /^(?!\s)[^,]+$/);
    if (!unplanned) errors.push('Scope-Check has an invalid unplanned path list.');
    else scope = { status: scopeMatch[1], unplanned };
  } else if (scopeLines.length === 1) errors.push('Scope-Check does not match the required grammar.');

  let acceptanceCoverage;
  const acMatch = acLines[0]?.match(/^AC-Coverage:[ \t]*(PASS|FAIL)[ \t]+-[ \t]+verified=([^;]+);[ \t]*missing=(.+)$/);
  if (acMatch) {
    const verified = listValue(acMatch[2], /^AC-\d{3}$/);
    const missing = listValue(acMatch[3], /^AC-\d{3}$/);
    if (!verified || !missing) errors.push('AC-Coverage has an invalid acceptance-ID list.');
    else acceptanceCoverage = { status: acMatch[1], verified, missing };
  } else if (acLines.length === 1) errors.push('AC-Coverage does not match the required grammar.');

  let fixDisposition;
  const fixValue = fixLines[0]?.replace(/^Fix-Disposition:[ \t]*/, '').trim();
  if (fixValue === 'N/A') {
    fixDisposition = { kind: 'not-applicable', fixed: [], persists: [], new: [] };
    if (round !== 1) errors.push('Fix-Disposition may be N/A only in round 1.');
  } else if (fixValue !== undefined) {
    const match = fixValue.match(/^fixed=([^;]+);[ \t]*persists=([^;]+);[ \t]*new=(.+)$/);
    if (!match) errors.push('Fix-Disposition does not match the required grammar.');
    else {
      const findingPattern = /^MF-[a-z0-9][a-z0-9-]*-\d{3}$/i;
      const fixed = listValue(match[1], findingPattern);
      const persists = listValue(match[2], findingPattern);
      const fresh = listValue(match[3], findingPattern);
      if (!fixed || !persists || !fresh) errors.push('Fix-Disposition has an invalid finding-ID list.');
      else {
        const combined = [...fixed, ...persists, ...fresh];
        if (unique(combined).length !== combined.length) errors.push('A finding ID appears in more than one Fix-Disposition bucket.');
        fixDisposition = { kind: 'disposition', fixed, persists, new: fresh };
        if (round === 1) errors.push('Round 1 Fix-Disposition must be N/A.');
      }
    }
  }

  return { scope, acceptanceCoverage, fixDisposition };
}

function componentSlices(prefix, reviewers, errors, contents = prefix) {
  const markers = [];
  for (const reviewer of reviewers) {
    const escaped = reviewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^##[ \\t]+${escaped}[ \\t]*$`, 'gm');
    const matches = [...prefix.matchAll(pattern)];
    const allMatches = [...contents.matchAll(new RegExp(pattern.source, pattern.flags))];
    if (matches.length !== 1 || allMatches.length !== 1) {
      errors.push(`Expected exactly one component section for ${reviewer}.`);
      continue;
    }
    markers.push({ reviewer, index: matches[0].index, headingLength: matches[0][0].length });
  }
  markers.sort((a, b) => a.index - b.index);
  if (markers.map((marker) => marker.reviewer).join(',') !== reviewers.join(',')) {
    errors.push('Component sections are not in deterministic reviewer-name order.');
  }
  return markers.map((marker, index) => ({
    reviewer: marker.reviewer,
    body: prefix.slice(marker.index + marker.headingLength, markers[index + 1]?.index ?? prefix.length).replace(/^\n/, ''),
  }));
}

function cleanPassSurfaces(body) {
  const marker = body.search(/^#{2,6}[ \t]+Clean-Pass Evidence[ \t]*$/mi);
  if (marker < 0) return [];
  const evidence = body.slice(marker).toLowerCase();
  const checks = [
    ['ticket-and-acs', /ticket[\s\S]{0,160}\bac(?:ceptance)?\b|\bacs?\b/],
    ['plan-and-deviations', /plan[\s\S]{0,160}deviation|plan steps?/],
    ['repository-conventions', /convention|canonical sibling|repository sibling/],
    ['tests-and-failure-paths', /tests?[\s\S]{0,160}failure|failure paths?/],
    ['risk-surfaces', /security|data|performance|accessibility|operational|risk surface/],
  ];
  return checks.filter(([, pattern]) => pattern.test(evidence)).map(([name]) => name);
}

function parseComponents(prefix, reviewers, errors, contents) {
  const sections = componentSlices(prefix, reviewers, errors, contents);
  return sections.map(({ reviewer, body }) => {
    const lines = body.match(/^Verdict:[ \t]*(.+)[ \t]*$/gm) ?? [];
    if (lines.length !== 1) errors.push(`${reviewer} must contain exactly one component Verdict line.`);
    const verdict = parseVerdict(lines[0]?.replace(/^Verdict:[ \t]*/, ''));
    if (lines.length === 1 && !verdict) errors.push(`${reviewer} has an invalid component verdict.`);
    const findingIds = unique([...body.matchAll(/\bMF-[a-z0-9][a-z0-9-]*-\d{3}\b/gi)].map((match) => match[0]));
    const evidenceSurfaces = verdict?.approved ? cleanPassSurfaces(body) : [];
    if (verdict?.approved && evidenceSurfaces.length !== 5) {
      errors.push(`${reviewer} approved without Clean-Pass Evidence covering all five required surfaces.`);
    }
    return { reviewer, body, verdict, findingIds, cleanPassEvidence: evidenceSurfaces };
  });
}

function reviewerFindingPrefix(reviewer) {
  const lane = reviewer.replace(/-code-reviewer$/i, '').replace(/-reviewer$/i, '').toLowerCase();
  return `MF-${lane}-`;
}

function requiresDispositionTag(component, id, disposition, errors) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`\\b${escaped}\\b[ \\t]*\\[${disposition}\\]`, 'i').test(component.body)) {
    errors.push(`${id} must be marked [${disposition}] in ${component.reviewer}.`);
  }
}

function legacyReview(contents) {
  const verdictLines = contents.match(/^Verdict:[ \t]*(.+)[ \t]*$/gm) ?? [];
  const verdict = parseVerdict(verdictLines.at(-1)?.replace(/^Verdict:[ \t]*/, ''));
  return {
    version: 'legacy',
    valid: Boolean(verdict),
    verdict,
    errors: verdict ? [] : ['Legacy review has no valid verdict.'],
    warnings: ['Legacy review artifact: structured integrity checks are unavailable.'],
  };
}

function legacyAggregateReview(contents, overallMarker) {
  const errors = [];
  const warnings = ['Legacy aggregate review artifact: approved-plan and structured integrity checks are unavailable.'];
  const prefix = contents.slice(0, overallMarker.index);
  const overall = contents.slice(overallMarker.index + overallMarker[0].length).replace(/^\n/, '');
  const reviewedCodeSha = prefix.match(/^Reviewed code SHA:[ \t]*([0-9a-f]{7,64})[ \t]*$/m)?.[1];
  const reviewers = prefix.match(/^Reviewers:[ \t]*(.+)[ \t]*$/m)?.[1]
    ?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
  if (!reviewedCodeSha) errors.push('Legacy aggregate review has no valid Reviewed code SHA.');
  if (!reviewers.length || unique(reviewers).length !== reviewers.length) errors.push('Legacy aggregate review has no valid reviewer list.');
  const overallLines = overall.match(/^Verdict:[ \t]*(.+)[ \t]*$/gm) ?? [];
  if (overallLines.length !== 1) errors.push('Legacy Overall must contain exactly one Verdict line.');
  const verdict = parseVerdict(overallLines[0]?.replace(/^Verdict:[ \t]*/, ''));
  if (overallLines.length === 1 && !verdict) errors.push('Legacy Overall Verdict is malformed.');
  if (!contents.trimEnd().split('\n').at(-1)?.startsWith('Verdict:')) errors.push('Legacy Overall Verdict must be the final non-empty line.');
  const componentLines = prefix.match(/^Verdict:[ \t]*(.+)[ \t]*$/gm) ?? [];
  const componentVerdicts = componentLines.map((line) => line.replace(/^Verdict:[ \t]*/, '').trim());
  if (componentVerdicts.length !== reviewers.length || componentVerdicts.some((item) => !parseVerdict(item))) {
    errors.push('Legacy component verdict count/grammar does not match Reviewers.');
  } else if (verdict && aggregateVerdict(componentVerdicts) !== verdict.value) {
    errors.push('Legacy Overall Verdict does not equal the aggregate component verdict.');
  }
  return {
    version: 'legacy',
    valid: errors.length === 0,
    reviewedCodeSha,
    reviewers,
    verdict,
    errors,
    warnings,
  };
}

export function parseReviewArtifact(value, { previous } = {}) {
  const contents = String(value).replace(/\r\n?/g, '\n');
  const overallMarkers = [...contents.matchAll(/^## Overall[ \t]*$/gm)];
  if (!overallMarkers.length) return legacyReview(contents);
  const hasStructuredContract = /^Approved plan SHA256:/m.test(contents)
    || /^Scope-Check:/m.test(contents)
    || /^AC-Coverage:/m.test(contents)
    || /^Fix-Disposition:/m.test(contents);
  if (!hasStructuredContract) return legacyAggregateReview(contents, overallMarkers.at(-1));

  const errors = [];
  const warnings = [];
  if (overallMarkers.length !== 1) errors.push('Review artifact must contain exactly one Overall section.');
  const marker = overallMarkers.at(-1);
  const prefix = contents.slice(0, marker.index);
  const overall = contents.slice(marker.index + marker[0].length).replace(/^\n/, '');
  const titleLines = [...contents.matchAll(/^# Automated Review\s+[-—]\s+(\d+)[ \t]+round[ \t]+(\d+)[ \t]*$/gm)];
  const title = titleLines[0];
  const number = title?.[1];
  const round = title ? Number(title[2]) : undefined;
  if (titleLines.length !== 1) errors.push('Review artifact must contain exactly one valid automated-review title.');

  const reviewedCodeLines = contents.match(/^Reviewed code SHA:[^\n]*$/gm) ?? [];
  const reviewedCodePrefixLines = prefix.match(/^Reviewed code SHA:[^\n]*$/gm) ?? [];
  const reviewedCodeSha = reviewedCodePrefixLines[0]?.match(/^Reviewed code SHA:[ \t]*([0-9a-f]{7,64})[ \t]*$/)?.[1];
  if (reviewedCodeLines.length !== 1 || reviewedCodePrefixLines.length !== 1 || !reviewedCodeSha) errors.push('Expected exactly one valid Reviewed code SHA.');

  const planHashLines = contents.match(/^Approved plan SHA256:[^\n]*$/gm) ?? [];
  const planCommitLines = contents.match(/^Approved plan commit:[^\n]*$/gm) ?? [];
  const planHashPrefixLines = prefix.match(/^Approved plan SHA256:[^\n]*$/gm) ?? [];
  const planCommitPrefixLines = prefix.match(/^Approved plan commit:[^\n]*$/gm) ?? [];
  const planHashValue = planHashPrefixLines[0]?.replace(/^Approved plan SHA256:[ \t]*/, '').trim();
  const planCommitValue = planCommitPrefixLines[0]?.replace(/^Approved plan commit:[ \t]*/, '').trim();
  if (planHashLines.length !== 1 || planHashPrefixLines.length !== 1) errors.push('Review artifact must contain exactly one Approved plan SHA256 line.');
  if (planCommitLines.length !== 1 || planCommitPrefixLines.length !== 1) errors.push('Review artifact must contain exactly one Approved plan commit line.');
  const choreSentinel = planHashValue === 'N/A - chore lane' && planCommitValue === 'N/A - chore lane';
  const approvedPlanSha256 = /^[0-9a-f]{64}$/.test(planHashValue ?? '') ? planHashValue : undefined;
  const approvedPlanCommit = /^[0-9a-f]{7,64}$/.test(planCommitValue ?? '') ? planCommitValue : undefined;
  if (!choreSentinel && !approvedPlanSha256) errors.push('Missing or invalid Approved plan SHA256.');
  if (!choreSentinel && !approvedPlanCommit) errors.push('Missing or invalid Approved plan commit.');
  if ((planHashValue === 'N/A - chore lane') !== (planCommitValue === 'N/A - chore lane')) {
    errors.push('Chore review identity must use the sentinel in both approved-plan fields.');
  }

  const reviewerLines = contents.match(/^Reviewers:[^\n]*$/gm) ?? [];
  const reviewerPrefixLines = prefix.match(/^Reviewers:[^\n]*$/gm) ?? [];
  const reviewerLine = reviewerPrefixLines[0]?.replace(/^Reviewers:[ \t]*/, '').trim();
  const reviewers = reviewerLine?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
  if (reviewerLines.length !== 1 || reviewerPrefixLines.length !== 1) errors.push('Review artifact must contain exactly one Reviewers line.');
  if (!reviewers.length || unique(reviewers).length !== reviewers.length) errors.push('Reviewers must be a non-empty unique list.');
  if ([...reviewers].sort().join(',') !== reviewers.join(',')) errors.push('Reviewer list must use deterministic reviewer-name order.');

  const components = parseComponents(prefix, reviewers, errors, contents);
  const componentFindingIds = components.flatMap((component) => component.findingIds);
  if (unique(componentFindingIds).length !== componentFindingIds.length) errors.push('A stable finding ID appears in more than one component report.');
  for (const component of components) {
    const prefixValue = reviewerFindingPrefix(component.reviewer);
    const foreign = component.findingIds.filter((id) => !id.startsWith(prefixValue));
    if (foreign.length) errors.push(`${component.reviewer} contains finding IDs outside its ${prefixValue}NNN namespace: ${foreign.join(', ')}.`);
  }
  const verdictLines = overall.match(/^Verdict:[ \t]*(.+)[ \t]*$/gm) ?? [];
  if (verdictLines.length !== 1) errors.push('Overall must contain exactly one Verdict line.');
  const verdict = parseVerdict(verdictLines[0]?.replace(/^Verdict:[ \t]*/, ''));
  if (verdictLines.length === 1 && !verdict) errors.push('Overall Verdict is malformed.');
  const finalLine = contents.trimEnd().split('\n').at(-1);
  if (!finalLine?.startsWith('Verdict:')) errors.push('Overall Verdict must be the final non-empty line.');

  const componentVerdicts = components.map((component) => component.verdict?.value).filter(Boolean);
  const expectedVerdict = componentVerdicts.length === reviewers.length ? aggregateVerdict(componentVerdicts) : undefined;
  if (verdict && expectedVerdict !== verdict.value) errors.push('Overall Verdict does not equal the aggregate component verdict.');

  for (const reviewer of reviewers) {
    const escaped = reviewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const summaries = [...overall.matchAll(new RegExp(`^-[ \\t]+${escaped}:[ \\t]+(.+)[ \\t]*$`, 'gm'))];
    if (summaries.length !== 1) errors.push(`Overall must summarize ${reviewer} exactly once.`);
    else {
      const component = components.find((item) => item.reviewer === reviewer);
      if (component?.verdict?.value !== summaries[0][1].trim()) errors.push(`Overall summary for ${reviewer} disagrees with its component verdict.`);
    }
  }

  const structured = parseStructuredOverall(overall, round, errors);
  if (structured.scope?.status === 'PASS' && structured.scope.unplanned.length) errors.push('Scope-Check PASS requires unplanned=none.');
  if (structured.scope?.status === 'FAIL' && !structured.scope.unplanned.length) errors.push('Scope-Check FAIL requires at least one unplanned path.');
  if (structured.acceptanceCoverage?.status === 'PASS' && structured.acceptanceCoverage.missing.length) errors.push('AC-Coverage PASS requires missing=none.');
  if (structured.acceptanceCoverage?.status === 'FAIL' && !structured.acceptanceCoverage.missing.length) errors.push('AC-Coverage FAIL requires at least one missing acceptance criterion.');
  const duplicatedCoverage = structured.acceptanceCoverage?.verified.filter((id) => structured.acceptanceCoverage.missing.includes(id)) ?? [];
  if (duplicatedCoverage.length) errors.push(`AC-Coverage IDs cannot be both verified and missing: ${duplicatedCoverage.join(', ')}.`);
  if (verdict?.approved && structured.scope?.status !== 'PASS') errors.push('An approved review requires Scope-Check: PASS.');
  if (verdict?.approved && structured.scope?.unplanned.length) errors.push('An approved review cannot contain unplanned scope.');
  if (verdict?.approved && structured.acceptanceCoverage?.status !== 'PASS') errors.push('An approved review requires AC-Coverage: PASS.');
  if (verdict?.approved && structured.acceptanceCoverage?.missing.length) errors.push('An approved review cannot have missing acceptance criteria.');

  const currentFindingIds = structured.fixDisposition?.kind === 'disposition'
    ? [...structured.fixDisposition.persists, ...structured.fixDisposition.new]
    : unique(components.flatMap((component) => component.findingIds));
  if (verdict && verdict.mustFixCount !== unique(currentFindingIds).length) {
    errors.push(`Aggregate MUST FIX count (${verdict.mustFixCount}) does not match actionable finding IDs (${unique(currentFindingIds).length}).`);
  }
  if (round === 1) {
    for (const component of components.filter((item) => item.verdict?.mustFixCount)) {
      if (component.verdict.mustFixCount !== component.findingIds.length) {
        errors.push(`${component.reviewer} MUST FIX count does not match its stable finding IDs.`);
      }
    }
  }
  if (structured.fixDisposition?.kind === 'disposition') {
    const mentioned = new Set(components.flatMap((component) => component.findingIds));
    const classified = [
      ...structured.fixDisposition.fixed,
      ...structured.fixDisposition.persists,
      ...structured.fixDisposition.new,
    ];
    const missingFromReports = classified.filter((id) => !mentioned.has(id));
    const unclassified = [...mentioned].filter((id) => !classified.includes(id));
    if (missingFromReports.length) errors.push(`Fix-Disposition IDs missing from component reports: ${missingFromReports.join(', ')}.`);
    if (unclassified.length) errors.push(`Component finding IDs missing from Fix-Disposition: ${unclassified.join(', ')}.`);
    for (const component of components) {
      const actionable = [...structured.fixDisposition.persists, ...structured.fixDisposition.new].filter((id) => component.findingIds.includes(id));
      if (component.verdict && component.verdict.mustFixCount !== actionable.length) {
        errors.push(`${component.reviewer} MUST FIX count (${component.verdict.mustFixCount}) does not match its actionable disposition IDs (${actionable.length}).`);
      }
    }
    for (const [disposition, ids] of Object.entries({ fixed: structured.fixDisposition.fixed, persists: structured.fixDisposition.persists, new: structured.fixDisposition.new })) {
      for (const id of ids) {
        const component = components.find((item) => item.findingIds.includes(id));
        if (component) requiresDispositionTag(component, id, disposition, errors);
      }
    }
  }

  if (previous?.valid && structured.fixDisposition?.kind === 'disposition') {
    const prior = new Set(previous.currentFindingIds ?? []);
    const classifiedPrior = new Set([...structured.fixDisposition.fixed, ...structured.fixDisposition.persists]);
    const missing = [...prior].filter((id) => !classifiedPrior.has(id));
    const inventedPrior = [...classifiedPrior].filter((id) => !prior.has(id));
    const newButPrior = structured.fixDisposition.new.filter((id) => prior.has(id));
    if (missing.length) errors.push(`Prior findings lack a disposition: ${missing.join(', ')}.`);
    if (inventedPrior.length) errors.push(`Fixed/persists references non-prior findings: ${inventedPrior.join(', ')}.`);
    if (newButPrior.length) errors.push(`New bucket contains prior findings: ${newButPrior.join(', ')}.`);
  }

  return {
    version: 'structured',
    valid: errors.length === 0,
    number,
    round,
    reviewedCodeSha,
    approvedPlanSha256: choreSentinel ? null : approvedPlanSha256,
    approvedPlanCommit: choreSentinel ? null : approvedPlanCommit,
    choreLane: choreSentinel,
    reviewers,
    components,
    ...structured,
    verdict,
    currentFindingIds: unique(currentFindingIds),
    errors,
    warnings,
  };
}

export function reviewConvergence(previous, current, cap = 3) {
  if (!current?.valid || !current.verdict) return { action: 'malformed-retry', consumesRound: false };
  if (current.verdict.approved) return { action: 'approved', consumesRound: true };
  if (current.round >= cap) return { action: 'escalate', reason: 'round-cap', consumesRound: true };
  if (previous?.valid && current.verdict.mustFixCount >= previous.verdict.mustFixCount) {
    return { action: 'escalate', reason: 'non-decreasing-must-fix-count', consumesRound: true };
  }
  return { action: 'fix-and-review', consumesRound: true };
}
