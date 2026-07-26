#!/usr/bin/env node
// Renders every artifact that documents `.agents/sdlc.json` from
// `lib/config-schema.mjs`, the single key authority. Nothing here declares a
// key the schema does not; `test/config-reference.test.mjs` re-renders in
// memory and fails the suite the moment the two disagree (AC-013).
//
// `renderConfigReference()` is a pure function of `CONFIG_SCHEMA` so the test
// can compare bytes without touching disk. The CLI entry below only adds the
// filesystem write.
//
// The dotted keys in `CONFIG_SCHEMA` (`beads.mode`, `targets[].gates`,
// `models.tiers.<host>.<tier>`) are walked into a tree once, generically -
// `[]` denotes an array element and `<role>`/`<host>`/`<tier>` are open
// placeholder segments resolved through the exported `PLACEHOLDERS` map. Every
// renderer below (template, both schemas, the docs table) walks that same
// tree instead of hand-matching key names.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA, PLACEHOLDERS, localAllowedTopLevelKeys } from '../lib/config-schema.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Schema tree
// ---------------------------------------------------------------------------

// Splits a dotted key into path segments, turning a trailing `[]` into its
// own token (`targets[].name` -> `['targets', '[]', 'name']`) so a node keyed
// `[]` uniformly represents "the schema for one array element" regardless of
// which field it appears under.
function tokenize(key) {
  return key.replace(/\[\]/g, '.[]').split('.');
}

function isPlaceholder(token) {
  return Object.prototype.hasOwnProperty.call(PLACEHOLDERS, token);
}

// One node per path segment reachable from `CONFIG_SCHEMA`. `entry` is set
// only on the node whose full path exactly matches a schema key (e.g. the
// `targets` node carries the `targets` entry; the array-element node it owns,
// keyed `[]`, carries none - `targets[].name` etc. hang underneath it).
function buildTree(schema) {
  const root = { entry: undefined, children: new Map() };
  for (const field of schema) {
    let node = root;
    for (const token of tokenize(field.key)) {
      if (!node.children.has(token)) node.children.set(token, { entry: undefined, children: new Map() });
      node = node.children.get(token);
    }
    node.entry = field;
  }
  return root;
}

// ---------------------------------------------------------------------------
// template/sdlc.template.json
// ---------------------------------------------------------------------------

// Builds the template value directly from each entry's `example`, skipping
// any key whose path runs through an array-element or placeholder segment:
// those are already covered by their container's own example (`targets`,
// `models.roles`, `models.tiers` each carry a fully-populated example of
// their own), so re-inserting the per-element/per-role/per-host descriptors
// here would either be redundant or literally unrepresentable as JSON (there
// is no concrete key named `<role>`).
export function renderTemplateValue(schema) {
  const root = {};
  for (const field of schema) {
    if (field.example === undefined) continue;
    const tokens = tokenize(field.key);
    if (tokens.some((token) => token === '[]' || isPlaceholder(token))) continue;
    let node = root;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const token = tokens[i];
      if (!isPlainObject(node[token])) node[token] = {};
      node = node[token];
    }
    node[tokens[tokens.length - 1]] = field.example;
  }
  return root;
}

// ---------------------------------------------------------------------------
// JSON Schema (draft 2020-12)
// ---------------------------------------------------------------------------

// A schema `default` must be a value of the field's own declared shape.
// Several `CONFIG_SCHEMA` entries instead carry a prose sentinel (e.g.
// `targets[].reviewers`'s default reads "inherits the top-level reviewers" -
// a sentence, not a string[]); those render into docs as prose but are never
// emitted as a JSON Schema `default`, so the shipped schema never asserts a
// value of the wrong type.
function literalDefaultForSchema(entry) {
  if (!entry || entry.default === undefined) return undefined;
  const { type, default: value } = entry;
  if (type === 'string') return (value === null || typeof value === 'string') ? value : undefined;
  if (type === 'integer') return typeof value === 'number' ? value : undefined;
  if (type === 'enum') return entry.values?.includes(value) ? value : undefined;
  if (type === 'string[]') return Array.isArray(value) ? value : undefined;
  if (type === 'object' || type === 'object[]') return (isPlainObject(value) || Array.isArray(value)) ? value : undefined;
  return undefined;
}

function withEntryMeta(fragment, entry) {
  if (entry?.description) fragment.description = entry.description;
  const defaultValue = literalDefaultForSchema(entry);
  if (defaultValue !== undefined) fragment.default = defaultValue;
  return fragment;
}

