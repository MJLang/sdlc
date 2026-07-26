import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_SCHEMA, CONFIG_VERSION, PLACEHOLDERS,
  localAllowedTopLevelKeys, sharedOnlyTopLevelKeys,
} from './config-schema.mjs';

const DEFAULT_SHARED_PATH = '.agents/sdlc.json';
const DEFAULT_LOCAL_PATH = '.agents/sdlc.local.json';

// Step 2 legacy detection: match only the heading itself, never its body -
// the Markdown grammar it once introduced is gone, and this detector must
// not try to resurrect a reader for it. Bold field labels (`- **Label:**`)
// are collected as plain prose for the error message; their values are never
// parsed.
const LEGACY_HEADING = /^##[ \t]+Project Configuration[ \t]*$/m;
const LEGACY_FIELD_LABEL = /^-[ \t]*\*\*([^*]+)\*\*/gm;

// Fields this authority declares `meta: true` (currently only `$schema`)
// configure tooling, not the pipeline, so `configProjection` excludes them
// from provenance the same way `parseProjectConfig` gives them no slot in
// the resolved shape below.
const META_KEYS = new Set(CONFIG_SCHEMA.filter((field) => field.meta).map((field) => field.key));

// The one lookup the validator needs into the schema authority: every enum's
// `values`, and every constrained field's `pattern`/`itemPattern`, are read
// from here rather than re-declared. `PLACEHOLDERS` (imported above) covers
// the open-ended `<role>`/`<host>`/`<tier>` segments the same way.
const SCHEMA_BY_KEY = new Map(CONFIG_SCHEMA.map((field) => [field.key, field]));

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  if (type === 'undefined') return 'undefined';
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

// Every validation message names the file and the dotted field path it
// belongs to, then a detail sentence. This is the one place that shape is
// assembled, so every message stays uniform:
// `.agents/sdlc.json: beads.mode "cluster" is not one of embedded|server.`
function fieldError(errors, file, path, detail) {
  errors.push(`${file}: ${path} ${detail}.`);
}

function readString(raw, file, path, errors, fallback) {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string') {
    fieldError(errors, file, path, `must be a string; found ${describeType(raw)}`);
    return fallback;
  }
  return raw;
}

// `itemPattern` comes from the calling field's own `CONFIG_SCHEMA` entry
// (undefined when that field has none, e.g. `reviewers`, which allows blank
// entries). `blankMessage` is prose, not schema data, so it stays a call-site
// parameter — the same rule reads as "is empty" for a glob and "is empty or
// whitespace-only" for a gate command.
function readStringArray(raw, file, path, errors, { itemPattern, blankMessage = 'is empty or whitespace-only' } = {}) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    fieldError(errors, file, path, `must be an array; found ${describeType(raw)}`);
    return [];
  }
  const result = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      fieldError(errors, file, `${path}[${index}]`, `must be a string; found ${describeType(item)}`);
      return;
    }
    if (itemPattern && !itemPattern.test(item)) {
      fieldError(errors, file, `${path}[${index}]`, blankMessage);
      return;
    }
    result.push(item);
  });
  return result;
}

