import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDiscoveryResult, parsePlan, parseTicket, sectionBody } from './artifacts.mjs';
import { classifyTargetPath, configuredGateCommands, readProjectConfig } from './config.mjs';
import { pathMatchesScope, resolvePrimaryCheckout } from './doctor.mjs';
import { fingerprintContent } from './fingerprint.mjs';
import { latestGateSummary } from './gates.mjs';

export const REVIEW_PACKET_SCHEMA = 'sdlc.review-packet.v1';
export const STEP_PACKET_SCHEMA = 'sdlc.step-packet.v1';

function repositoryPath(path) {
  return path.split(sep).join('/');
}

function git(cwd, args, { buffer = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: buffer ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(result.stderr?.toString().trim() || result.error?.message || `git ${args.join(' ')} failed`);
  }
  return result.status === 0 ? result.stdout : null;
}

function artifactPath(root, directory, number) {
  const path = join(root, 'thoughts', directory);
  const matches = existsSync(path)
    ? readdirSync(path).filter((file) => new RegExp(`^${number}-.+\\.md$`).test(file)).sort()
    : [];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${directory === 'tickets' ? 'ticket' : 'plan'} for ${number}; found ${matches.length}.`);
  return join(path, matches[0]);
}

function changedFiles(cwd, base, head) {
  const output = git(cwd, ['diff', '--name-only', '--diff-filter=ACMRD', '-z', `${base}...${head}`]);
  return output.toString().split('\0').filter(Boolean).filter((path) => !path.startsWith('thoughts/reviews/')).sort();
}

function stripExtension(path) {
  const extension = extname(path);
  return extension ? path.slice(0, -extension.length) : path;
}

function pathVariants(path) {
  const clean = posix.normalize(path).replace(/^\.\//, '').replace(/^\//, '');
  return new Set([clean, stripExtension(clean)]);
}

function referenceTarget(referencingPath, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0].trim();
  if (!clean) return null;
  if (clean.startsWith('./') || clean.startsWith('../')) {
    const resolved = posix.normalize(posix.join(posix.dirname(referencingPath), clean));
    return resolved.startsWith('../') ? null : resolved;
  }
  return posix.normalize(clean.replace(/^\//, ''));
}

export function textualReferences(contents) {
  const references = new Set();
  const source = String(contents ?? '');
  const patterns = [
    /(?:\bfrom|\bimport|\brequire|\binclude|@import)\s*(?:\(\s*)?["'<]([^"'>]+)["'>]/g,
    /^\s*#[ \t]*include[ \t]*["<]([^">]+)[">]/gm,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) references.add(match[1]);
  return [...references].sort();
}

function readChangedFile(cwd, head, path, base) {
  let contents = git(cwd, ['show', `${head}:${path}`], { buffer: true, allowFailure: true });
  let deleted = false;
  if (contents === null && base) {
    contents = git(cwd, ['show', `${base}:${path}`], { buffer: true, allowFailure: true });
    deleted = contents !== null;
  }
  if (contents === null) return { status: 'unreadable', references: [] };
  if (contents.includes(0)) return { status: 'binary', references: [] };
  return { status: 'text', deleted, contents: contents.toString('utf8'), references: textualReferences(contents.toString('utf8')) };
}

export function buildInterfaceGraph(files, fileRecords) {
  const variants = new Map();
  for (const path of files) for (const variant of pathVariants(path)) {
    if (!variants.has(variant)) variants.set(variant, []);
    variants.get(variant).push(path);
  }
  const graph = new Map(files.map((path) => [path, new Set()]));
  for (const path of files) {
    const record = fileRecords.get(path);
    if (record?.status !== 'text') continue;
    for (const specifier of record.references) {
      const target = referenceTarget(path, specifier);
      if (!target) continue;
      const matches = new Set();
      for (const variant of pathVariants(target)) for (const match of variants.get(variant) ?? []) matches.add(match);
      for (const match of matches) {
        if (match === path) continue;
        graph.get(path).add(match);
        graph.get(match).add(path);
      }
    }
  }
  return graph;
}

function reviewerMap(config, classified) {
  const map = new Map();
  const all = config.reviewers['all targets'] ?? [];
  for (const target of config.targets) {
    const reviewers = config.reviewers[target]?.length ? config.reviewers[target] : all;
    for (const reviewer of reviewers) {
      if (!map.has(reviewer)) map.set(reviewer, new Set());
      map.get(reviewer).add(target);
    }
  }
  const unclassified = classified.filter((record) => !record.targets.length);
  if (unclassified.length) {
    if (!map.has('general-code-reviewer')) map.set('general-code-reviewer', new Set());
    map.get('general-code-reviewer').add('unmapped');
  }
  if (!map.size) map.set('general-code-reviewer', new Set(['model-classified']));
  return map;
}

function changedDiff(cwd, base, head, files) {
  if (!files.length) return '';
  return git(cwd, ['diff', '--no-ext-diff', '--find-renames', `${base}...${head}`, '--', ...files]).toString();
}

function stepProjection(step, lanePaths) {
  const relevant = !lanePaths.length || (step.files ?? []).some((scope) => lanePaths.some((path) => pathMatchesScope(path, scope)));
  if (!relevant) return null;
  return {
    number: step.number,
    title: step.title,
    covers: step.covers,
    files: step.files,
    dependencies: step.dependencies,
    text: step.body.trim(),
  };
}

function priorFindings(root, number) {
  const directory = join(root, 'thoughts', 'reviews');
  if (!existsSync(directory)) return [];
  const found = new Map();
  for (const file of readdirSync(directory).filter((name) => new RegExp(`^${number}-round\\d+\\.md$`).test(name)).sort()) {
    const source = readFileSync(join(directory, file), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const id = line.match(/\b(?:MF|NIT)-[A-Za-z0-9_-]+-\d{3}\b/)?.[0];
      if (id) found.set(id, { id, evidence: line.trim(), artifact: `thoughts/reviews/${file}` });
    }
  }
  return [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function latestPlanCommit(primary, planPath) {
  return git(primary, ['log', '-1', '--format=%H', '--', planPath], { allowFailure: true })?.toString().trim() || null;
}

export function composeReviewPackets({
  cwd,
  primary,
  number,
  base,
  head,
  config,
  ticketPath,
  ticketSource,
  ticket,
  planPath,
  planSource,
  plan,
  files,
  fileRecords,
  gateSummary,
  findings = [],
  approvedPlanCommit,
  reviewerNames,
  discovery,
}) {
  const laneMapConfigured = Object.values(config.targetPaths).some((paths) => paths.length);
  const classified = files.map((path) => ({
    path,
    targets: laneMapConfigured ? classifyTargetPath(path, config, pathMatchesScope) : [],
    scan: fileRecords.get(path)?.status ?? 'unreadable',
  }));
  const graph = buildInterfaceGraph(files, fileRecords);
  const reviewers = reviewerMap(config, classified);
  const selected = reviewerNames?.length
    ? [...reviewers.entries()].filter(([name]) => reviewerNames.includes(name))
    : [...reviewers.entries()];
  for (const name of reviewerNames ?? []) if (!selected.some(([candidate]) => candidate === name)) selected.push([name, new Set(['model-classified'])]);
  selected.sort(([left], [right]) => left.localeCompare(right));

  return selected.map(([reviewer, targetSet]) => {
    const targets = [...targetSet].sort();
    const laneFiles = laneMapConfigured
      ? classified.filter((record) => record.targets.some((target) => targetSet.has(target)) || (targetSet.has('unmapped') && !record.targets.length)).map((record) => record.path)
      : files.slice();
    const laneSet = new Set(laneFiles);
    const interfaceFiles = [];
    for (const path of files) {
      if (laneSet.has(path) || fileRecords.get(path)?.status !== 'text') continue;
      if ([...graph.get(path)].some((neighbor) => laneSet.has(neighbor))) interfaceFiles.push(path);
    }
    const diffFiles = [...new Set([
      ...laneFiles.filter((path) => fileRecords.get(path)?.status === 'text'),
      ...interfaceFiles,
    ])].sort();
    const inventory = classified.map((record) => ({
      ...record,
      role: record.scan !== 'text' ? 'inventory-only'
        : laneSet.has(record.path) ? 'lane'
        : interfaceFiles.includes(record.path) ? 'cross-lane-interface'
          : 'inventory-only',
    }));
    const fallbacks = inventory.filter((record) => record.role === 'inventory-only').map((record) => ({
      path: record.path,
      reason: record.scan === 'binary' ? 'binary-inventory-only'
        : record.scan === 'unreadable' ? 'unreadable-inventory-only'
          : 'no-computable-interface-match',
    }));
    return {
      schema: REVIEW_PACKET_SCHEMA,
      reviewer,
      number,
      range: `${base}...${head}`,
      classification: {
        mode: laneMapConfigured ? 'configured-target-paths' : 'model-required',
        targets,
        note: laneMapConfigured
          ? 'A path matching multiple configured targets belongs to every matching lane.'
          : 'Target paths are not configured; no CLI lane heuristic was applied, so this packet retains the complete readable-text diff and explicit inventory-only fallbacks.',
      },
      ticket: {
        path: repositoryPath(relative(primary, ticketPath)),
        intent: sectionBody(ticketSource, 'Summary')?.trim() || ticketSource.match(/^#[ \t]+(.+)$/m)?.[1] || basename(ticketPath),
        acceptanceCriteria: ticket.entries.filter((entry) => !entry.removed).map((entry) => entry.line.replace(/^-\s*/, '')),
      },
      plan: {
        path: planPath ? repositoryPath(relative(primary, planPath)) : null,
        sha256: planPath ? fingerprintContent(planSource) : 'N/A',
        approvedCommit: planPath ? approvedPlanCommit : 'N/A',
        steps: (plan?.activeSteps ?? []).map((step) => stepProjection(step, laneFiles)).filter(Boolean),
      },
      discovery: discovery ? { path: discovery.path, outcome: discovery.outcome, valid: discovery.valid } : null,
      changedFileInventory: inventory,
      laneDiff: changedDiff(cwd, base, head, diffFiles),
      gateSummary: gateSummary ? {
        ok: gateSummary.ok,
        createdAt: gateSummary.createdAt,
        commands: gateSummary.commands?.map((command) => ({ command: command.command, status: command.status, counts: command.counts })) ?? [],
      } : { ok: null, note: 'No persisted sdlc gates summary was found.' },
      priorFindings: findings,
      fallbacks,
    };
  });
}

export function createReviewPackets(number, {
  cwd = process.cwd(),
  base = 'main',
  head = 'HEAD',
  reviewerNames,
  approvedPlanCommit,
  gateSummary,
  fileRecordReader = readChangedFile,
} = {}) {
  const normalized = String(number).padStart(3, '0');
  const primary = resolvePrimaryCheckout(cwd);
  const config = readProjectConfig(primary);
  if (config.errors.length) throw new Error(config.errors.join(' '));
  const ticketPath = artifactPath(primary, 'tickets', normalized);
  const ticketSource = readFileSync(ticketPath, 'utf8');
  const ticket = parseTicket(ticketSource, { path: repositoryPath(relative(primary, ticketPath)) });
  let planPath = null;
  let planSource = '';
  let plan = null;
  try {
    planPath = artifactPath(primary, 'plans', normalized);
    planSource = readFileSync(planPath, 'utf8');
    plan = parsePlan(planSource, { path: repositoryPath(relative(primary, planPath)), ticket });
  } catch (error) {
    if (ticket.frontmatter.Type !== 'chore' || !/found 0/.test(error.message)) throw error;
  }
  let discovery = null;
  if (ticket.frontmatter.Type === 'discovery') {
    const reportPath = join(cwd, 'thoughts', 'designs', `${normalized}-discovery.md`);
    if (!existsSync(reportPath)) throw new Error(`Discovery result artifact is missing: ${reportPath}`);
    const reportSource = readFileSync(reportPath, 'utf8');
    discovery = parseDiscoveryResult(reportSource, {
      path: repositoryPath(relative(cwd, reportPath)), ticket, plan,
      ticketSha256: fingerprintContent(ticketSource), planSha256: fingerprintContent(planSource),
    });
    if (!discovery.valid) throw new Error(`Discovery result artifact is malformed: ${discovery.errors.join(' ')}`);
  }
  const files = changedFiles(cwd, base, head);
  const fileRecords = new Map(files.map((path) => [path, fileRecordReader(cwd, head, path, base)]));
  return composeReviewPackets({
    cwd,
    primary,
    number: normalized,
    base,
    head,
    config,
    ticketPath,
    ticketSource,
    ticket,
    planPath,
    planSource,
    plan,
    files,
    fileRecords,
    gateSummary: gateSummary ?? latestGateSummary(cwd),
    findings: priorFindings(cwd, normalized),
    approvedPlanCommit: planPath
      ? approvedPlanCommit ?? latestPlanCommit(primary, repositoryPath(relative(primary, planPath)))
      : 'N/A',
    reviewerNames,
    discovery,
  });
}

export function createStepPacket(number, stepNumber, {
  cwd = process.cwd(),
  issueId: stepIssueId,
  approvalCommit,
  worktreeRoot,
  target,
} = {}) {
  const normalized = String(number).padStart(3, '0');
  const primary = resolvePrimaryCheckout(cwd);
  const config = readProjectConfig(primary);
  if (config.errors.length) throw new Error(config.errors.join(' '));
  const ticketPath = artifactPath(primary, 'tickets', normalized);
  const planPath = artifactPath(primary, 'plans', normalized);
  const ticketSource = readFileSync(ticketPath, 'utf8');
  const ticket = parseTicket(ticketSource, { path: repositoryPath(relative(primary, ticketPath)) });
  const planSource = readFileSync(planPath, 'utf8');
  const plan = parsePlan(planSource, { path: repositoryPath(relative(primary, planPath)), ticket });
  const step = plan.activeSteps.find((candidate) => candidate.number === Number(stepNumber));
  if (!step) throw new Error(`Active plan step ${stepNumber} was not found.`);
  const acceptance = ticket.entries.filter((entry) => step.covers.includes(entry.id) && !entry.removed).map((entry) => entry.line.replace(/^-\s*/, ''));
  const gates = configuredGateCommands(config, target ?? plan.frontmatter.Target).map((gate) => ({ command: gate.command, source: gate.source }));
  return {
    schema: STEP_PACKET_SCHEMA,
    number: normalized,
    issue: stepIssueId ?? 'unassigned',
    step: { number: step.number, title: step.title, text: step.body.trim() },
    acceptanceCriteria: acceptance,
    covers: step.covers,
    files: step.files,
    dependencies: step.dependencies,
    gates,
    constraints: config.frontendConstraints,
    plan: { path: repositoryPath(relative(primary, planPath)), sha256: fingerprintContent(planSource), approvalCommit: approvalCommit ?? latestPlanCommit(primary, repositoryPath(relative(primary, planPath))) },
    worktreeRoot: worktreeRoot ?? cwd,
    resultContract: 'status=<pass|blocked> commit=<sha|none> files=<paths|none> gates=<summary> memory-candidates=<keys|none> blocker=<none|specific blocker>',
  };
}

export function formatReviewPacket(packet) {
  const inventory = packet.changedFileInventory.map((file) => `- ${file.path} — targets=${file.targets.join(',') || 'unclassified'}; role=${file.role}; scan=${file.scan}`).join('\n');
  const criteria = packet.ticket.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n');
  const steps = packet.plan.steps.map((step) => `- Step ${step.number}: ${step.title}; covers=${step.covers.join(',') || 'none'}; files=${step.files?.join(',') || 'none'}`).join('\n') || '- None selected.';
  const gates = packet.gateSummary.commands?.map((gate) => `- ${gate.status === 0 ? 'PASS' : 'FAIL'} ${gate.command}${Object.keys(gate.counts ?? {}).length ? ` (${Object.entries(gate.counts).map(([key, value]) => `${key}=${value}`).join(', ')})` : ''}`).join('\n') || `- ${packet.gateSummary.note ?? 'No gate commands.'}`;
  const findings = packet.priorFindings.map((finding) => `- ${finding.id}: ${finding.evidence}`).join('\n') || '- None.';
  const fallbacks = packet.fallbacks.map((fallback) => `- ${fallback.path}: ${fallback.reason}`).join('\n') || '- None.';
  return `# Review Packet — ${packet.number} — ${packet.reviewer}

Range: ${packet.range}
Classification: ${packet.classification.mode}
${packet.classification.note}

## Ticket intent

${packet.ticket.intent}

## Live acceptance criteria

${criteria}

## Approved plan identity

- Path: ${packet.plan.path ?? 'N/A - chore lane'}
- SHA256: ${packet.plan.sha256}
- Approval commit: ${packet.plan.approvedCommit ?? 'unknown'}

## Lane-relevant steps

${steps}

${packet.discovery ? `## Discovery result\n\n- Path: ${packet.discovery.path}\n- Outcome: ${packet.discovery.outcome}\n- Valid: ${packet.discovery.valid}\n` : ''}

## Complete changed-file inventory

${inventory}

## Gate summary

${gates}

## Prior findings

${findings}

## Inventory-only fallbacks

${fallbacks}

Review the lane-scoped diff in full, remain aware of the complete inventory,
and make a light correctness pass over cross-lane interface files. State any
file or diff read beyond this packet.

## Lane-scoped diff

\`\`\`diff
${packet.laneDiff}
\`\`\`
`;
}