function leafSchema(entry) {
  const fragment = {};
  if (entry.type === 'string') {
    fragment.type = 'string';
    if (entry.pattern) fragment.pattern = entry.pattern.source;
  } else if (entry.type === 'integer') {
    fragment.type = 'integer';
  } else if (entry.type === 'enum') {
    fragment.type = 'string';
    fragment.enum = entry.values;
  } else if (entry.type === 'string[]') {
    fragment.type = 'array';
    fragment.items = { type: 'string' };
    if (entry.itemPattern) fragment.items.pattern = entry.itemPattern.source;
  } else {
    throw new Error(`render-config-reference: unsupported leaf type "${entry.type}" for "${entry.key}"`);
  }
  return withEntryMeta(fragment, entry);
}

function plainObjectSchema(node) {
  const properties = {};
  const required = [];
  for (const [token, child] of node.children) {
    properties[token] = nodeToSchema(child);
    if (child.entry?.required) required.push(token);
  }
  const fragment = { type: 'object', properties };
  if (required.length) fragment.required = required;
  fragment.additionalProperties = false;
  return withEntryMeta(fragment, node.entry);
}

// `<role>` has only a `pattern` (an open-ended name), so it renders as
// `patternProperties`. `<host>`/`<tier>` each have a closed `values` list, so
// they render as explicit `properties` - one per declared value, all sharing
// the same subschema. Which branch runs is read from `PLACEHOLDERS`, never
// hand-picked per key name.
function placeholderObjectSchema(node, token) {
  const placeholder = PLACEHOLDERS[token];
  const childSchema = nodeToSchema(node.children.get(token));
  const fragment = { type: 'object' };
  if (placeholder.values) {
    fragment.properties = Object.fromEntries(placeholder.values.map((value) => [value, childSchema]));
  } else if (placeholder.pattern) {
    fragment.patternProperties = { [placeholder.pattern.source]: childSchema };
  } else {
    throw new Error(`render-config-reference: placeholder "${token}" declares neither values nor pattern`);
  }
  fragment.additionalProperties = false;
  return withEntryMeta(fragment, node.entry);
}

function arrayContainerSchema(node) {
  const itemsSchema = nodeToSchema(node.children.get('[]'));
  return withEntryMeta({ type: 'array', items: itemsSchema }, node.entry);
}

function nodeToSchema(node) {
  const tokens = [...node.children.keys()];
  if (tokens.length === 0) return leafSchema(node.entry);
  if (tokens.includes('[]')) return arrayContainerSchema(node);
  const placeholderToken = tokens.find(isPlaceholder);
  if (placeholderToken) return placeholderObjectSchema(node, placeholderToken);
  return plainObjectSchema(node);
}

export function renderSchemaValue(schema) {
  const tree = buildTree(schema);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: './sdlc.schema.json',
    title: 'sdlc shared project configuration (.agents/sdlc.json)',
    description: 'Generated by `npm run config:docs` from lib/config-schema.mjs. Do not hand-edit; see docs/configuration.md.',
    ...plainObjectSchema(tree),
  };
}