function readTargets(raw, file, errors) {
  const targets = [];
  const targetGates = {};
  const targetPaths = {};
  const targetReviewers = {};
  const sources = new Map();
  if (raw === undefined) {
    fieldError(errors, file, 'targets', 'is required');
    return { targets, targetGates, targetPaths, targetReviewers, sources };
  }
  if (!Array.isArray(raw)) {
    fieldError(errors, file, 'targets', `must be an array; found ${describeType(raw)}`);
    return { targets, targetGates, targetPaths, targetReviewers, sources };
  }
  const namePattern = SCHEMA_BY_KEY.get('targets[].name').pattern;
  const pathsItemPattern = SCHEMA_BY_KEY.get('targets[].paths').itemPattern;
  const gatesItemPattern = SCHEMA_BY_KEY.get('targets[].gates').itemPattern;
  const seenAt = new Map();
  raw.forEach((entry, index) => {
    const prefix = `targets[${index}]`;
    if (!isPlainObject(entry)) {
      fieldError(errors, file, prefix, `must be an object; found ${describeType(entry)}`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!['name', 'paths', 'gates', 'reviewers'].includes(key)) fieldError(errors, file, `${prefix}.${key}`, 'is not a recognized key');
    }
    const { name } = entry;
    if (name === undefined) {
      fieldError(errors, file, `${prefix}.name`, 'is required');
      return;
    }
    if (typeof name !== 'string' || !namePattern.test(name)) {
      fieldError(errors, file, `${prefix}.name`, `${JSON.stringify(name)} does not match ${namePattern}`);
      return;
    }
    if (seenAt.has(name)) fieldError(errors, file, `${prefix}.name`, `${JSON.stringify(name)} duplicates targets[${seenAt.get(name)}].name`);
    else seenAt.set(name, index);
    sources.set(`${prefix}.name`, file);
    targets.push(name);

    const paths = readStringArray(entry.paths, file, `${prefix}.paths`, errors, { itemPattern: pathsItemPattern, blankMessage: 'is empty' });
    targetPaths[name] = paths ?? [];
    if (entry.paths !== undefined) sources.set(`${prefix}.paths`, file);

    const gates = readStringArray(entry.gates, file, `${prefix}.gates`, errors, { itemPattern: gatesItemPattern });
    targetGates[name] = gates ?? [];
    if (entry.gates !== undefined) sources.set(`${prefix}.gates`, file);

    const reviewers = readStringArray(entry.reviewers, file, `${prefix}.reviewers`, errors);
    if (reviewers !== undefined) {
      targetReviewers[name] = reviewers;
      sources.set(`${prefix}.reviewers`, file);
    }
  });
  return { targets, targetGates, targetPaths, targetReviewers, sources };
}

function readBeads(raw, file, errors) {
  const modeValues = SCHEMA_BY_KEY.get('beads.mode').values;
  const mergeSlotValues = SCHEMA_BY_KEY.get('beads.mergeSlot').values;
  const result = { mode: 'embedded', mergeSlot: 'off' };
  const sources = new Map();
  if (raw === undefined) return { result, sources };
  if (!isPlainObject(raw)) {
    fieldError(errors, file, 'beads', `must be an object; found ${describeType(raw)}`);
    return { result, sources };
  }
  for (const key of Object.keys(raw)) if (!['mode', 'mergeSlot'].includes(key)) fieldError(errors, file, `beads.${key}`, 'is not a recognized key');
  if (raw.mode !== undefined) {
    if (!modeValues.includes(raw.mode)) fieldError(errors, file, 'beads.mode', `${JSON.stringify(raw.mode)} is not one of ${modeValues.join('|')}`);
    else {
      result.mode = raw.mode;
      sources.set('beads.mode', file);
    }
  }
  if (raw.mergeSlot !== undefined) {
    if (!mergeSlotValues.includes(raw.mergeSlot)) fieldError(errors, file, 'beads.mergeSlot', `${JSON.stringify(raw.mergeSlot)} is not one of ${mergeSlotValues.join('|')}`);
    else {
      result.mergeSlot = raw.mergeSlot;
      sources.set('beads.mergeSlot', file);
    }
  }
  return { result, sources };
}

// `local` and `models` may each be declared in either file. Every call site
// below produces a partial tree carrying only the leaves the file actually
// set (no baked-in defaults), so `deepMergeWithSources` can tell "the local
// overlay set this" apart from "this fell through to the schema default".
function readLocalPartial(raw, file, errors) {
  const result = {};
  if (raw === undefined) return result;
  if (!isPlainObject(raw)) {
    fieldError(errors, file, 'local', `must be an object; found ${describeType(raw)}`);
    return result;
  }
  for (const key of Object.keys(raw)) if (!['reviewEditor', 'preview'].includes(key)) fieldError(errors, file, `local.${key}`, 'is not a recognized key');
  if (raw.reviewEditor !== undefined) {
    if (typeof raw.reviewEditor !== 'string') fieldError(errors, file, 'local.reviewEditor', `must be a string; found ${describeType(raw.reviewEditor)}`);
    else result.reviewEditor = raw.reviewEditor;
  }
  if (raw.preview !== undefined) {
    if (!isPlainObject(raw.preview)) {
      fieldError(errors, file, 'local.preview', `must be an object; found ${describeType(raw.preview)}`);
    } else {
      for (const key of Object.keys(raw.preview)) if (!['command', 'url'].includes(key)) fieldError(errors, file, `local.preview.${key}`, 'is not a recognized key');
      const preview = {};
      if (raw.preview.command !== undefined) {
        if (typeof raw.preview.command !== 'string') fieldError(errors, file, 'local.preview.command', `must be a string; found ${describeType(raw.preview.command)}`);
        else preview.command = raw.preview.command;
      }
      if (raw.preview.url !== undefined) {
        if (typeof raw.preview.url !== 'string') fieldError(errors, file, 'local.preview.url', `must be a string; found ${describeType(raw.preview.url)}`);
        else preview.url = raw.preview.url;
      }
      if (Object.keys(preview).length) result.preview = preview;
    }
  }
  return result;
}

