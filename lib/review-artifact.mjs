// A verdict's separator is the one character an LLM cannot reliably control, so
// hyphen, en dash and em dash all parse and every write normalizes to U+2014.
// Structure — exactly one final verdict line, reconciled counts — stays strict.
const VERDICT_DASH = String.raw`[-–—]`;
const VERDICT_SEPARATOR = new RegExp(`\\s*${VERDICT_DASH}\\s*`);
export const REVIEW_VERDICT_DASH = ' — ';
export const CHORE_LANE_SENTINEL = 'N/A - chore lane';

// One grammar per identity value, shared by the reader and the writer so a
// template can never emit something `--validate` rejects.
const COMMIT_SHA_SOURCE = String.raw`[0-9a-f]{7,64}`;
const PLAN_SHA256_SOURCE = String.raw`[0-9a-f]{64}`;
const COMMIT_SHA = new RegExp(`^${COMMIT_SHA_SOURCE}$`);
const PLAN_SHA256 = new RegExp(`^${PLAN_SHA256_SOURCE}$`);

export const VALID_REVIEW_VERDICT = new RegExp(
  `^(?:APPROVED(?:\\s*${VERDICT_DASH}\\s*[1-9]\\d* NIT)?|BLOCKED\\s*${VERDICT_DASH}\\s*[1-9]\\d* MUST FIX)$`,
);

export function normalizeReviewVerdict(value) {
  const verdict = String(value ?? '').trim().replace(/[ \t]+/g, ' ');
  if (!VALID_REVIEW_VERDICT.test(verdict)) return undefined;
  return verdict.replace(VERDICT_SEPARATOR, REVIEW_VERDICT_DASH);
}

function parseVerdict(value) {
  const verdict = normalizeReviewVerdict(value);
  if (!verdict) return undefined;
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
  if (mustFix) return `BLOCKED${REVIEW_VERDICT_DASH}${mustFix} MUST FIX`;
  if (nits) return `APPROVED${REVIEW_VERDICT_DASH}${nits} NIT`;
  return 'APPROVED';
}

