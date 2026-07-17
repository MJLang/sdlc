import { parseFingerprint } from './fingerprint.mjs';

const IDENTIFIER = /\b(?:AC|NFR|C|A|Q)-\d{3}\b/g;
const AC_IDENTIFIER = /^AC-\d{3}$/;

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

export function parseFrontmatter(contents) {
  const normalized = String(contents).replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) return { attributes: {}, body: normalized, raw: '', error: 'Missing YAML frontmatter.' };

  const attributes = {};
  const duplicates = [];
  for (const line of match[1].split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const field = line.match(/^([^:#][^:]*):[ \t]*(.*)$/);
    if (!field) continue;
    const key = field[1].trim();
    if (Object.hasOwn(attributes, key)) duplicates.push(key);
    attributes[key] = unquote(field[2]);
  }

  return {
    attributes,
    body: normalized.slice(match[0].length),
    raw: match[1],
    duplicates,
  };
}

export function sectionBody(contents, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = String(contents).replace(/\r\n?/g, '\n');
  const heading = new RegExp(`^##[ \\t]+${escaped}[ \\t]*$`, 'mi');
  const match = heading.exec(normalized);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const remainder = normalized.slice(start);
  const next = remainder.search(/^##[ \t]+/m);
  return (next < 0 ? remainder : remainder.slice(0, next)).replace(/^\n/, '');
}

function duplicates(values) {
  const seen = new Set();
  const found = new Set();
  for (const value of values) {
    if (seen.has(value)) found.add(value);
    seen.add(value);
  }
  return [...found].sort();
}

function allIdentifiers(text) {
  return [...String(text).matchAll(IDENTIFIER)].map((match) => match[0]);
}

export function parseTicket(contents, { path } = {}) {
  const frontmatter = parseFrontmatter(contents);
  const acceptance = sectionBody(contents, 'Acceptance Criteria');
  const entries = [];
  const malformedAcceptanceBullets = [];

  if (acceptance !== undefined) {
    for (const line of acceptance.split('\n')) {
      const bullet = line.match(/^[ \t]*-[ \t]+(.+)$/);
      if (!bullet) continue;
      const id = bullet[1].match(/^(?:~~)?(AC-\d{3})\b/)?.[1];
      if (!id) {
        malformedAcceptanceBullets.push(line.trim());
        continue;
      }
      const removed = /~~[^\n]*\bAC-\d{3}\b|\bAC-\d{3}\b[^\n]*~~|\bremoved\s*:/i.test(line);
      entries.push({ id, removed, line: line.trim() });
    }
  }

  const ids = entries.map((entry) => entry.id);
  const activeAcceptanceCriteria = [...new Set(entries.filter((entry) => !entry.removed).map((entry) => entry.id))].sort();
  const removedAcceptanceCriteria = [...new Set(entries.filter((entry) => entry.removed).map((entry) => entry.id))].sort();
  const allocatedAcceptanceIds = new Set(entries.map((entry) => entry.id));
  const declaredIdentifiers = [...new Set(allIdentifiers(contents).filter((id) => !AC_IDENTIFIER.test(id) || allocatedAcceptanceIds.has(id)))].sort();
  const errors = [];

  if (frontmatter.error) errors.push(frontmatter.error);
  if (frontmatter.duplicates?.length) errors.push(`Duplicate frontmatter fields: ${frontmatter.duplicates.join(', ')}.`);
  if (!['draft', 'approved', 'implemented', 'cancelled'].includes(frontmatter.attributes.Status)) errors.push('Ticket has an invalid or missing Status.');
  if (!frontmatter.attributes.Tags) errors.push('Ticket is missing Tags.');
  if (!['feature', 'bug', 'refactor', 'chore', 'discovery'].includes(frontmatter.attributes.Type)) errors.push('Ticket has an invalid or missing Type.');
  if (!frontmatter.attributes.Target) errors.push('Ticket is missing Target.');
  if (acceptance === undefined) errors.push('Missing Acceptance Criteria section.');
  if (!entries.length) errors.push('Acceptance Criteria contains no AC-NNN entries.');
  if (malformedAcceptanceBullets.length) errors.push(`Acceptance Criteria has ${malformedAcceptanceBullets.length} bullet${malformedAcceptanceBullets.length === 1 ? '' : 's'} without an allocated AC-NNN ID.`);
  if (duplicates(ids).length) errors.push(`Duplicate acceptance IDs: ${duplicates(ids).join(', ')}.`);
  if (entries.some((entry) => entry.removed && !/\bremoved\s*:[ \t]*\S/i.test(entry.line))) errors.push('Every removed acceptance criterion requires a reason.');
  if (entries.some((entry, index) => index > 0 && Number(entry.id.slice(3)) <= Number(entries[index - 1].id.slice(3)))) errors.push('Acceptance IDs must appear in ascending allocation order.');
  if (!activeAcceptanceCriteria.length && !removedAcceptanceCriteria.length) errors.push('Ticket has no allocated AC-NNN identifiers.');

  return {
    kind: 'ticket',
    path,
    frontmatter: frontmatter.attributes,
    status: frontmatter.attributes.Status,
    entries,
    activeAcceptanceCriteria,
    removedAcceptanceCriteria,
    declaredIdentifiers,
    errors,
  };
}

function parseField(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.match(new RegExp(`^${escaped}:[ \\t]*(.*)$`, 'mi'))?.[1].trim();
}

function parseFiles(body) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const index = lines.findIndex((line) => /^Files:[ \t]*/i.test(line));
  if (index < 0) return undefined;

  const inline = lines[index].replace(/^Files:[ \t]*/i, '').trim();
  const files = inline ? inline.split(',').map((item) => item.trim()) : [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const item = lines[cursor].match(/^[ \t]*-[ \t]+(.+?)[ \t]*$/);
    if (!item) {
      if (!lines[cursor].trim()) continue;
      break;
    }
    files.push(item[1].replace(/^`|`$/g, '').trim());
  }
  return files.filter(Boolean);
}

function parseCovers(value) {
  if (!value) return [];
  if (/^none\b/i.test(value)) return [];
  return [...new Set(allIdentifiers(value))].sort();
}

function parseDependencies(value) {
  if (!value || /^none\b/i.test(value)) return [];
  return [...new Set([...value.matchAll(/\bstep[ \t]+(\d+)\b/gi)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

export function parsePlanSteps(contents) {
  const normalized = String(contents).replace(/\r\n?/g, '\n');
  const allHeadings = [...normalized.matchAll(/^(#{1,3})[ \t]+(.+)[ \t]*$/gm)];
  const headings = allHeadings.filter((match) => match[1] === '###' && /\bStep[ \t]+\d+\b/i.test(match[2]));

  return headings.map((heading, index) => {
    const number = Number(heading[2].match(/\bStep[ \t]+(\d+)\b/i)[1]);
    const start = heading.index + heading[0].length;
    const end = allHeadings.find((candidate) => candidate.index > heading.index)?.index ?? normalized.length;
    const body = normalized.slice(start, end).replace(/^\n/, '');
    const removed = /~~/.test(heading[2]) || /\bremoved\s*:/i.test(heading[2]);
    const coversRaw = parseField(body, 'Covers');
    const dependsRaw = parseField(body, 'Depends on');
    return {
      number,
      title: heading[2].replace(/~~/g, '').trim(),
      removed,
      coversRaw,
      covers: parseCovers(coversRaw),
      enablingOnly: /^none\s*-/i.test(coversRaw ?? ''),
      files: parseFiles(body),
      dependsRaw,
      dependencies: parseDependencies(dependsRaw),
      parallelizable: parseField(body, 'Parallelizable'),
      body,
    };
  });
}

function graphCycles(steps) {
  const graph = new Map(steps.map((step) => [step.number, step.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function visit(node, path) {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      cycles.push([...path.slice(start), node]);
      return;
    }
    if (visited.has(node) || !graph.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node)) visit(dependency, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) visit(node, []);
  return cycles;
}

function parseCritique(contents) {
  const body = sectionBody(contents, 'Plan Critique');
  if (body === undefined) return { present: false, unresolved: [], errors: [] };
  const findings = [...body.matchAll(/^.*\b(PC-\d{3})\b[ \t]*\[([^\]]+)\].*$/gim)].map((match) => ({
    id: match[1].toUpperCase(),
    disposition: match[2].trim().toLowerCase(),
    line: match[0].trim(),
  }));
  const passLines = body.match(/^Pass 1 Verdict:[ \t]*(.+)$/gim) ?? [];
  const passValue = passLines[0]?.replace(/^Pass 1 Verdict:[ \t]*/i, '').trim();
  const blocked = passValue?.match(/^BLOCKED[ \t]+-[ \t]+([1-9]\d*)[ \t]+MUST FIX$/);
  const approved = passValue === 'APPROVED';
  const degraded = passValue === 'DEGRADED';
  const recheckLines = body.match(/^Scoped Re-check Verdict:[ \t]*(.+)$/gim) ?? [];
  const recheckValue = recheckLines[0]?.replace(/^Scoped Re-check Verdict:[ \t]*/i, '').trim();
  const recheckApproved = recheckValue === 'APPROVED';
  const recheckBlocked = recheckValue?.match(/^BLOCKED[ \t]+-[ \t]+([1-9]\d*)[ \t]+MUST FIX$/);
  const unresolved = findings.filter((finding) => !['fixed', 'waived'].includes(finding.disposition));
  const errors = [];
  if (passLines.length !== 1 || (!blocked && !approved && !degraded)) errors.push('Plan Critique must contain exactly one valid Pass 1 Verdict.');
  if (recheckLines.length > 1) errors.push('Plan Critique may contain at most one scoped re-check verdict.');
  if (recheckLines.length === 1 && !recheckApproved && !recheckBlocked) errors.push('Scoped plan-critique re-check has an invalid verdict.');
  if (degraded) errors.push('Degraded plan critique requires explicit human resolution before approval.');
  if (duplicates(findings.map((finding) => finding.id)).length) {
    errors.push(`Duplicate plan critique IDs: ${duplicates(findings.map((finding) => finding.id)).join(', ')}.`);
  }
  const invalidDispositions = findings.filter((finding) => !['open', 'persists', 'fixed', 'waived'].includes(finding.disposition));
  if (invalidDispositions.length) errors.push(`Invalid plan critique dispositions: ${invalidDispositions.map((finding) => finding.id).join(', ')}.`);
  const reasonlessWaivers = findings.filter((finding) => finding.disposition === 'waived' && !/waived by human:[ \t]*\S|\breason\s*[:=][ \t]*\S|\bbecause\b[ \t]+\S/i.test(finding.line));
  if (reasonlessWaivers.length) errors.push(`Plan critique waivers lack a human reason: ${reasonlessWaivers.map((finding) => finding.id).join(', ')}.`);
  if (blocked && Number(blocked[1]) !== findings.length) errors.push(`Plan critique MUST FIX count (${blocked[1]}) does not match finding IDs (${findings.length}).`);
  if (recheckBlocked && Number(recheckBlocked[1]) !== unresolved.length) errors.push(`Scoped re-check MUST FIX count (${recheckBlocked[1]}) does not match unresolved finding IDs (${unresolved.length}).`);
  if (blocked && !recheckLines.length && findings.some((finding) => finding.disposition === 'fixed')) {
    errors.push('Fixed plan-critique blockers require an approved scoped re-check.');
  } else if (blocked && !recheckLines.length && !findings.length) {
    errors.push('Blocked plan critique has no stable finding IDs.');
  } else if (blocked && !recheckLines.length && !findings.every((finding) => finding.disposition === 'waived')) {
    errors.push('Plan critique remains blocked without an approved scoped re-check or explicit waivers.');
  }
  if (recheckBlocked) errors.push('Scoped plan-critique re-check remains blocked.');
  if (approved && recheckLines.length) errors.push('An approved first critique does not use a scoped re-check.');
  return { present: true, body, findings, unresolved, errors };
}

function parseWaivers(contents) {
  const waivers = new Set();
  let fence;
  for (const line of String(contents).split(/\r?\n/)) {
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = undefined;
      continue;
    }
    if (fence || /\bnot[ \t]+waiv/i.test(line)) continue;
    const normalized = line.trim().replace(/^[-*][ \t]+/, '');
    const record = normalized.match(/^waiver:[ \t]*id[ \t]*=[ \t]*(AC-\d{3})[ \t]*;[ \t]*reason[ \t]*=[ \t]*(.+)$/i);
    const marked = normalized.match(/^(AC-\d{3})[ \t]+\[waived\](.*)$/i);
    const id = record?.[1]?.toUpperCase() ?? marked?.[1]?.toUpperCase();
    const reason = record?.[2]
      ?? marked?.[2]?.match(/\breason[ \t]*[:=][ \t]*([^;]+)/i)?.[1]
      ?? marked?.[2]?.match(/\bwaived by human[ \t]*:[ \t]*(.+)$/i)?.[1];
    const validReason = reason?.trim() && !/^(?:none|n\/a|tbd|todo)$/i.test(reason.trim()) && !/[<>]/.test(reason);
    if (id && validReason && (record || /\bwaived by human\b/i.test(marked?.[2] ?? ''))) waivers.add(id);
  }
  return [...waivers].sort();
}

export function parsePlan(contents, { path, ticket } = {}) {
  const frontmatter = parseFrontmatter(contents);
  const steps = parsePlanSteps(contents);
  const activeSteps = steps.filter((step) => !step.removed);
  const removedSteps = steps.filter((step) => step.removed);
  const knownStepNumbers = new Set(steps.map((step) => step.number));
  const sourceTicketSha256 = parseFingerprint(frontmatter.attributes['Source Ticket Hash']);
  const sourceTicketHashPresent = Object.hasOwn(frontmatter.attributes, 'Source Ticket Hash');
  const verification = sectionBody(contents, 'Verification');
  const critique = parseCritique(contents);
  const waivers = parseWaivers(contents);
  const errors = [];
  const warnings = [];

  if (frontmatter.error) errors.push(frontmatter.error);
  if (frontmatter.duplicates?.length) errors.push(`Duplicate frontmatter fields: ${frontmatter.duplicates.join(', ')}.`);
  if (!['draft', 'review', 'approved', 'merged', 'cancelled'].includes(frontmatter.attributes.Status)) errors.push('Plan has an invalid or missing Status.');
  if (!frontmatter.attributes.Tags) errors.push('Plan is missing Tags.');
  if (!['feature', 'bug', 'refactor', 'chore', 'discovery'].includes(frontmatter.attributes.Type)) errors.push('Plan has an invalid or missing Type.');
  if (!frontmatter.attributes.Target) errors.push('Plan is missing Target.');
  if (!frontmatter.attributes['Ticket Origin']) errors.push('Plan is missing Ticket Origin.');
  else if (ticket?.path && frontmatter.attributes['Ticket Origin'] !== ticket.path) errors.push(`Plan Ticket Origin does not match ${ticket.path}.`);
  if (ticket?.frontmatter?.Type && frontmatter.attributes.Type !== ticket.frontmatter.Type) errors.push(`Plan Type does not match ticket Type ${ticket.frontmatter.Type}.`);
  if (ticket?.frontmatter?.Target && frontmatter.attributes.Target !== ticket.frontmatter.Target) errors.push(`Plan Target does not match ticket Target ${ticket.frontmatter.Target}.`);
  if (sourceTicketHashPresent && !sourceTicketSha256) errors.push('Plan has an invalid Source Ticket Hash.');
  if (!steps.length) errors.push('Plan contains no numbered implementation steps.');
  const duplicateSteps = duplicates(steps.map((step) => String(step.number)));
  if (duplicateSteps.length) errors.push(`Duplicate plan step numbers: ${duplicateSteps.join(', ')}.`);
  if (steps.some((step, index) => index > 0 && step.number <= steps[index - 1].number)) errors.push('Plan steps must appear in ascending stable-number order.');
  if (removedSteps.some((step) => !/\bremoved\s*:[ \t]*\S/i.test(step.title))) errors.push('Every removed plan step requires a reason in its heading.');

  for (const step of activeSteps) {
    const rawCovers = allIdentifiers(step.coversRaw ?? '');
    const coversNone = /^none\b/i.test(step.coversRaw ?? '');
    if (step.coversRaw === undefined) errors.push(`Step ${step.number} is missing Covers:.`);
    else if (!step.covers.length && !step.enablingOnly) errors.push(`Step ${step.number} Covers: must name an identifier or use "none - <reason>".`);
    else if (step.enablingOnly && !/^none[ \t]*-[ \t]*\S/i.test(step.coversRaw)) errors.push(`Step ${step.number} enabling-only Covers: lacks a reason.`);
    if (coversNone && rawCovers.length) errors.push(`Step ${step.number} Covers: cannot mix none with identifiers.`);
    if (duplicates(rawCovers).length) errors.push(`Step ${step.number} repeats Covers identifiers: ${duplicates(rawCovers).join(', ')}.`);
    if (step.files === undefined || !step.files.length) errors.push(`Step ${step.number} has no Files: entries.`);
    else {
      const duplicateFiles = duplicates(step.files);
      if (duplicateFiles.length) errors.push(`Step ${step.number} repeats Files entries: ${duplicateFiles.join(', ')}.`);
      const unsafeFiles = step.files.filter((file) => /^(?:\/|[A-Za-z]:[\\/])/.test(file) || /(?:^|\/)\.\.(?:\/|$)/.test(file) || /[<>]/.test(file));
      if (unsafeFiles.length) errors.push(`Step ${step.number} has non-repository-relative or placeholder Files entries: ${unsafeFiles.join(', ')}.`);
    }
    const rawDependencies = [...(step.dependsRaw ?? '').matchAll(/\bstep[ \t]+(\d+)\b/gi)].map((match) => match[1]);
    const dependsOnNone = /^none\b/i.test(step.dependsRaw ?? '');
    if (step.dependsRaw === undefined) errors.push(`Step ${step.number} is missing Depends on:.`);
    else if (!step.dependencies.length && !/^none\b/i.test(step.dependsRaw)) errors.push(`Step ${step.number} has an invalid Depends on: value.`);
    if (dependsOnNone && rawDependencies.length) errors.push(`Step ${step.number} Depends on: cannot mix none with step references.`);
    if (duplicates(rawDependencies).length) errors.push(`Step ${step.number} repeats dependency references: ${duplicates(rawDependencies).join(', ')}.`);
    if (!/^(?:yes|no)$/i.test(step.parallelizable ?? '')) errors.push(`Step ${step.number} has an invalid or missing Parallelizable: value.`);
    for (const dependency of step.dependencies) {
      if (!knownStepNumbers.has(dependency)) errors.push(`Step ${step.number} depends on missing step ${dependency}.`);
      if (dependency === step.number) errors.push(`Step ${step.number} depends on itself.`);
    }
  }

  const cycles = graphCycles(steps);
  if (cycles.length) errors.push(`Plan step dependency cycle: ${cycles[0].join(' -> ')}.`);

  const currentStateFindings = sectionBody(contents, 'Current-State Findings');
  const approvalAttention = sectionBody(contents, 'Approval Attention');
  if (currentStateFindings === undefined) errors.push('Missing Current-State Findings section.');
  else if (!currentStateFindings.trim()) errors.push('Current-State Findings section is empty.');
  if (approvalAttention === undefined) errors.push('Missing Approval Attention section.');
  else if (!approvalAttention.trim()) errors.push('Approval Attention section is empty; use None when not applicable.');
  if (!critique.present) errors.push('Missing Plan Critique section.');
  errors.push(...critique.errors);
  if (critique.unresolved.length) errors.push(`Unresolved plan critique findings: ${critique.unresolved.map((item) => item.id).join(', ')}.`);
  if (verification === undefined) errors.push('Missing Verification section.');
  else if (!verification.trim()) errors.push('Verification section is empty.');
  const discoveryProtocol = sectionBody(contents, 'Discovery Protocol');
  if (frontmatter.attributes.Type === 'discovery') {
    if (discoveryProtocol === undefined || !discoveryProtocol.trim()) errors.push('Discovery plan is missing Discovery Protocol.');
    else {
      const required = ['Question and Hypothesis', 'Experiment Matrix', 'Versions and Environment', 'Success and Invalidation Thresholds', 'Expected Evidence Paths', 'External Resources', 'Retained Probe Code', 'Cleanup Procedure', 'Follow-up Disposition'];
      for (const label of required) if (!new RegExp(`^${label}:[ \\t]*\\S`, 'mi').test(discoveryProtocol)) errors.push(`Discovery Protocol is missing ${label}.`);
      const externalResources = discoveryProtocol.match(/^External Resources:[ \t]*(.+)$/mi)?.[1] ?? '';
      if (!/cost/i.test(externalResources) || !/credential/i.test(externalResources) || !/approval attention/i.test(externalResources)) errors.push('Discovery Protocol External Resources must state costs, credentials, and Approval Attention.');
    }
  }

  const coverage = {
    covered: [...new Set(activeSteps.flatMap((step) => step.covers))].sort(),
    missingImplementation: [],
    missingVerification: [],
    unknown: [],
    waived: waivers,
  };

  if (ticket) {
    const known = new Set(ticket.declaredIdentifiers);
    const live = new Set(ticket.activeAcceptanceCriteria);
    coverage.unknown = coverage.covered.filter((id) => !known.has(id));
    coverage.missingImplementation = [...live].filter((id) => !coverage.covered.includes(id) && !waivers.includes(id)).sort();
    coverage.missingVerification = [...live].filter((id) => !new RegExp(`\\b${id}\\b`).test(verification ?? '') && !waivers.includes(id)).sort();
    if (coverage.unknown.length) errors.push(`Covers references unknown identifiers: ${coverage.unknown.join(', ')}.`);
    if (coverage.missingImplementation.length) errors.push(`Acceptance criteria missing implementation coverage: ${coverage.missingImplementation.join(', ')}.`);
    if (coverage.missingVerification.length) errors.push(`Acceptance criteria missing Verification coverage: ${coverage.missingVerification.join(', ')}.`);
  } else {
    warnings.push('Ticket was not supplied; Covers and Verification references were not cross-checked.');
  }

  return {
    kind: 'plan',
    path,
    frontmatter: frontmatter.attributes,
    status: frontmatter.attributes.Status,
    ticketOrigin: frontmatter.attributes['Ticket Origin'],
    beadsEpic: frontmatter.attributes['Beads Epic'],
    sourceTicketSha256,
    sourceTicketHashPresent,
    steps,
    activeSteps,
    removedSteps,
    coverage,
    verification,
    critique,
    currentStateFindings,
    approvalAttention,
    discoveryProtocol,
    errors,
    warnings,
  };
}

export function parseDiscoveryResult(contents, { path, ticket, plan, ticketSha256, planSha256 } = {}) {
  const frontmatter = parseFrontmatter(contents);
  const outcome = frontmatter.attributes.Outcome;
  const requiredSections = ['Question and Hypothesis', 'Environment and Versions', 'Experiment Matrix', 'Findings', 'Decision', 'Retained Artifacts', 'Resource Cleanup', 'Follow-up Disposition'];
  const sections = Object.fromEntries(requiredSections.map((title) => [title, sectionBody(contents, title)]));
  const errors = [];
  if (frontmatter.error) errors.push(frontmatter.error);
  if (frontmatter.duplicates?.length) errors.push(`Duplicate frontmatter fields: ${frontmatter.duplicates.join(', ')}.`);
  if (!frontmatter.attributes.Ticket) errors.push('Discovery result is missing Ticket.');
  if (!frontmatter.attributes.Plan) errors.push('Discovery result is missing Plan.');
  if (!parseFingerprint(frontmatter.attributes['Ticket-Hash'])) errors.push('Discovery result has an invalid Ticket-Hash.');
  if (!parseFingerprint(frontmatter.attributes['Plan-Hash'])) errors.push('Discovery result has an invalid Plan-Hash.');
  if (!/^[0-9a-f]{7,64}$/i.test(frontmatter.attributes.Baseline ?? '')) errors.push('Discovery result has an invalid Baseline.');
  if (!frontmatter.attributes['Generated-At'] || Number.isNaN(Date.parse(frontmatter.attributes['Generated-At']))) errors.push('Discovery result has an invalid Generated-At timestamp.');
  if (!['validated', 'invalidated'].includes(outcome)) errors.push('Discovery result Outcome must be validated or invalidated.');
  if (ticket?.path && frontmatter.attributes.Ticket !== ticket.path) errors.push(`Discovery result Ticket does not match ${ticket.path}.`);
  if (plan?.path && frontmatter.attributes.Plan !== plan.path) errors.push(`Discovery result Plan does not match ${plan.path}.`);
  if (ticketSha256 && parseFingerprint(frontmatter.attributes['Ticket-Hash']) !== ticketSha256) errors.push('Discovery result Ticket-Hash does not match the approved ticket.');
  if (planSha256 && parseFingerprint(frontmatter.attributes['Plan-Hash']) !== planSha256) errors.push('Discovery result Plan-Hash does not match the approved plan.');
  for (const [title, body] of Object.entries(sections)) if (body === undefined || !body.trim()) errors.push(`Discovery result is missing ${title}.`);
  const matrix = sections['Experiment Matrix'] ?? '';
  for (const id of ticket?.activeAcceptanceCriteria ?? []) {
    if (!new RegExp(`\\b${id}\\b`).test(matrix)) errors.push(`Discovery result Experiment Matrix is missing ${id}.`);
  }
  if (matrix && !/fixture|command/i.test(matrix)) errors.push('Discovery result Experiment Matrix is missing fixture or command evidence.');
  if (matrix && !/threshold/i.test(matrix)) errors.push('Discovery result Experiment Matrix is missing predeclared threshold evidence.');
  if (matrix && !/observed/i.test(matrix)) errors.push('Discovery result Experiment Matrix is missing observed-result evidence.');
  if (matrix && !/path|evidence/i.test(matrix)) errors.push('Discovery result Experiment Matrix is missing durable evidence path.');
  if (matrix && !/pass|invalidated|blocked/i.test(matrix)) errors.push('Discovery result Experiment Matrix is missing a disposition.');
  return { kind: 'discovery-result', path, frontmatter: frontmatter.attributes, outcome, sections, errors, valid: errors.length === 0 };
}

export function parseResearchSynthesis(contents, { path } = {}) {
  const frontmatter = parseFrontmatter(contents);
  const normalized = String(contents).replace(/\r\n?/g, '\n');
  const headings = [...normalized.matchAll(/^##[ \t]+Track[ \t]+(R\d+)\b[^\n]*$/gm)];
  const tracks = headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? normalized.search(/^##[ \t]+Cross-Track Synthesis[ \t]*$/m);
    const body = normalized.slice(start, end < start ? normalized.length : end);
    const lines = body.split('\n');
    const evidenceStart = lines.findIndex((line) => /^Evidence Paths:[ \t]*$/.test(line));
    const evidencePaths = [];
    if (evidenceStart >= 0) {
      for (let cursor = evidenceStart + 1; cursor < lines.length; cursor += 1) {
        const item = lines[cursor].match(/^[ \t]*-[ \t]+`?([^`\n]+?)`?[ \t]*$/);
        if (item) evidencePaths.push(item[1].trim());
        else if (lines[cursor].trim()) break;
      }
    }
    return { id: heading[1], evidencePaths, body };
  });
  const trackIds = tracks.map((track) => track.id);
  const trackCount = Number(frontmatter.attributes.Tracks);
  const generatedAt = frontmatter.attributes['Generated-At'];
  const crossTrackSynthesis = sectionBody(normalized, 'Cross-Track Synthesis');
  const globalErrors = [
    ...(frontmatter.error ? [frontmatter.error] : []),
    ...(frontmatter.duplicates?.length ? [`Duplicate frontmatter fields: ${frontmatter.duplicates.join(', ')}.`] : []),
    ...(!frontmatter.attributes.Ticket ? ['Missing research Ticket path.'] : []),
    ...(!/^[0-9a-f]{7,64}$/i.test(frontmatter.attributes.Baseline ?? '') ? ['Missing or invalid research Baseline.'] : []),
    ...(!parseFingerprint(frontmatter.attributes['Ticket-Hash']) ? ['Missing or invalid research Ticket-Hash.'] : []),
    ...(!generatedAt || Number.isNaN(Date.parse(generatedAt)) ? ['Missing or invalid research Generated-At timestamp.'] : []),
    ...(!Number.isInteger(trackCount) || trackCount < 1 || trackCount > 3 || trackCount !== tracks.length ? ['Research Tracks count must match one to three track sections.'] : []),
    ...(duplicates(trackIds).length ? [`Duplicate research track IDs: ${duplicates(trackIds).join(', ')}.`] : []),
    ...(trackIds.some((id, index) => id !== `R${index + 1}`) ? ['Research track IDs must be sequential from R1.'] : []),
    ...(crossTrackSynthesis === undefined || !crossTrackSynthesis.trim() ? ['Missing Cross-Track Synthesis.'] : []),
  ];
  for (const track of tracks) {
    const errors = [];
    if (!/^Question:[ \t]*\S/im.test(track.body)) errors.push(`${track.id} is missing its Question.`);
    if (!track.evidencePaths.length) errors.push(`${track.id} is missing Evidence Paths.`);
    if (!/^Findings:[ \t]*(?:\S|$)/im.test(track.body)) errors.push(`${track.id} is missing Findings.`);
    if (!/^Conflicts:[ \t]*(?:\S|$)/im.test(track.body)) errors.push(`${track.id} is missing Conflicts.`);
    if (!/^Remaining Unknowns:[ \t]*(?:\S|$)/im.test(track.body)) errors.push(`${track.id} is missing Remaining Unknowns.`);
    if (!/^Confidence:[ \t]*(?:high|medium|low)[ \t]*$/im.test(track.body)) errors.push(`${track.id} has a missing or invalid Confidence.`);
    track.errors = errors;
  }
  const errors = [...globalErrors, ...tracks.flatMap((track) => track.errors)];
  return {
    kind: 'research',
    path,
    frontmatter: frontmatter.attributes,
    ticketSha256: parseFingerprint(frontmatter.attributes['Ticket-Hash']),
    baseline: frontmatter.attributes.Baseline,
    generatedAt,
    tracks,
    crossTrackSynthesis,
    globalErrors,
    errors,
  };
}

function pathsIntersect(left, right) {
  const a = left.replace(/^\.\//, '').replace(/\/$/, '');
  const b = right.replace(/^\.\//, '').replace(/\/$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function researchReuseDecision(synthesis, {
  ticketSha256,
  baselineExists = true,
  baselineIsAncestor = true,
  changedPaths = [],
  dirtyPaths = [],
} = {}) {
  const allTrackIds = synthesis.tracks.map((track) => track.id);
  const reasons = [];
  const globalErrors = synthesis.globalErrors ?? (synthesis.errors?.length ? synthesis.errors : []);
  if (globalErrors.length) reasons.push('malformed-synthesis');
  if (!synthesis.ticketSha256 || synthesis.ticketSha256 !== ticketSha256) reasons.push('ticket-changed');
  if (!synthesis.baseline || !baselineExists) reasons.push('baseline-missing');
  else if (!baselineIsAncestor) reasons.push('baseline-not-ancestor');
  if (reasons.length) return { refreshAll: true, refreshTrackIds: allTrackIds, reusableTrackIds: [], reasons };

  const changes = [...new Set([...changedPaths, ...dirtyPaths])];
  const refreshTrackIds = [];
  for (const track of synthesis.tracks) {
    if (track.errors?.length) {
      refreshTrackIds.push(track.id);
      reasons.push(`${track.id}:malformed-track`);
      continue;
    }
    if (!track.evidencePaths.length || track.evidencePaths.some((path) => !path || /[<*>]/.test(path))) {
      refreshTrackIds.push(track.id);
      reasons.push(`${track.id}:missing-or-vague-evidence`);
      continue;
    }
    if (track.evidencePaths.some((evidence) => changes.some((changed) => pathsIntersect(evidence, changed)))) {
      refreshTrackIds.push(track.id);
      reasons.push(`${track.id}:evidence-changed`);
    }
  }
  return {
    refreshAll: false,
    refreshTrackIds,
    reusableTrackIds: allTrackIds.filter((id) => !refreshTrackIds.includes(id)),
    reasons,
  };
}