function readModelsPartial(raw, file, errors) {
  const result = {};
  if (raw === undefined) return result;
  if (!isPlainObject(raw)) {
    fieldError(errors, file, 'models', `must be an object; found ${describeType(raw)}`);
    return result;
  }
  for (const key of Object.keys(raw)) if (!['defaults', 'roles', 'tiers'].includes(key)) fieldError(errors, file, `models.${key}`, 'is not a recognized key');

  if (raw.defaults !== undefined) {
    if (!isPlainObject(raw.defaults)) {
      fieldError(errors, file, 'models.defaults', `must be an object; found ${describeType(raw.defaults)}`);
    } else {
      for (const key of Object.keys(raw.defaults)) if (!['tier', 'effort'].includes(key)) fieldError(errors, file, `models.defaults.${key}`, 'is not a recognized key');
      const tierValues = SCHEMA_BY_KEY.get('models.defaults.tier').values;
      const effortValues = SCHEMA_BY_KEY.get('models.defaults.effort').values;
      const defaults = {};
      if (raw.defaults.tier !== undefined) {
        if (!tierValues.includes(raw.defaults.tier)) fieldError(errors, file, 'models.defaults.tier', `${JSON.stringify(raw.defaults.tier)} is not one of ${tierValues.join('|')}`);
        else defaults.tier = raw.defaults.tier;
      }
      if (raw.defaults.effort !== undefined) {
        if (!effortValues.includes(raw.defaults.effort)) fieldError(errors, file, 'models.defaults.effort', `${JSON.stringify(raw.defaults.effort)} is not one of ${effortValues.join('|')}`);
        else defaults.effort = raw.defaults.effort;
      }
      result.defaults = defaults;
    }
  }

  if (raw.roles !== undefined) {
    if (!isPlainObject(raw.roles)) {
      fieldError(errors, file, 'models.roles', `must be an object; found ${describeType(raw.roles)}`);
    } else {
      const roles = {};
      const rolePattern = PLACEHOLDERS['<role>'].pattern;
      const tierValues = SCHEMA_BY_KEY.get('models.roles.<role>.tier').values;
      const effortValues = SCHEMA_BY_KEY.get('models.roles.<role>.effort').values;
      for (const [role, value] of Object.entries(raw.roles)) {
        if (!rolePattern.test(role)) {
          fieldError(errors, file, `models.roles.${role}`, `role name does not match ${rolePattern}`);
          continue;
        }
        if (!isPlainObject(value)) {
          fieldError(errors, file, `models.roles.${role}`, `must be an object; found ${describeType(value)}`);
          continue;
        }
        for (const key of Object.keys(value)) if (!['tier', 'effort'].includes(key)) fieldError(errors, file, `models.roles.${role}.${key}`, 'is not a recognized key');
        const entry = {};
        if (value.tier !== undefined) {
          if (!tierValues.includes(value.tier)) fieldError(errors, file, `models.roles.${role}.tier`, `${JSON.stringify(value.tier)} is not one of ${tierValues.join('|')}`);
          else entry.tier = value.tier;
        }
        if (value.effort !== undefined) {
          if (!effortValues.includes(value.effort)) fieldError(errors, file, `models.roles.${role}.effort`, `${JSON.stringify(value.effort)} is not one of ${effortValues.join('|')}`);
          else entry.effort = value.effort;
        }
        roles[role] = entry;
      }
      result.roles = roles;
    }
  }

  if (raw.tiers !== undefined) {
    if (!isPlainObject(raw.tiers)) {
      fieldError(errors, file, 'models.tiers', `must be an object; found ${describeType(raw.tiers)}`);
    } else {
      const tiers = {};
      const hostValues = PLACEHOLDERS['<host>'].values;
      const tierValues = PLACEHOLDERS['<tier>'].values;
      const modelPattern = SCHEMA_BY_KEY.get('models.tiers.<host>.<tier>').pattern;
      for (const [host, value] of Object.entries(raw.tiers)) {
        if (!hostValues.includes(host)) {
          fieldError(errors, file, `models.tiers.${host}`, `is not a declared host; expected one of ${hostValues.join('|')}`);
          continue;
        }
        if (!isPlainObject(value)) {
          fieldError(errors, file, `models.tiers.${host}`, `must be an object; found ${describeType(value)}`);
          continue;
        }
        const hostTiers = {};
        for (const [tier, model] of Object.entries(value)) {
          if (!tierValues.includes(tier)) {
            fieldError(errors, file, `models.tiers.${host}.${tier}`, `is not one of ${tierValues.join('|')}`);
            continue;
          }
          if (typeof model !== 'string' || !modelPattern.test(model)) {
            fieldError(errors, file, `models.tiers.${host}.${tier}`, 'must be a non-empty string');
            continue;
          }
          hostTiers[tier] = model;
        }
        tiers[host] = hostTiers;
      }
      result.tiers = tiers;
    }
  }
  return result;
}