// Restricted to `localAllowedTopLevelKeys()` - the boundary derived from
// `localOverridable`, same as the reader's own refusal-by-name check - with
// nothing required: the overlay file is optional and every key inside it is
// too.
export function renderLocalSchemaValue(schema) {
  const tree = buildTree(schema);
  const properties = {};
  for (const key of localAllowedTopLevelKeys()) properties[key] = nodeToSchema(tree.children.get(key));
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: './sdlc.local.schema.json',
    title: 'sdlc machine-scoped configuration overlay (.agents/sdlc.local.json)',
    description: 'Generated by `npm run config:docs` from lib/config-schema.mjs. Do not hand-edit; see docs/configuration.md.',
    type: 'object',
    properties,
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// docs/configuration.md
// ---------------------------------------------------------------------------

function codeOrJson(value) {
  return typeof value === 'string' ? `\`${value}\`` : `\`${JSON.stringify(value)}\``;
}

function formatType(field) {
  return field.type === 'enum' ? `enum (${field.values.join(', ')})` : field.type;
}

function formatDefaultCell(field) {
  if (field.required) return 'required';
  if (field.default === undefined) return 'none';
  const literal = literalDefaultForSchema(field);
  if (literal !== undefined) return codeOrJson(literal);
  return `_${field.default}_`;
}

function keyRow(field) {
  return `| \`${field.key}\` | ${formatType(field)} | ${field.required ? 'Yes' : 'No'} | ${formatDefaultCell(field)} | ${field.localOverridable ? 'Yes' : 'No'} | ${field.description} | ${codeOrJson(field.example)} |`;
}

function legacyRow(field) {
  return `| **${field.legacyLabel}** | \`${field.key}\` |`;
}

export function renderDocsValue(schema) {
  const keyRows = schema.map(keyRow).join('\n');
  const legacyRows = schema.filter((field) => field.legacyLabel).map(legacyRow).join('\n');
  const localKeys = localAllowedTopLevelKeys().map((key) => `\`${key}\``).join(', ');

  return `# Configuration reference

Generated by \`npm run config:docs\` from \`lib/config-schema.mjs\`, the single
authority for the \`.agents/sdlc.json\` key set. Do not hand-edit this file;
change the schema and regenerate.

\`.agents/sdlc.json\` is the shared, committed project configuration.
\`.agents/sdlc.local.json\` is an optional, machine-scoped, Git-ignored overlay
of it. A reader can write a valid \`.agents/sdlc.json\` from this document
alone, without reading \`lib/\`.

## Overlay rules

\`.agents/sdlc.local.json\` may declare only these top-level keys: ${localKeys}.
Every other top-level key is refused *by name* - the boundary is derived from
each key's \`localOverridable\` field in \`lib/config-schema.mjs\`, not a
hand-maintained list, so it cannot silently drift out of step with the schema.
\`local\` and \`models\` merge deep, leaf-wise, between the shared and local
files; arrays and scalars are whole-value replacements, with the local file's
value winning.

## Provenance

Every effective setting reports the file that produced it. \`sdlc config\`,
\`sdlc doctor --json\`, and every \`sdlc guard <stage> --json\` carry a
\`sources\` map keyed by dotted field path (e.g. \`local.reviewEditor\`) whose
value is the repository-relative path of the file that set it, or the literal
string \`default\` when no file did.

## Editor validation

Two JSON Schema (draft 2020-12) documents ship alongside the template:
\`template/sdlc.schema.json\` describes the full \`.agents/sdlc.json\` shape,
and \`template/sdlc.local.schema.json\` describes the restricted
\`.agents/sdlc.local.json\` overlay shape. Point an editor at one by setting
the \`$schema\` key in the file it should validate:

\`\`\`json
{ "$schema": "./sdlc.schema.json", "version": 1 }
\`\`\`

\`$schema\` configures editor tooling only; it has no effect on pipeline
behavior, and is excluded from \`sdlc config\`'s effective-settings listing.

## \`models\` is reserved policy

The \`models\` block validates against this schema, resolves per host, and is
reported by \`sdlc config\`, but **nothing in the pipeline consumes it yet**.
Declaring it today changes no subagent's model or reasoning effort. It ships
now so that adopting a role-to-tier-to-model policy later needs no second
migration and no format change.

## Keys

| Key | Type | Required | Default | Local override | Description | Example |
|---|---|---|---|---|---|---|
${keyRows}

## Legacy migration

Projects created before 0.6.0 declared these settings as Markdown under
\`## Project Configuration\` in \`thoughts/AGENTS.md\`. That section is gone;
\`sdlc setup\` refuses to run while it remains. Move each value by hand to the
dotted key that replaced it, then delete the section:

| Old label (\`## Project Configuration\`) | New key |
|---|---|
${legacyRows}
`;
}

// ---------------------------------------------------------------------------
// Public surface + CLI entry
// ---------------------------------------------------------------------------

export function renderConfigReference() {
  return {
    'template/sdlc.template.json': `${JSON.stringify(renderTemplateValue(CONFIG_SCHEMA), null, 2)}\n`,
    'template/sdlc.schema.json': `${JSON.stringify(renderSchemaValue(CONFIG_SCHEMA), null, 2)}\n`,
    'template/sdlc.local.schema.json': `${JSON.stringify(renderLocalSchemaValue(CONFIG_SCHEMA), null, 2)}\n`,
    'docs/configuration.md': renderDocsValue(CONFIG_SCHEMA),
  };
}

function main() {
  const artifacts = renderConfigReference();
  for (const [relativePath, contents] of Object.entries(artifacts)) {
    const absolute = join(REPO_ROOT, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
    console.log(`wrote ${relativePath}`);
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) main();
