import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function withoutComment(value) {
  return String(value ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function codeValues(value) {
  return [...String(value ?? '').matchAll(/`([^`]*)`/g)].map((match) => match[1]);
}

function scalar(value) {
  const clean = withoutComment(value);
  const codes = codeValues(clean);
  if (codes.length === 1 && clean.replace(/`[^`]*`/g, '').trim() === '') return codes[0].trim();
  return clean.replace(/^`|`$/g, '').trim();
}

function splitValues(value) {
  const clean = scalar(value);
  if (!clean || /^none$/i.test(clean)) return [];
  return clean.split(/\s*(?:\||,)\s*/).map((item) => item.trim()).filter(Boolean);
}

function configurationBody(contents) {
  const normalized = String(contents ?? '').replace(/\r\n?/g, '\n');
  const heading = /^##[ \t]+Project Configuration[ \t]*$/m.exec(normalized);
  // Preserve compatibility with early generated contracts that placed the
  // same bold fields at top level before the section became explicit.
  if (!heading) return normalized;
  const remainder = normalized.slice(heading.index + heading[0].length).replace(/^\n/, '');
  const next = /^##[ \t]+/m.exec(remainder);
  return next ? remainder.slice(0, next.index) : remainder;
}

function fieldLine(line) {
  const match = line.match(/^\s*-[ \t]+\*\*([^*]+?):\*\*[ \t]*(.*)$/);
  if (!match) return null;
  return { label: match[1].trim(), value: withoutComment(match[2]) };
}

function arrow(value) {
  const clean = scalar(value);
  const index = clean.indexOf('->');
  if (index < 1) return null;
  const target = clean.slice(0, index).trim();
  const mapped = clean.slice(index + 2).trim();
  return target && mapped ? { target, value: mapped } : null;
}

function appendMapping(map, target, value) {
  if (!map[target]) map[target] = [];
  map[target].push(value);
}

function appendPaths(map, target, paths) {
  map[target] = [...new Set([...(map[target] ?? []), ...paths])];
}

function mappingEntries(value, { splitSemicolons = false } = {}) {
  const codes = codeValues(withoutComment(value));
  // A mapping value may itself be an opaque shell command. Never split on
  // semicolons for gate mappings. Non-command maps retain their compact
  // semicolon-separated form for backwards compatibility.
  const raw = codes.length ? codes : [scalar(value)].filter(Boolean);
  const candidates = splitSemicolons
    ? raw.flatMap((candidate) => candidate.split(/\s*;\s*/).filter(Boolean))
    : raw;
  return candidates.map(arrow).filter(Boolean);
}

/**
 * Parse the deliberately small Markdown grammar in `## Project Configuration`.
 * Commands are retained as opaque shell strings; parsing never tokenizes or
 * rewrites quotes, pipes, redirects, or boolean shell operators.
 */
export function parseProjectConfig(contents) {
  const body = configurationBody(contents);
  const lines = body.split('\n');
  const values = new Map();
  const qualityGates = [];
  const targetGates = {};
  const targetPaths = {};
  const reviewers = {};
  const errors = [];
  let listField = null;

  for (const line of lines) {
    const field = fieldLine(line);
    if (field) {
      listField = null;
      const label = field.label.toLowerCase();
      if (label === 'quality gates') {
        const codes = codeValues(field.value);
        if (codes.length) qualityGates.push(...codes.map((command) => command.trim()).filter(Boolean));
        else if (scalar(field.value) && !/^none$/i.test(scalar(field.value))) qualityGates.push(scalar(field.value));
        else if (!scalar(field.value)) listField = 'quality-gates';
      } else if (label === 'target gates') {
        const entries = mappingEntries(field.value);
        if (!entries.length && field.value) errors.push(`Malformed Target gates entry: ${field.value}`);
        for (const entry of entries) appendMapping(targetGates, entry.target, entry.value);
      } else if (label.startsWith('target gates ')) {
        const entry = arrow(`${field.label.slice('target gates'.length).trim()} ${field.value}`);
        if (!entry) errors.push(`Malformed Target gates entry: ${field.label} ${field.value}`.trim());
        else appendMapping(targetGates, entry.target, entry.value);
      } else if (label === 'target paths') {
        const entries = mappingEntries(field.value, { splitSemicolons: true });
        if (!entries.length && field.value) errors.push(`Malformed Target paths entry: ${field.value}`);
        for (const entry of entries) appendPaths(targetPaths, entry.target, splitValues(entry.value));
      } else if (label.startsWith('target paths ')) {
        const entry = arrow(`${field.label.slice('target paths'.length).trim()} ${field.value}`);
        if (!entry) errors.push(`Malformed Target paths entry: ${field.label} ${field.value}`.trim());
        else appendPaths(targetPaths, entry.target, splitValues(entry.value));
      } else if (label === 'reviewers') {
        const entries = mappingEntries(field.value, { splitSemicolons: true });
        for (const entry of entries) appendPaths(reviewers, entry.target, splitValues(entry.value));
      } else {
        values.set(label, scalar(field.value));
      }
      continue;
    }

    const listItem = line.match(/^\s{2,}-[ \t]+(.+)$/)?.[1];
    if (listField === 'quality-gates' && listItem) {
      const command = scalar(listItem);
      if (command) qualityGates.push(command);
      continue;
    }

    // Also accept the literal line grammar documented by the CLI contract:
    // `Target gates: <target> -> <command>` and `Target paths: ...`.
    const plain = withoutComment(line).replace(/^\s*-[ \t]+/, '').replace(/^\*\*|\*\*$/g, '');
    for (const [prefix, destination] of [['Target gates:', targetGates], ['Target paths:', targetPaths]]) {
      if (!plain.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const entry = arrow(plain.slice(prefix.length));
      if (!entry) errors.push(`Malformed ${prefix.slice(0, -1)} entry: ${plain.slice(prefix.length).trim()}`);
      else if (prefix === 'Target gates:') appendMapping(destination, entry.target, entry.value);
      else appendPaths(destination, entry.target, splitValues(entry.value));
    }
  }

  const targets = splitValues(values.get('targets'));
  const knownTargets = new Set(targets);
  for (const target of [...Object.keys(targetGates), ...Object.keys(targetPaths)]) {
    if (knownTargets.size && !knownTargets.has(target)) errors.push(`Project Configuration references unknown target ${JSON.stringify(target)}.`);
  }
  if (qualityGates.some((command) => !command.trim())) errors.push('Quality gates contains an empty command.');

  const mode = values.get('beads mode');
  const mergeSlot = values.get('beads merge slot');
  if (mode && !['embedded', 'server'].includes(mode)) errors.push(`Project Configuration has invalid Beads mode ${JSON.stringify(mode)}.`);
  if (mergeSlot && !['off', 'on'].includes(mergeSlot)) errors.push(`Project Configuration has invalid Beads merge slot ${JSON.stringify(mergeSlot)}.`);

  return {
    targets,
    qualityGates,
    targetGates,
    targetPaths,
    reviewers,
    productDocs: values.get('product docs') || 'thoughts/docs/',
    frontendConstraints: values.get('frontend constraints') || 'none',
    beadsMode: mode === 'server' ? 'server' : 'embedded',
    mergeSlotEnabled: mergeSlot === 'on',
    reviewEditor: values.get('review editor') || null,
    localPreview: values.get('local preview') || null,
    previewUrl: values.get('preview url') || null,
    errors: [...new Set(errors)],
  };
}

export function readProjectConfig(root = process.cwd()) {
  const path = join(root, 'thoughts', 'AGENTS.md');
  const contents = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { path, ...parseProjectConfig(contents) };
}

export function configuredGateCommands(config, target, adHocCommands = []) {
  if (target && !config.targets.includes(target)) {
    throw new TypeError(`Unknown target ${JSON.stringify(target)}; configured targets: ${config.targets.join(', ') || 'none'}.`);
  }
  const commands = [
    ...config.qualityGates.map((command) => ({ command, source: 'global' })),
    ...(target ? (config.targetGates[target] ?? []).map((command) => ({ command, source: `target:${target}` })) : []),
    ...adHocCommands.map((command) => ({ command, source: 'ad-hoc' })),
  ];
  if (!commands.length) throw new TypeError('No quality gates are configured for this scope.');
  return commands;
}

function globSpecificity(glob) {
  const literal = glob.replace(/[*?]/g, '');
  const wildcards = (glob.match(/[*?]/g) ?? []).length;
  return literal.length * 10 - wildcards;
}

export function classifyTargetPath(path, config, matchesGlob) {
  const matches = [];
  for (const target of config.targets) {
    for (const glob of config.targetPaths[target] ?? []) {
      if (matchesGlob(path, glob)) matches.push({ target, glob, specificity: globSpecificity(glob) });
    }
  }
  // Overlaps intentionally retain every target. Specificity determines only
  // deterministic precedence/order; it never silently discards a second lane.
  matches.sort((left, right) => right.specificity - left.specificity
    || config.targets.indexOf(left.target) - config.targets.indexOf(right.target)
    || left.glob.localeCompare(right.glob));
  return [...new Set(matches.map((match) => match.target))];
}