// Deep, leaf-wise merge of two partial value trees built by the readers
// above. Objects recurse (this is how the open-ended `models.roles.<role>`
// and `models.tiers.<host>` maps merge without special-casing); anything
// else is a whole-value replacement, with the overlay winning and recording
// its file as the provenance for that leaf.
function deepMergeWithSources(base, baseFile, overlay, overlayFile, sources, prefix) {
  const result = {};
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(overlay ?? {})]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const baseValue = base?.[key];
    const overlayValue = overlay?.[key];
    if (isPlainObject(baseValue) || isPlainObject(overlayValue)) {
      result[key] = deepMergeWithSources(
        isPlainObject(baseValue) ? baseValue : {}, baseFile,
        isPlainObject(overlayValue) ? overlayValue : {}, overlayFile,
        sources, path,
      );
    } else if (overlayValue !== undefined) {
      result[key] = overlayValue;
      sources.set(path, overlayFile);
    } else if (baseValue !== undefined) {
      result[key] = baseValue;
      sources.set(path, baseFile);
    }
  }
  return result;
}

// The schema-shaped nested tree `sdlc config`'s dotted-key lookups walk
// (`beads.mode`, `models.defaults.tier`), built from the flat legacy fields
// below rather than a second parse pass. Every consumer of the flat shape -
// `parseProjectConfig`'s own return value, `configProjection`, and hand-built
// fixture configs in `guard`/`snapshot` tests that never set `resolved`
// themselves - can produce this tree the same way, so it stays correct
// wherever a flat-fielded config object shows up.
function buildResolvedTree(config) {
  const targets = (config.targets ?? []).map((name) => ({
    name,
    paths: config.targetPaths?.[name] ?? [],
    gates: config.targetGates?.[name] ?? [],
    reviewers: config.reviewers?.[name] ?? [],
  }));
  return {
    version: config.version ?? null,
    targets,
    gates: config.qualityGates ?? [],
    reviewers: config.defaultReviewers ?? [],
    productDocs: config.productDocs ?? 'thoughts/docs/',
    frontendConstraints: config.frontendConstraints ?? 'none',
    beads: {
      mode: config.beadsMode ?? 'embedded',
      mergeSlot: config.mergeSlotEnabled ? 'on' : 'off',
    },
    local: {
      reviewEditor: config.reviewEditor ?? null,
      preview: {
        command: config.localPreview ?? null,
        url: config.previewUrl ?? null,
      },
    },
    models: config.models ?? { defaults: { tier: 'balanced', effort: 'medium' }, roles: {}, tiers: {} },
  };
}

// Walks a dotted/bracketed field path (`targets[0].paths`, `beads.mode`,
// `models.roles.plan-reviewer.tier`) against a resolved tree - the same
// segment grammar `sources` keys use, so `effectiveSettings` needs no
// per-field special-casing.
function getByPath(root, path) {
  const segments = path.match(/[^.[\]]+/g) ?? [];
  let value = root;
  for (const segment of segments) {
    if (value === undefined || value === null) return undefined;
    value = value[/^\d+$/.test(segment) ? Number(segment) : segment];
  }
  return value;
}