function unique(values) {
  return [...new Set(values)];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The one rule for reading a comma-separated reviewer list, shared by the
// parser and by the CLI's `--reviewers` flag so the two cannot drift.
export function parseReviewerList(value) {
  return String(value ?? '').split(',').map((name) => name.trim()).filter(Boolean);
}

// Every failure carries the line it was found on where one is determinable, so
// `sdlc review-artifact --validate` can report all of them at once with a
// location instead of one opaque sentence.
function createReporter(contents) {
  const diagnostics = [];
  const lineAt = (index) => (typeof index === 'number' && index >= 0
    ? contents.slice(0, Math.min(index, contents.length)).split('\n').length
    : null);
  const fail = (message, line = null) => {
    diagnostics.push({ message, line: typeof line === 'number' && line > 0 ? line : null });
  };
  fail.lineAt = lineAt;
  fail.lineOf = (pattern) => {
    const match = contents.match(pattern);
    return match ? lineAt(match.index) : null;
  };
  // Errors raised against a slice report the line in the whole artifact.
  fail.within = (offset) => (index) => (typeof index === 'number' ? lineAt(offset + index) : null);
  return { diagnostics, fail };
}

// `## Overall` splits every aggregate artifact in two. Both the structured and
// the legacy reader need the same four values from that split.
function sliceOverall(contents, marker, fail) {
  const start = marker.index + marker[0].length;
  const bodyStart = start + (contents.startsWith('\n', start) ? 1 : 0);
  return {
    prefix: contents.slice(0, marker.index),
    overall: contents.slice(bodyStart),
    lineIn: fail.within(bodyStart),
    headingLine: fail.lineAt(marker.index),
  };
}

function parseStructuredOverall(section, round, verdict, fail, lineIn) {
  const scopeLines = [...section.matchAll(/^Scope-Check:[ \t]*(.+)$/gm)];
  const acLines = [...section.matchAll(/^AC-Coverage:[ \t]*(.+)$/gm)];
  const fixLines = [...section.matchAll(/^Fix-Disposition:[ \t]*(.+)$/gm)];
  // A control line with no value after the colon — what an unfilled template
  // emits — matches nothing above, so fall back to locating the bare label.
  const lineOfControl = (matches, pattern) => lineIn(matches[0]?.index ?? Math.max(section.search(pattern), 0));
  const scopeLine = lineOfControl(scopeLines, /^Scope-Check:/m);
  const acLine = lineOfControl(acLines, /^AC-Coverage:/m);
  const fixLine = lineOfControl(fixLines, /^Fix-Disposition:/m);
  if (scopeLines.length !== 1) fail('Overall must contain exactly one Scope-Check line.', scopeLine);
  if (acLines.length !== 1) fail('Overall must contain exactly one AC-Coverage line.', acLine);
  if (fixLines.length !== 1) fail('Overall must contain exactly one Fix-Disposition line.', fixLine);

  let scope;
  const scopeMatch = scopeLines[0]?.[0].match(/^Scope-Check:[ \t]*(PASS|FAIL)[ \t]+-[ \t]+unplanned=(.+)$/);
  if (scopeMatch) {
    const unplanned = listValue(scopeMatch[2], /^(?!\s)[^,]+$/);
    if (!unplanned) fail('Scope-Check has an invalid unplanned path list.', scopeLine);
    else scope = { status: scopeMatch[1], unplanned };
  } else if (scopeLines.length === 1) fail('Scope-Check does not match the required grammar.', scopeLine);

  let acceptanceCoverage;
  const acMatch = acLines[0]?.[0].match(/^AC-Coverage:[ \t]*(PASS|FAIL)[ \t]+-[ \t]+verified=([^;]+);[ \t]*missing=(.+)$/);
  if (acMatch) {
    const verified = listValue(acMatch[2], /^AC-\d{3}$/);
    const missing = listValue(acMatch[3], /^AC-\d{3}$/);
    if (!verified || !missing) fail('AC-Coverage has an invalid acceptance-ID list.', acLine);
    else acceptanceCoverage = { status: acMatch[1], verified, missing };
  } else if (acLines.length === 1) fail('AC-Coverage does not match the required grammar.', acLine);

  let fixDisposition;
  const fixValue = fixLines[0]?.[0].replace(/^Fix-Disposition:[ \t]*/, '').trim();
  if (fixValue === 'N/A') {
    fixDisposition = { kind: 'not-applicable', fixed: [], persists: [], new: [] };
    if (round !== 1) fail('Fix-Disposition may be N/A only in round 1.', fixLine);
  } else if (fixValue !== undefined) {
    const match = fixValue.match(/^fixed=([^;]+);[ \t]*persists=([^;]+);[ \t]*new=(.+)$/);
    if (!match) fail('Fix-Disposition does not match the required grammar.', fixLine);
    else {
      const findingPattern = /^MF-[a-z0-9][a-z0-9-]*-\d{3}$/i;
      const fixed = listValue(match[1], findingPattern);
      const persists = listValue(match[2], findingPattern);
      const fresh = listValue(match[3], findingPattern);
      if (!fixed || !persists || !fresh) fail('Fix-Disposition has an invalid finding-ID list.', fixLine);
      else {
        const combined = [...fixed, ...persists, ...fresh];
        if (unique(combined).length !== combined.length) fail('A finding ID appears in more than one Fix-Disposition bucket.', fixLine);
        fixDisposition = { kind: 'disposition', fixed, persists, new: fresh };
        if (round === 1) fail('Round 1 Fix-Disposition must be N/A.', fixLine);
      }
    }
  }

  // These consistency checks read nothing but the three controls and the
  // aggregate verdict, so they belong where the control line numbers live.
  if (scope?.status === 'PASS' && scope.unplanned.length) fail('Scope-Check PASS requires unplanned=none.', scopeLine);
  if (scope?.status === 'FAIL' && !scope.unplanned.length) fail('Scope-Check FAIL requires at least one unplanned path.', scopeLine);
  if (acceptanceCoverage?.status === 'PASS' && acceptanceCoverage.missing.length) fail('AC-Coverage PASS requires missing=none.', acLine);
  if (acceptanceCoverage?.status === 'FAIL' && !acceptanceCoverage.missing.length) fail('AC-Coverage FAIL requires at least one missing acceptance criterion.', acLine);
  const duplicatedCoverage = acceptanceCoverage?.verified.filter((id) => acceptanceCoverage.missing.includes(id)) ?? [];
  if (duplicatedCoverage.length) fail(`AC-Coverage IDs cannot be both verified and missing: ${duplicatedCoverage.join(', ')}.`, acLine);
  if (verdict?.approved && scope?.status !== 'PASS') fail('An approved review requires Scope-Check: PASS.', scopeLine);
  if (verdict?.approved && scope?.unplanned.length) fail('An approved review cannot contain unplanned scope.', scopeLine);
  if (verdict?.approved && acceptanceCoverage?.status !== 'PASS') fail('An approved review requires AC-Coverage: PASS.', acLine);
  if (verdict?.approved && acceptanceCoverage?.missing.length) fail('An approved review cannot have missing acceptance criteria.', acLine);

  return { values: { scope, acceptanceCoverage, fixDisposition }, fixDispositionLine: fixLine };
}

function listValue(value, pattern) {
  const trimmed = value.trim();
  if (trimmed === 'none') return [];
  const items = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length && items.every((item) => pattern.test(item)) && unique(items).length === items.length
    ? items
    : undefined;
}

function componentSlices(prefix, reviewers, fail, contents) {
  const markers = [];
  for (const reviewer of reviewers) {
    const pattern = new RegExp(`^##[ \\t]+${escapeRegex(reviewer)}[ \\t]*$`, 'gm');
    const matches = [...prefix.matchAll(pattern)];
    const allMatches = [...contents.matchAll(new RegExp(pattern.source, pattern.flags))];
    if (matches.length !== 1 || allMatches.length !== 1) {
      fail(
        `Expected exactly one component section for ${reviewer}.`,
        fail.lineAt(matches[0]?.index ?? allMatches[0]?.index) ?? fail.lineOf(/^Reviewers:/m),
      );
      continue;
    }
    markers.push({ reviewer, index: matches[0].index, headingLength: matches[0][0].length });
  }
  markers.sort((a, b) => a.index - b.index);
  if (markers.map((marker) => marker.reviewer).join(',') !== reviewers.join(',')) {
    fail('Component sections are not in deterministic reviewer-name order.', fail.lineAt(markers[0]?.index) ?? fail.lineOf(/^Reviewers:/m));
  }
  return markers.map((marker, index) => {
    const start = marker.index + marker.headingLength;
    const bodyIndex = start + (prefix.startsWith('\n', start) ? 1 : 0);
    return {
      reviewer: marker.reviewer,
      body: prefix.slice(bodyIndex, markers[index + 1]?.index ?? prefix.length),
      headingIndex: marker.index,
      bodyIndex,
    };
  });
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

function parseComponents(prefix, reviewers, fail, contents) {
  const sections = componentSlices(prefix, reviewers, fail, contents);
  return sections.map(({ reviewer, body, headingIndex, bodyIndex }) => {
    const headingLine = fail.lineAt(headingIndex);
    const lineIn = fail.within(bodyIndex);
    const verdictMatches = [...body.matchAll(/^Verdict:[ \t]*(.+)[ \t]*$/gm)];
    if (verdictMatches.length !== 1) fail(`${reviewer} must contain exactly one component Verdict line.`, fail.lineAt(bodyIndex + (verdictMatches[0]?.index ?? 0)) ?? headingLine);
    const verdict = parseVerdict(verdictMatches[0]?.[0].replace(/^Verdict:[ \t]*/, ''));
    if (verdictMatches.length === 1 && !verdict) fail(`${reviewer} has an invalid component verdict.`, lineIn(verdictMatches[0].index));
    // Offsets, not line numbers: resolving a line is a whole-body scan, and
    // these are read only on the two failure paths that cite a finding.
    const findingOffsets = new Map();
    for (const match of body.matchAll(/\bMF-[a-z0-9][a-z0-9-]*-\d{3}\b/gi)) {
      if (!findingOffsets.has(match[0])) findingOffsets.set(match[0], match.index);
    }
    const findingIds = [...findingOffsets.keys()];
    const findingLine = (id) => (findingOffsets.has(id) ? lineIn(findingOffsets.get(id)) : null);
    const evidenceSurfaces = verdict?.approved ? cleanPassSurfaces(body) : [];
    if (verdict?.approved && evidenceSurfaces.length !== 5) {
      fail(`${reviewer} approved without Clean-Pass Evidence covering all five required surfaces.`, headingLine);
    }
    return { reviewer, body, verdict, findingIds, cleanPassEvidence: evidenceSurfaces, headingLine, findingLine };
  });
}

function reviewerFindingPrefix(reviewer) {
  const lane = reviewer.replace(/-code-reviewer$/i, '').replace(/-reviewer$/i, '').toLowerCase();
  return `MF-${lane}-`;
}

function requiresDispositionTag(component, id, disposition, fail) {
  if (!new RegExp(`\\b${escapeRegex(id)}\\b[ \\t]*\\[${disposition}\\]`, 'i').test(component.body)) {
    fail(`${id} must be marked [${disposition}] in ${component.reviewer}.`, component.findingLine(id) ?? component.headingLine);
  }
}

// `diagnostics` is the full record; `errors` is the message-only view every
// pre-existing consumer (doctor, guard, snapshot) already reads. Kept in step
// here so neither can drift from the other.
function withDiagnostics(result, diagnostics) {
  return { ...result, errors: diagnostics.map((entry) => entry.message), diagnostics };
}

function legacyReview(contents) {
  const { diagnostics, fail } = createReporter(contents);
  const verdictLines = [...contents.matchAll(/^Verdict:[ \t]*(.+)[ \t]*$/gm)];
  const last = verdictLines.at(-1);
  const verdict = parseVerdict(last?.[0].replace(/^Verdict:[ \t]*/, ''));
  if (!verdict) fail('Legacy review has no valid verdict.', fail.lineAt(last?.index));
  return withDiagnostics({
    version: 'legacy',
    valid: Boolean(verdict),
    verdict,
    warnings: ['Legacy review artifact: structured integrity checks are unavailable.'],
  }, diagnostics);
}

function legacyAggregateReview(contents, overallMarker) {
  const { diagnostics, fail } = createReporter(contents);
  const warnings = ['Legacy aggregate review artifact: approved-plan and structured integrity checks are unavailable.'];
  const { prefix, overall, lineIn, headingLine } = sliceOverall(contents, overallMarker, fail);
  const reviewedCodeSha = prefix.match(new RegExp(`^Reviewed code SHA:[ \\t]*(${COMMIT_SHA_SOURCE})[ \\t]*$`, 'm'))?.[1];
  const reviewers = parseReviewerList(prefix.match(/^Reviewers:[ \t]*(.+)[ \t]*$/m)?.[1]);
  if (!reviewedCodeSha) fail('Legacy aggregate review has no valid Reviewed code SHA.', fail.lineOf(/^Reviewed code SHA:/m));
  if (!reviewers.length || unique(reviewers).length !== reviewers.length) fail('Legacy aggregate review has no valid reviewer list.', fail.lineOf(/^Reviewers:/m));
  const overallLines = [...overall.matchAll(/^Verdict:[ \t]*(.+)[ \t]*$/gm)];
  const overallVerdictLine = overallLines[0] ? lineIn(overallLines[0].index) : headingLine;
  if (overallLines.length !== 1) fail('Legacy Overall must contain exactly one Verdict line.', overallVerdictLine);
  const verdict = parseVerdict(overallLines[0]?.[0].replace(/^Verdict:[ \t]*/, ''));
  if (overallLines.length === 1 && !verdict) fail('Legacy Overall Verdict is malformed.', overallVerdictLine);
  const tail = contents.trimEnd().split('\n');
  if (!tail.at(-1)?.startsWith('Verdict:')) fail('Legacy Overall Verdict must be the final non-empty line.', tail.length);
  const componentLines = [...prefix.matchAll(/^Verdict:[ \t]*(.+)[ \t]*$/gm)];
  const componentVerdicts = componentLines.map((line) => line[0].replace(/^Verdict:[ \t]*/, '').trim());
  if (componentVerdicts.length !== reviewers.length || componentVerdicts.some((item) => !parseVerdict(item))) {
    fail('Legacy component verdict count/grammar does not match Reviewers.', fail.lineAt(componentLines[0]?.index) ?? headingLine);
  } else if (verdict && aggregateVerdict(componentVerdicts) !== verdict.value) {
    fail('Legacy Overall Verdict does not equal the aggregate component verdict.', overallVerdictLine);
  }
  return withDiagnostics({
    version: 'legacy',
    valid: diagnostics.length === 0,
    reviewedCodeSha,
    reviewers,
    verdict,
    warnings,
  }, diagnostics);
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

  const { diagnostics, fail } = createReporter(contents);
  const warnings = [];
  if (overallMarkers.length !== 1) fail('Review artifact must contain exactly one Overall section.', fail.lineAt(overallMarkers[1].index));
  const marker = overallMarkers.at(-1);
  const { prefix, overall, lineIn, headingLine } = sliceOverall(contents, marker, fail);
  const titleLines = [...contents.matchAll(new RegExp(`^# Automated Review\\s+${VERDICT_DASH}\\s+(\\d+)[ \\t]+round[ \\t]+(\\d+)[ \\t]*$`, 'gm'))];
  const title = titleLines[0];
  const number = title?.[1];
  const round = title ? Number(title[2]) : undefined;
  if (titleLines.length !== 1) fail('Review artifact must contain exactly one valid automated-review title.', fail.lineAt(title?.index) ?? fail.lineOf(/^# Automated Review/m) ?? 1);

  // One scan per identity header yields its count, its value and its line;
  // an identity line is only valid appearing exactly once, before `## Overall`.
  const header = (label) => {
    const matches = [...contents.matchAll(new RegExp(`^${label}:[^\\n]*$`, 'gm'))];
    const inPrefix = matches.filter((match) => match.index < marker.index);
    return {
      unique: matches.length === 1 && inPrefix.length === 1,
      value: inPrefix[0]?.[0].replace(new RegExp(`^${label}:[ \\t]*`), '').trim(),
      line: fail.lineAt(matches[0]?.index),
    };
  };

  const reviewedCode = header('Reviewed code SHA');
  const reviewedCodeSha = COMMIT_SHA.test(reviewedCode.value ?? '') ? reviewedCode.value : undefined;
  if (!reviewedCode.unique || !reviewedCodeSha) fail('Expected exactly one valid Reviewed code SHA.', reviewedCode.line);

  const planHash = header('Approved plan SHA256');
  const planCommit = header('Approved plan commit');
  if (!planHash.unique) fail('Review artifact must contain exactly one Approved plan SHA256 line.', planHash.line);
  if (!planCommit.unique) fail('Review artifact must contain exactly one Approved plan commit line.', planCommit.line);
  const choreSentinel = planHash.value === CHORE_LANE_SENTINEL && planCommit.value === CHORE_LANE_SENTINEL;
  const approvedPlanSha256 = PLAN_SHA256.test(planHash.value ?? '') ? planHash.value : undefined;
  const approvedPlanCommit = COMMIT_SHA.test(planCommit.value ?? '') ? planCommit.value : undefined;
  if (!choreSentinel && !approvedPlanSha256) fail('Missing or invalid Approved plan SHA256.', planHash.line);
  if (!choreSentinel && !approvedPlanCommit) fail('Missing or invalid Approved plan commit.', planCommit.line);
  if ((planHash.value === CHORE_LANE_SENTINEL) !== (planCommit.value === CHORE_LANE_SENTINEL)) {
    fail('Chore review identity must use the sentinel in both approved-plan fields.', planHash.line);
  }

  const reviewerHeader = header('Reviewers');
  const reviewers = parseReviewerList(reviewerHeader.value);
  if (!reviewerHeader.unique) fail('Review artifact must contain exactly one Reviewers line.', reviewerHeader.line);
  if (!reviewers.length || unique(reviewers).length !== reviewers.length) fail('Reviewers must be a non-empty unique list.', reviewerHeader.line);
  if ([...reviewers].sort().join(',') !== reviewers.join(',')) fail('Reviewer list must use deterministic reviewer-name order.', reviewerHeader.line);

  const components = parseComponents(prefix, reviewers, fail, contents);
  const componentFindingIds = components.flatMap((component) => component.findingIds);
  if (unique(componentFindingIds).length !== componentFindingIds.length) fail('A stable finding ID appears in more than one component report.', components[0]?.headingLine);
  for (const component of components) {
    const prefixValue = reviewerFindingPrefix(component.reviewer);
    const foreign = component.findingIds.filter((id) => !id.startsWith(prefixValue));
    if (foreign.length) {
      fail(
        `${component.reviewer} contains finding IDs outside its ${prefixValue}NNN namespace: ${foreign.join(', ')}.`,
        component.findingLine(foreign[0]) ?? component.headingLine,
      );
    }
  }
  const verdictMatches = [...overall.matchAll(/^Verdict:[ \t]*(.+)[ \t]*$/gm)];
  const overallVerdictLine = verdictMatches[0] ? lineIn(verdictMatches[0].index) : headingLine;
  if (verdictMatches.length !== 1) fail('Overall must contain exactly one Verdict line.', overallVerdictLine);
  const verdict = parseVerdict(verdictMatches[0]?.[0].replace(/^Verdict:[ \t]*/, ''));
  if (verdictMatches.length === 1 && !verdict) fail('Overall Verdict is malformed.', overallVerdictLine);
  const tail = contents.trimEnd().split('\n');
  if (!tail.at(-1)?.startsWith('Verdict:')) fail('Overall Verdict must be the final non-empty line.', tail.length);

  const componentVerdicts = components.map((component) => component.verdict?.value).filter(Boolean);
  const expectedVerdict = componentVerdicts.length === reviewers.length ? aggregateVerdict(componentVerdicts) : undefined;
  if (verdict && expectedVerdict !== verdict.value) fail('Overall Verdict does not equal the aggregate component verdict.', overallVerdictLine);

  for (const reviewer of reviewers) {
    const summaries = [...overall.matchAll(new RegExp(`^-[ \\t]+${escapeRegex(reviewer)}:[ \\t]+(.+)[ \\t]*$`, 'gm'))];
    if (summaries.length !== 1) fail(`Overall must summarize ${reviewer} exactly once.`, summaries[0] ? lineIn(summaries[0].index) : headingLine);
    else {
      const component = components.find((item) => item.reviewer === reviewer);
      const summaryVerdict = normalizeReviewVerdict(summaries[0][1]);
      if (!summaryVerdict || component?.verdict?.value !== summaryVerdict) {
        fail(`Overall summary for ${reviewer} disagrees with its component verdict.`, lineIn(summaries[0].index));
      }
    }
  }

  const { values: structured, fixDispositionLine } = parseStructuredOverall(overall, round, verdict, fail, lineIn);

  const currentFindingIds = structured.fixDisposition?.kind === 'disposition'
    ? [...structured.fixDisposition.persists, ...structured.fixDisposition.new]
    : unique(components.flatMap((component) => component.findingIds));
  if (verdict && verdict.mustFixCount !== unique(currentFindingIds).length) {
    fail(`Aggregate MUST FIX count (${verdict.mustFixCount}) does not match actionable finding IDs (${unique(currentFindingIds).length}).`, overallVerdictLine);
  }
  if (round === 1) {
    for (const component of components.filter((item) => item.verdict?.mustFixCount)) {
      if (component.verdict.mustFixCount !== component.findingIds.length) {
        fail(`${component.reviewer} MUST FIX count does not match its stable finding IDs.`, component.headingLine);
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
    if (missingFromReports.length) fail(`Fix-Disposition IDs missing from component reports: ${missingFromReports.join(', ')}.`, fixDispositionLine);
    if (unclassified.length) fail(`Component finding IDs missing from Fix-Disposition: ${unclassified.join(', ')}.`, fixDispositionLine);
    for (const component of components) {
      const actionable = [...structured.fixDisposition.persists, ...structured.fixDisposition.new].filter((id) => component.findingIds.includes(id));
      if (component.verdict && component.verdict.mustFixCount !== actionable.length) {
        fail(`${component.reviewer} MUST FIX count (${component.verdict.mustFixCount}) does not match its actionable disposition IDs (${actionable.length}).`, component.headingLine);
      }
    }
    for (const [disposition, ids] of Object.entries({ fixed: structured.fixDisposition.fixed, persists: structured.fixDisposition.persists, new: structured.fixDisposition.new })) {
      for (const id of ids) {
        const component = components.find((item) => item.findingIds.includes(id));
        if (component) requiresDispositionTag(component, id, disposition, fail);
      }
    }
  }

  if (previous?.valid && structured.fixDisposition?.kind === 'disposition') {
    const prior = new Set(previous.currentFindingIds ?? []);
    const classifiedPrior = new Set([...structured.fixDisposition.fixed, ...structured.fixDisposition.persists]);
    const missing = [...prior].filter((id) => !classifiedPrior.has(id));
    const inventedPrior = [...classifiedPrior].filter((id) => !prior.has(id));
    const newButPrior = structured.fixDisposition.new.filter((id) => prior.has(id));
    if (missing.length) fail(`Prior findings lack a disposition: ${missing.join(', ')}.`, fixDispositionLine);
    if (inventedPrior.length) fail(`Fixed/persists references non-prior findings: ${inventedPrior.join(', ')}.`, fixDispositionLine);
    if (newButPrior.length) fail(`New bucket contains prior findings: ${newButPrior.join(', ')}.`, fixDispositionLine);
  }

  return withDiagnostics({
    version: 'structured',
    valid: diagnostics.length === 0,
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
    warnings,
  }, diagnostics);
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

// A skeleton, never evidence: identity that is mechanically knowable is filled
// in, and every judgement — verdicts, findings, control-line values — is left
// empty for the reviewer to supply.
export function renderReviewTemplate({
  number,
  round,
  reviewedCodeSha,
  approvedPlanSha256,
  approvedPlanCommit,
  reviewers,
} = {}) {
  const rawNumber = String(number ?? '').trim();
  if (!/^\d+$/.test(rawNumber)) throw new Error(`Review template requires a numeric plan number, got '${number}'.`);
  const paddedNumber = rawNumber.padStart(3, '0');

  const roundNumber = Number(round);
  if (!Number.isInteger(roundNumber) || roundNumber < 1) throw new Error(`Review template requires a positive integer round, got '${round}'.`);

  const codeSha = String(reviewedCodeSha ?? '').trim();
  if (!COMMIT_SHA.test(codeSha)) throw new Error(`Review template requires a resolved reviewed code SHA, got '${reviewedCodeSha ?? ''}'.`);

  const planHash = String(approvedPlanSha256 ?? '').trim();
  const planCommit = String(approvedPlanCommit ?? '').trim();
  // Same both-or-neither rule the parser enforces, written the same way.
  if ((planHash === CHORE_LANE_SENTINEL) !== (planCommit === CHORE_LANE_SENTINEL)) {
    throw new Error(`Review template chore identity requires '${CHORE_LANE_SENTINEL}' in both approved-plan fields.`);
  }
  const chore = planHash === CHORE_LANE_SENTINEL;
  if (!chore && !PLAN_SHA256.test(planHash)) throw new Error(`Review template requires the approved plan SHA-256, got '${approvedPlanSha256 ?? ''}'.`);
  if (!chore && !COMMIT_SHA.test(planCommit)) throw new Error(`Review template requires the approved plan commit, got '${approvedPlanCommit ?? ''}'.`);

  const names = (reviewers ?? []).map((name) => String(name).trim()).filter(Boolean);
  if (!names.length) throw new Error('Review template requires at least one reviewer.');
  if (unique(names).length !== names.length) throw new Error('Review template reviewers must be unique.');
  if (names.some((name) => /[,\n]/.test(name))) throw new Error('Review template reviewer names cannot contain a comma or newline.');
  const ordered = [...names].sort();

  const lines = [
    `# Automated Review - ${paddedNumber} round ${roundNumber}`,
    `Reviewed code SHA: ${codeSha}`,
    `Approved plan SHA256: ${planHash}`,
    `Approved plan commit: ${planCommit}`,
    `Reviewers: ${ordered.join(', ')}`,
    '',
  ];
  for (const reviewer of ordered) lines.push(`## ${reviewer}`, '<!-- component report -->', '');
  lines.push('## Overall', '', 'Scope-Check:', 'AC-Coverage:', 'Fix-Disposition:', '');
  for (const reviewer of ordered) lines.push(`- ${reviewer}:`);
  lines.push('', 'Verdict:', '');
  return lines.join('\n');
}