function emptyResolvedConfig({ sharedPath, localPath, localExists, errors }) {
  const result = {
    version: null,
    path: sharedPath,
    localPath: localExists ? localPath : null,
    targets: [],
    qualityGates: [],
    targetGates: {},
    targetPaths: {},
    reviewers: {},
    defaultReviewers: [],
    productDocs: 'thoughts/docs/',
    frontendConstraints: 'none',
    beadsMode: 'embedded',
    mergeSlotEnabled: false,
    reviewEditor: null,
    localPreview: null,
    previewUrl: null,
    models: { defaults: { tier: 'balanced', effort: 'medium' }, roles: {}, tiers: {} },
    sources: {},
    errors: [...new Set(errors)],
  };
  return { ...result, resolved: buildResolvedTree(result) };
}

/**
 * Pure validator/resolver over already-read file contents, so tests can
 * exercise every case without touching disk. `shared`/`local` are raw JSON
 * text, or `null`/`undefined` when the file does not exist. Gate and target
 * path strings are treated as opaque: this function never tokenizes, splits,
 * or requotes them (AC-007).
 */
export function parseProjectConfig(shared, local, { sharedPath = DEFAULT_SHARED_PATH, localPath = DEFAULT_LOCAL_PATH } = {}) {
  const errors = [];

  if (shared === null || shared === undefined) {
    errors.push(`${sharedPath} is missing. Copy template/sdlc.template.json to ${sharedPath} (\`sdlc setup\` installs it) and configure targets and gates.`);
    return emptyResolvedConfig({ sharedPath, localPath, localExists: false, errors });
  }

  let sharedRoot;
  try {
    sharedRoot = JSON.parse(shared);
  } catch (error) {
    errors.push(`${sharedPath} is not valid JSON: ${error.message}.`);
    return emptyResolvedConfig({ sharedPath, localPath, localExists: false, errors });
  }
  if (!isPlainObject(sharedRoot)) {
    errors.push(`${sharedPath} must contain a JSON object at the root; found ${describeType(sharedRoot)}.`);
    return emptyResolvedConfig({ sharedPath, localPath, localExists: false, errors });
  }

  const localExists = local !== null && local !== undefined;
  let localRoot = {};
  if (localExists) {
    try {
      localRoot = JSON.parse(local);
    } catch (error) {
      errors.push(`${localPath} is not valid JSON: ${error.message}.`);
      localRoot = {};
    }
    if (!isPlainObject(localRoot)) {
      errors.push(`${localPath} must contain a JSON object at the root; found ${describeType(localRoot)}.`);
      localRoot = {};
    }
  }

  const localAllowed = new Set(localAllowedTopLevelKeys());
  const knownTop = new Set([...localAllowed, ...sharedOnlyTopLevelKeys()]);
  for (const key of Object.keys(sharedRoot)) if (!knownTop.has(key)) fieldError(errors, sharedPath, key, 'is not a recognized key');
  for (const key of Object.keys(localRoot)) {
    if (!knownTop.has(key)) fieldError(errors, localPath, key, 'is not a recognized key');
    else if (!localAllowed.has(key)) fieldError(errors, localPath, key, `is a shared-only key and must be set in ${sharedPath}`);
  }

  const sources = new Map();

  // `version` is required — like `targets`, its absence is refused rather
  // than defaulted, so the "required" column Step 4 renders from this same
  // schema entry stays true.
  let version = null;
  if (sharedRoot.version === undefined) {
    fieldError(errors, sharedPath, 'version', 'is required');
  } else if (sharedRoot.version !== CONFIG_VERSION) {
    fieldError(errors, sharedPath, 'version', `${JSON.stringify(sharedRoot.version)} is not supported; expected ${CONFIG_VERSION}`);
  } else {
    version = sharedRoot.version;
    sources.set('version', sharedPath);
  }
  if (localRoot.version !== undefined && localRoot.version !== CONFIG_VERSION) {
    fieldError(errors, localPath, 'version', `${JSON.stringify(localRoot.version)} is not supported; expected ${CONFIG_VERSION}`);
  }
  if (!sources.has('version')) sources.set('version', 'default');

  // `$schema` is a meta key (see its CONFIG_SCHEMA entry): it configures
  // editor tooling, not the pipeline, so beyond type-checking and provenance
  // it is otherwise ignored — it has no slot in the shape this function
  // returns.
  if (sharedRoot.$schema !== undefined && typeof sharedRoot.$schema !== 'string') {
    fieldError(errors, sharedPath, '$schema', `must be a string; found ${describeType(sharedRoot.$schema)}`);
  }
  if (localRoot.$schema !== undefined && typeof localRoot.$schema !== 'string') {
    fieldError(errors, localPath, '$schema', `must be a string; found ${describeType(localRoot.$schema)}`);
  }
  if (typeof localRoot.$schema === 'string') sources.set('$schema', localPath);
  else if (typeof sharedRoot.$schema === 'string') sources.set('$schema', sharedPath);
  else sources.set('$schema', 'default');

  const { targets, targetGates, targetPaths, targetReviewers, sources: targetSources } = readTargets(sharedRoot.targets, sharedPath, errors);
  // The container is recorded before its elements so `effectiveSettings`,
  // which walks `sources` in insertion order, lists `targets` ahead of the
  // `targets[0].*` lines it summarizes.
  sources.set('targets', sharedRoot.targets !== undefined ? sharedPath : 'default');
  for (const [path, file] of targetSources) sources.set(path, file);

  const qualityGates = readStringArray(sharedRoot.gates, sharedPath, 'gates', errors, { itemPattern: SCHEMA_BY_KEY.get('gates').itemPattern }) ?? [];
  sources.set('gates', sharedRoot.gates !== undefined ? sharedPath : 'default');

  const defaultReviewers = readStringArray(sharedRoot.reviewers, sharedPath, 'reviewers', errors) ?? [];
  sources.set('reviewers', sharedRoot.reviewers !== undefined ? sharedPath : 'default');

  const productDocs = readString(sharedRoot.productDocs, sharedPath, 'productDocs', errors, 'thoughts/docs/');
  sources.set('productDocs', sharedRoot.productDocs !== undefined ? sharedPath : 'default');

  const frontendConstraints = readString(sharedRoot.frontendConstraints, sharedPath, 'frontendConstraints', errors, 'none');
  sources.set('frontendConstraints', sharedRoot.frontendConstraints !== undefined ? sharedPath : 'default');

  const { result: beads, sources: beadsSources } = readBeads(sharedRoot.beads, sharedPath, errors);
  for (const [path, file] of beadsSources) sources.set(path, file);
  if (!sources.has('beads.mode')) sources.set('beads.mode', 'default');
  if (!sources.has('beads.mergeSlot')) sources.set('beads.mergeSlot', 'default');

  const sharedLocalPartial = readLocalPartial(sharedRoot.local, sharedPath, errors);
  const overlayLocalPartial = readLocalPartial(localRoot.local, localPath, errors);
  const mergedLocal = deepMergeWithSources(sharedLocalPartial, sharedPath, overlayLocalPartial, localPath, sources, 'local');
  if (!sources.has('local.reviewEditor')) sources.set('local.reviewEditor', 'default');
  if (!sources.has('local.preview.command')) sources.set('local.preview.command', 'default');
  if (!sources.has('local.preview.url')) sources.set('local.preview.url', 'default');

  const sharedModelsPartial = readModelsPartial(sharedRoot.models, sharedPath, errors);
  const overlayModelsPartial = readModelsPartial(localRoot.models, localPath, errors);
  const mergedModels = deepMergeWithSources(sharedModelsPartial, sharedPath, overlayModelsPartial, localPath, sources, 'models');
  const models = {
    defaults: {
      tier: mergedModels.defaults?.tier ?? 'balanced',
      effort: mergedModels.defaults?.effort ?? 'medium',
    },
    roles: mergedModels.roles ?? {},
    tiers: mergedModels.tiers ?? {},
  };
  if (!sources.has('models.defaults.tier')) sources.set('models.defaults.tier', 'default');
  if (!sources.has('models.defaults.effort')) sources.set('models.defaults.effort', 'default');

  // Cross-field check: a role's effective tier must resolve to a model for
  // every host that declares a tier map at all (a host absent from
  // `models.tiers` entirely is not an authoring error — nothing has claimed
  // it yet).
  for (const [host, hostTiers] of Object.entries(models.tiers)) {
    for (const [role, roleConfig] of Object.entries(models.roles)) {
      const tier = roleConfig.tier ?? models.defaults.tier;
      if (hostTiers[tier] !== undefined) continue;
      // Tier and tier-map can each live in either file, so there is no single
      // "owner" of this mismatch. Blame whichever file supplied the tier
      // value: it is the side asking for something the host doesn't offer,
      // so it is the more actionable file to point a reader at.
      const tierSourcePath = roleConfig.tier !== undefined ? `models.roles.${role}.tier` : 'models.defaults.tier';
      const attributedFile = sources.get(tierSourcePath) === localPath ? localPath : sharedPath;
      fieldError(errors, attributedFile, `models.roles.${role}.tier`, `"${tier}" has no entry in models.tiers.${host} for declared host ${JSON.stringify(host)}`);
    }
  }

  const reviewers = {};
  for (const name of targets) reviewers[name] = targetReviewers[name]?.length ? targetReviewers[name] : defaultReviewers;

  const result = {
    version,
    path: sharedPath,
    localPath: localExists ? localPath : null,
    targets,
    qualityGates,
    targetGates,
    targetPaths,
    reviewers,
    defaultReviewers,
    productDocs,
    frontendConstraints,
    beadsMode: beads.mode,
    mergeSlotEnabled: beads.mergeSlot === 'on',
    reviewEditor: mergedLocal.reviewEditor ?? null,
    localPreview: mergedLocal.preview?.command ?? null,
    previewUrl: mergedLocal.preview?.url ?? null,
    models,
    sources: Object.fromEntries(sources),
    errors: [...new Set(errors)],
  };
  return { ...result, resolved: buildResolvedTree(result) };
}

/**
 * Detects the retired `## Project Configuration` Markdown section in
 * `thoughts/AGENTS.md` so `readProjectConfig` can refuse the legacy format
 * instead of silently ignoring it (AC-004). Matches only the heading; it
 * never parses the section body for values - the bold field labels it
 * returns (e.g. `['Targets', 'Quality gates']`) are prose for the error
 * message, not configuration. Returns `[]` when the file or heading is
 * absent, which includes the upgrade path where `.agents/sdlc.json` has
 * never been written.
 */
export function detectLegacyConfigSection(root = process.cwd()) {
  const path = join(root, 'thoughts', 'AGENTS.md');
  if (!existsSync(path)) return [];
  const source = readFileSync(path, 'utf8');
  const heading = LEGACY_HEADING.exec(source);
  if (!heading) return [];
  const rest = source.slice(heading.index + heading[0].length);
  const nextHeading = rest.search(/^##[ \t]+/m);
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return [...body.matchAll(LEGACY_FIELD_LABEL)].map((match) => match[1].trim().replace(/:$/, ''));
}

function legacyConfigError(sharedPath, labels) {
  return `thoughts/AGENTS.md: legacy "## Project Configuration" section found (${labels.join(', ')}); move these settings to ${sharedPath} (see template/sdlc.template.json), then delete the section.`;
}

export function readProjectConfig(root = process.cwd()) {
  const sharedAbsolute = join(root, '.agents', 'sdlc.json');
  const localAbsolute = join(root, '.agents', 'sdlc.local.json');
  const shared = existsSync(sharedAbsolute) ? readFileSync(sharedAbsolute, 'utf8') : null;
  const local = existsSync(localAbsolute) ? readFileSync(localAbsolute, 'utf8') : null;
  const result = parseProjectConfig(shared, local, { sharedPath: DEFAULT_SHARED_PATH, localPath: DEFAULT_LOCAL_PATH });
  // The legacy check fires whether or not `.agents/sdlc.json` exists: a
  // missing file *and* a lingering legacy section is precisely the upgrade
  // path, and the legacy message leads because it is the actionable one -
  // "move these settings" beats "the file is missing" when both are true.
  const legacyLabels = detectLegacyConfigSection(root);
  if (legacyLabels.length) result.errors = [...new Set([legacyConfigError(DEFAULT_SHARED_PATH, legacyLabels), ...result.errors])];
  return result;
}

/**
 * One JSON-safe projection of a resolved config - resolved effective values,
 * `sources`, `path`, `localPath`, and `errors` - so `doctor`, `snapshot`, and
 * (Step 3) `sdlc config` all report the identical shape and cannot drift
 * apart. `sources` excludes any field `CONFIG_SCHEMA` marks `meta: true`
 * (currently `$schema`): meta fields configure tooling, not the pipeline, so
 * they earn no place in a projection callers read to decide pipeline
 * behavior. The exclusion is derived from the schema so a future meta field
 * is covered without a matching edit here.
 */
export function configProjection(config = {}) {
  const {
    version, path, localPath, targets, qualityGates, targetGates, targetPaths,
    reviewers, defaultReviewers, productDocs, frontendConstraints, beadsMode,
    mergeSlotEnabled, reviewEditor, localPreview, previewUrl, models, sources, errors, resolved,
  } = config;
  const projected = {
    version: version ?? null,
    path: path ?? null,
    localPath: localPath ?? null,
    targets: targets ?? [],
    qualityGates: qualityGates ?? [],
    targetGates: targetGates ?? {},
    targetPaths: targetPaths ?? {},
    reviewers: reviewers ?? {},
    defaultReviewers: defaultReviewers ?? [],
    productDocs: productDocs ?? 'thoughts/docs/',
    frontendConstraints: frontendConstraints ?? 'none',
    beadsMode: beadsMode ?? 'embedded',
    mergeSlotEnabled: mergeSlotEnabled ?? false,
    reviewEditor: reviewEditor ?? null,
    localPreview: localPreview ?? null,
    previewUrl: previewUrl ?? null,
    models: models ?? { defaults: { tier: 'balanced', effort: 'medium' }, roles: {}, tiers: {} },
    sources: Object.fromEntries(Object.entries(sources ?? {}).filter(([key]) => !META_KEYS.has(key))),
    errors: [...new Set(errors ?? [])],
  };
  return { ...projected, resolved: resolved ?? buildResolvedTree(projected) };
}

/**
 * Ordered `{ key, value, source }` array, one entry per key in
 * `config.sources` (excluding `meta: true` schema fields, the same exclusion
 * `configProjection` applies), with `value` walked out of `resolved`. Pairs
 * `sources` - which already enumerates every effective setting and its
 * provenance - with the nested tree, rather than re-deriving the key list
 * from `CONFIG_SCHEMA`. This is the dotted-key vocabulary `sdlc config`
 * renders and `--field` looks up against.
 */
export function effectiveSettings(config) {
  const resolved = config.resolved ?? buildResolvedTree(config);
  return Object.entries(config.sources ?? {})
    .filter(([key]) => !META_KEYS.has(key))
    .map(([key, source]) => ({ key, value: getByPath(resolved, key), source }));
}

/**
 * Resolves the active model policy for one host: `{ [role]: { model, effort,
 * tier, source } }`. `source` names whichever schema field decided the
 * role's tier — its own override, or the shared default. Exported for AC-006;
 * nothing consumes it yet (AA-008).
 */
export function resolveModelPolicy(config, host) {
  const hostValues = PLACEHOLDERS['<host>'].values;
  if (!hostValues.includes(host)) throw new TypeError(`Unknown host ${JSON.stringify(host)}; expected one of ${hostValues.join('|')}.`);
  const models = config.models ?? { defaults: {}, roles: {}, tiers: {} };
  const defaults = models.defaults ?? {};
  const roles = models.roles ?? {};
  const hostTiers = models.tiers?.[host] ?? {};
  const policy = {};
  for (const [role, roleConfig] of Object.entries(roles)) {
    const tier = roleConfig?.tier ?? defaults.tier ?? 'balanced';
    const source = roleConfig?.tier !== undefined ? `models.roles.${role}.tier` : 'models.defaults.tier';
    const effort = roleConfig?.effort ?? defaults.effort ?? 'medium';
    const model = hostTiers[tier];
    if (model === undefined) throw new TypeError(`Role ${JSON.stringify(role)} resolves to tier ${JSON.stringify(tier)}, which host ${JSON.stringify(host)} does not map in models.tiers.`);
    policy[role] = { model, effort, tier, source };
  }
  return policy;
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
