import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { localAllowedTopLevelKeys, sharedOnlyTopLevelKeys } from '../lib/config-schema.mjs';
import { configProjection, detectLegacyConfigSection, effectiveSettings, parseProjectConfig, readProjectConfig, resolveModelPolicy } from '../lib/config.mjs';

const SHARED_PATH = '.agents/sdlc.json';
const LOCAL_PATH = '.agents/sdlc.local.json';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(packageRoot, 'bin', 'sdlc.mjs');

function baseConfig(overrides = {}) {
  return {
    version: 1,
    targets: [
      { name: 'app', paths: ['src/**'], gates: ['npm test'], reviewers: ['backend-code-reviewer'] },
    ],
    gates: ['npm run lint'],
    reviewers: ['general-code-reviewer'],
    productDocs: 'thoughts/docs/',
    frontendConstraints: 'none',
    beads: { mode: 'embedded', mergeSlot: 'off' },
    ...overrides,
  };
}

function parse(shared, local) {
  return parseProjectConfig(JSON.stringify(shared), local === undefined ? undefined : JSON.stringify(local));
}

test('the local/shared top-level key split is derived from CONFIG_SCHEMA, not a hand-written list', () => {
  assert.deepEqual(localAllowedTopLevelKeys().sort(), ['$schema', 'local', 'models', 'version']);
  assert.deepEqual(sharedOnlyTopLevelKeys().sort(), ['beads', 'frontendConstraints', 'gates', 'productDocs', 'reviewers', 'targets']);
});

test('a missing shared config file is refused, not silently defaulted', () => {
  const config = parseProjectConfig(null, null);
  assert.deepEqual(config.errors, [
    '.agents/sdlc.json is missing. Copy template/sdlc.template.json to .agents/sdlc.json (`sdlc setup` installs it) and configure targets and gates.',
  ]);
  assert.deepEqual(config.targets, []);
  assert.equal(config.version, null);
  assert.equal(config.localPath, null);
});

test('unparseable JSON is refused, naming the file', () => {
  const config = parseProjectConfig('{ not json', null);
  assert(config.errors.some((error) => error.startsWith(`${SHARED_PATH} is not valid JSON:`)));
});

test('a non-object root is refused, naming the file and the value found', () => {
  const config = parseProjectConfig(JSON.stringify(['not', 'an', 'object']), null);
  assert(config.errors.some((error) => error === `${SHARED_PATH} must contain a JSON object at the root; found an array.`));
});

test('an unrecognized version is refused, naming file, path, and value', () => {
  const config = parse(baseConfig({ version: 2 }));
  assert(config.errors.includes(`${SHARED_PATH}: version 2 is not supported; expected 1.`));
});

test('a missing version is refused, naming file and path', () => {
  const { version, ...withoutVersion } = baseConfig();
  const config = parse(withoutVersion);
  assert(config.errors.includes(`${SHARED_PATH}: version is required.`));
  assert.equal(config.version, null);
});

test('$schema is accepted in either file, type-checked, and its provenance recorded; it has no slot in the resolved shape', () => {
  const shared = baseConfig({ $schema: './sdlc.schema.json' });
  const config = parse(shared);
  assert.deepEqual(config.errors, []);
  assert.equal(config.sources.$schema, SHARED_PATH);
  assert.equal(config.$schema, undefined);

  const overridden = parse(shared, { version: 1, $schema: './sdlc.local.schema.json' });
  assert.deepEqual(overridden.errors, []);
  assert.equal(overridden.sources.$schema, LOCAL_PATH);

  const invalid = parse(baseConfig({ $schema: 42 }));
  assert(invalid.errors.includes(`${SHARED_PATH}: $schema must be a string; found a number.`));
});

test('an unknown key at any level is refused, naming file, dotted path, and key', () => {
  const top = parse(baseConfig({ bogus: true }));
  assert(top.errors.includes(`${SHARED_PATH}: bogus is not a recognized key.`));

  const nested = parse(baseConfig({ beads: { mode: 'embedded', mergeSlot: 'off', extra: 1 } }));
  assert(nested.errors.includes(`${SHARED_PATH}: beads.extra is not a recognized key.`));
});

test('a target missing its name is refused, naming file, path, and index', () => {
  const config = parse(baseConfig({ targets: [{ paths: ['src/**'] }] }));
  assert(config.errors.includes(`${SHARED_PATH}: targets[0].name is required.`));
});

test('a duplicate target name is refused, naming both indices and the value', () => {
  const config = parse(baseConfig({ targets: [{ name: 'app' }, { name: 'app' }] }));
  assert(config.errors.includes(`${SHARED_PATH}: targets[1].name "app" duplicates targets[0].name.`));
});

test('a malformed target name is refused, naming file, path, and value', () => {
  const config = parse(baseConfig({ targets: [{ name: 'App_1' }] }));
  assert(config.errors.some((error) => error.startsWith(`${SHARED_PATH}: targets[0].name "App_1" does not match`)));
});

test('an empty or whitespace-only gate command is refused, at top level and nested under a target', () => {
  const top = parse(baseConfig({ gates: ['npm test', '   '] }));
  assert(top.errors.includes(`${SHARED_PATH}: gates[1] is empty or whitespace-only.`));

  const nested = parse(baseConfig({ targets: [{ name: 'app', gates: [''] }] }));
  assert(nested.errors.includes(`${SHARED_PATH}: targets[0].gates[0] is empty or whitespace-only.`));
});

test('an empty glob is refused, naming file, path, and index', () => {
  const config = parse(baseConfig({ targets: [{ name: 'app', paths: [''] }] }));
  assert(config.errors.includes(`${SHARED_PATH}: targets[0].paths[0] is empty.`));
});

test('beads.mode outside embedded|server is refused, naming file, path, and value', () => {
  const config = parse(baseConfig({ beads: { mode: 'cluster', mergeSlot: 'off' } }));
  assert(config.errors.includes(`${SHARED_PATH}: beads.mode "cluster" is not one of embedded|server.`));
});

test('beads.mergeSlot outside off|on is refused, naming file, path, and value', () => {
  const config = parse(baseConfig({ beads: { mode: 'embedded', mergeSlot: 'maybe' } }));
  assert(config.errors.includes(`${SHARED_PATH}: beads.mergeSlot "maybe" is not one of off|on.`));
});

test('models tier and effort outside their enums are refused, naming file, path, and value', () => {
  const config = parse(baseConfig({ models: { defaults: { tier: 'ultra', effort: 'extreme' } } }));
  assert(config.errors.includes(`${SHARED_PATH}: models.defaults.tier "ultra" is not one of frontier|balanced|cheap.`));
  assert(config.errors.includes(`${SHARED_PATH}: models.defaults.effort "extreme" is not one of low|medium|high.`));
});

test('a role tier absent from a declared host tier map is refused, naming role, tier, and host', () => {
  const config = parse(baseConfig({
    models: {
      roles: { 'plan-reviewer': { tier: 'frontier' } },
      tiers: { codex: { balanced: 'gpt' } },
    },
  }));
  assert(config.errors.some((error) => error.includes('models.roles.plan-reviewer.tier') && error.includes('"frontier"') && error.includes('models.tiers.codex') && error.includes('"codex"')));
});

test('a host outside claude|codex|pi is refused, naming the host', () => {
  const config = parse(baseConfig({ models: { tiers: { gemini: { balanced: 'gemini-pro' } } } }));
  assert(config.errors.includes(`${SHARED_PATH}: models.tiers.gemini is not a declared host; expected one of claude|codex|pi.`));
});

test('a local file carrying each shared-only top-level key is refused by name', () => {
  for (const key of sharedOnlyTopLevelKeys()) {
    const config = parse(baseConfig(), { version: 1, [key]: {} });
    assert(
      config.errors.includes(`${LOCAL_PATH}: ${key} is a shared-only key and must be set in ${SHARED_PATH}.`),
      `expected refusal for local key "${key}"; got ${JSON.stringify(config.errors)}`,
    );
  }
});

test('local and models overlays merge deep, leaf-wise; arrays and scalars are whole-value replacements', () => {
  const shared = baseConfig({
    local: { reviewEditor: 'code {worktree}', preview: { command: 'npm run dev', url: 'http://localhost:3000' } },
    models: {
      defaults: { tier: 'balanced', effort: 'medium' },
      roles: { 'plan-reviewer': { tier: 'frontier', effort: 'high' } },
      tiers: { claude: { balanced: 'sonnet', frontier: 'opus' } },
    },
  });
  const local = {
    version: 1,
    local: { preview: { url: 'http://localhost:4000' } },
    models: {
      defaults: { effort: 'low' },
      roles: { 'plan-reviewer': { effort: 'medium' } },
      tiers: { claude: { cheap: 'haiku' } },
    },
  };
  const config = parse(shared, local);
  assert.deepEqual(config.errors, []);
  assert.equal(config.reviewEditor, 'code {worktree}');
  assert.equal(config.localPreview, 'npm run dev');
  assert.equal(config.previewUrl, 'http://localhost:4000');
  assert.deepEqual(config.models.defaults, { tier: 'balanced', effort: 'low' });
  assert.deepEqual(config.models.roles['plan-reviewer'], { tier: 'frontier', effort: 'medium' });
  assert.deepEqual(config.models.tiers.claude, { balanced: 'sonnet', frontier: 'opus', cheap: 'haiku' });
});

test('sources report the overlay file for an overridden value and "default" for a value no file set', () => {
  const shared = { version: 1, targets: [] };
  const local = { version: 1, local: { reviewEditor: 'code {worktree}' } };
  const config = parse(shared, local);
  assert.deepEqual(config.errors, []);
  assert.equal(config.sources['local.reviewEditor'], LOCAL_PATH);
  assert.equal(config.sources['beads.mergeSlot'], 'default');
  assert.equal(config.sources['models.defaults.tier'], 'default');
  assert.equal(config.sources.targets, SHARED_PATH);
});

test('shell metacharacters in a gate command survive byte-identically through qualityGates and targetGates', () => {
  const command = 'node -e "console.log(`a|b;c->d`)"';
  const config = parse({
    version: 1,
    targets: [{ name: 'app', gates: [command] }],
    gates: [command],
  });
  assert.deepEqual(config.errors, []);
  assert.equal(config.qualityGates[0], command);
  assert.equal(config.targetGates.app[0], command);
});

test('a target without its own reviewers inherits the top-level list; a target with its own keeps it', () => {
  const config = parse({
    version: 1,
    targets: [
      { name: 'app' },
      { name: 'web', reviewers: ['frontend-code-reviewer'] },
    ],
    reviewers: ['general-code-reviewer'],
  });
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.reviewers.app, ['general-code-reviewer']);
  assert.deepEqual(config.reviewers.web, ['frontend-code-reviewer']);
  assert.deepEqual(config.defaultReviewers, ['general-code-reviewer']);
});

test('resolveModelPolicy returns model+effort per role for each host and refuses a role tier a declared host does not map', () => {
  const config = parse({
    version: 1,
    targets: [],
    models: {
      defaults: { tier: 'balanced', effort: 'medium' },
      roles: {
        'plan-reviewer': { tier: 'frontier', effort: 'high' },
        implementer: {},
      },
      tiers: {
        claude: { frontier: 'opus', balanced: 'sonnet', cheap: 'haiku' },
        codex: { balanced: 'gpt-5', cheap: 'gpt-5-mini' },
        pi: { frontier: 'pi-large', balanced: 'pi-medium', cheap: 'pi-small' },
      },
    },
  });
  assert.equal(config.errors.length, 1, config.errors.join('\n'));
  assert(config.errors[0].includes('models.roles.plan-reviewer.tier') && config.errors[0].includes('"codex"'));

  const claude = resolveModelPolicy(config, 'claude');
  assert.deepEqual(claude['plan-reviewer'], { model: 'opus', effort: 'high', tier: 'frontier', source: 'models.roles.plan-reviewer.tier' });
  assert.deepEqual(claude.implementer, { model: 'sonnet', effort: 'medium', tier: 'balanced', source: 'models.defaults.tier' });

  const pi = resolveModelPolicy(config, 'pi');
  assert.equal(pi['plan-reviewer'].model, 'pi-large');

  assert.throws(() => resolveModelPolicy(config, 'codex'), /does not map/);
  assert.throws(() => resolveModelPolicy(config, 'unknown-host'), /Unknown host/);
});

test('readProjectConfig resolves from disk and reports localPath only when the overlay file exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-config-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({ version: 1, targets: [] }));

  const withoutLocal = readProjectConfig(root);
  assert.deepEqual(withoutLocal.errors, []);
  assert.equal(withoutLocal.localPath, null);
  assert.equal(withoutLocal.path, SHARED_PATH);

  writeFileSync(join(root, '.agents', 'sdlc.local.json'), JSON.stringify({ version: 1, local: { reviewEditor: 'code {worktree}' } }));
  const withLocal = readProjectConfig(root);
  assert.deepEqual(withLocal.errors, []);
  assert.equal(withLocal.localPath, LOCAL_PATH);
  assert.equal(withLocal.reviewEditor, 'code {worktree}');
});

test('detectLegacyConfigSection matches only the exact heading and returns bold field labels, never values', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-legacy-'));
  assert.deepEqual(detectLegacyConfigSection(root), [], 'missing thoughts/AGENTS.md');

  mkdirSync(join(root, 'thoughts'), { recursive: true });
  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), '# Contract\n\n## Authority\n\nNothing here.\n');
  assert.deepEqual(detectLegacyConfigSection(root), [], 'no heading present');

  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), '# Contract\n\nProject Configuration is mentioned in prose but is not a heading.\n');
  assert.deepEqual(detectLegacyConfigSection(root), [], 'heading text without ## is not a hit');

  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), [
    '# Contract',
    '',
    '## Project Configuration',
    '',
    'This section is the configuration authority.',
    '',
    '- **Targets:** `app`',
    '- **Quality gates:**',
    '  - `npm test`',
    '- **Beads mode:** `embedded`',
    '',
    '## Authority',
    '',
    '- **Not a field:** should not be collected; this is past the section boundary.',
    '',
  ].join('\n'));
  assert.deepEqual(detectLegacyConfigSection(root), ['Targets', 'Quality gates', 'Beads mode']);
});

test('a legacy Project Configuration section is refused whether or not .agents/sdlc.json exists, and leads the missing-file error', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-legacy-'));
  mkdirSync(join(root, 'thoughts'), { recursive: true });
  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), '## Project Configuration\n\n- **Targets:** `app`\n');

  const missing = readProjectConfig(root);
  assert.equal(missing.errors.length, 2);
  assert.match(missing.errors[0], /legacy "## Project Configuration"/);
  assert(missing.errors[0].includes('.agents/sdlc.json'));
  assert(missing.errors[0].includes('template/sdlc.template.json'));
  assert(missing.errors[0].includes('Targets'));
  assert.match(missing.errors[1], /is missing/);

  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({ version: 1, targets: [] }));
  const present = readProjectConfig(root);
  assert.equal(present.errors.length, 1);
  assert.match(present.errors[0], /legacy "## Project Configuration"/);
});

test('configProjection carries resolved values, sources, path, localPath, and errors, excluding meta keys from sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-projection-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({
    version: 1,
    $schema: './sdlc.schema.json',
    targets: [{ name: 'app', paths: ['src/**'], gates: ['npm test'] }],
    gates: ['npm run lint'],
  }));
  const config = readProjectConfig(root);
  const projection = configProjection(config);
  assert.deepEqual(projection.errors, []);
  assert.equal(projection.path, SHARED_PATH);
  assert.equal(projection.localPath, null);
  assert.deepEqual(projection.targets, ['app']);
  assert.deepEqual(projection.qualityGates, ['npm run lint']);
  assert.equal(projection.beadsMode, 'embedded');
  assert.equal(projection.sources.targets, SHARED_PATH);
  assert.equal(projection.sources.$schema, undefined, 'a meta key has no place in projected sources');

  const empty = configProjection();
  assert.deepEqual(empty.errors, []);
  assert.deepEqual(empty.targets, []);
  assert.equal(empty.beadsMode, 'embedded');
  assert.equal(empty.path, null);
});

test('resolved is the schema-shaped nested tree with defaults applied, so beads.mode and models.defaults.tier are plain path walks', () => {
  const config = parse({
    version: 1,
    targets: [{ name: 'app', paths: ['src/**'], gates: ['npm test'], reviewers: ['backend-code-reviewer'] }],
    gates: ['npm run lint'],
    beads: { mode: 'server', mergeSlot: 'on' },
    local: { reviewEditor: 'code {worktree}' },
  });
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.resolved.targets, [
    { name: 'app', paths: ['src/**'], gates: ['npm test'], reviewers: ['backend-code-reviewer'] },
  ]);
  assert.deepEqual(config.resolved.gates, ['npm run lint']);
  assert.equal(config.resolved.beads.mode, 'server');
  assert.equal(config.resolved.beads.mergeSlot, 'on');
  assert.equal(config.resolved.local.reviewEditor, 'code {worktree}');
  assert.equal(config.resolved.local.preview.command, null);
  assert.equal(config.resolved.models.defaults.tier, 'balanced');
  assert.equal(config.resolved.models.defaults.effort, 'medium');

  // configProjection carries the same tree through for a hand-built flat
  // config (the shape guard/snapshot fixtures already construct) that never
  // set `resolved` itself.
  const { resolved, ...flat } = config;
  const projected = configProjection(flat);
  assert.deepEqual(projected.resolved, resolved);
});

test('effectiveSettings pairs every sources entry with its resolved value, in sources order, excluding meta keys', () => {
  const config = parse({
    version: 1,
    targets: [{ name: 'app' }],
    models: {
      roles: { 'plan-reviewer': { tier: 'frontier' } },
      tiers: { claude: { frontier: 'opus', balanced: 'sonnet', cheap: 'haiku' } },
    },
  });
  assert.deepEqual(config.errors, []);
  const settings = effectiveSettings(config);

  assert.equal(settings.some((entry) => entry.key === '$schema'), false, 'a meta key has no place among effective settings');
  assert.deepEqual(Object.keys(config.sources).filter((key) => key !== '$schema').sort(), settings.map((entry) => entry.key).sort());

  assert.deepEqual(settings.find((entry) => entry.key === 'version'), { key: 'version', value: 1, source: SHARED_PATH });
  assert.deepEqual(settings.find((entry) => entry.key === 'targets[0].name'), { key: 'targets[0].name', value: 'app', source: SHARED_PATH });
  assert.deepEqual(
    settings.find((entry) => entry.key === 'models.roles.plan-reviewer.tier'),
    { key: 'models.roles.plan-reviewer.tier', value: 'frontier', source: SHARED_PATH },
  );
  assert.deepEqual(settings.find((entry) => entry.key === 'beads.mode'), { key: 'beads.mode', value: 'embedded', source: 'default' });
});

test('sdlc config --json matches readProjectConfig/configProjection on the same fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-config-cli-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({
    version: 1,
    targets: [{ name: 'app', paths: ['src/**'], gates: ['npm test'] }],
    gates: ['npm run lint'],
  }));
  const output = execFileSync(process.execPath, [cli, 'config', '--json'], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), configProjection(readProjectConfig(root)));
});

test('sdlc config text form renders one key=value (source) line per effective setting; arrays/objects as compact JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-config-cli-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({ version: 1, targets: [{ name: 'app' }], gates: ['npm test'] }));
  const output = execFileSync(process.execPath, [cli, 'config'], { cwd: root, encoding: 'utf8' });
  const lines = output.trim().split('\n');
  assert(lines.includes('version=1 (.agents/sdlc.json)'));
  assert(lines.includes('gates=["npm test"] (.agents/sdlc.json)'));
  assert(lines.includes('beads.mode=embedded (default)'));
  assert(lines.includes('targets[0].name=app (.agents/sdlc.json)'));
});

test('sdlc config --field narrows to one key and reports the overriding file for a locally-overridden value (AC-010)', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-config-cli-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), JSON.stringify({ version: 1, targets: [] }));
  writeFileSync(join(root, '.agents', 'sdlc.local.json'), JSON.stringify({ version: 1, local: { reviewEditor: 'code {worktree}' } }));

  const text = execFileSync(process.execPath, [cli, 'config', '--field', 'local.reviewEditor'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(text, 'local.reviewEditor=code {worktree} (.agents/sdlc.local.json)');

  const json = JSON.parse(execFileSync(process.execPath, [cli, 'config', '--field', 'local.reviewEditor', '--json'], { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(json, { value: 'code {worktree}', source: LOCAL_PATH });

  const unknown = spawnSync(process.execPath, [cli, 'config', '--field', 'no.such.field'], { cwd: root, encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no\.such\.field/);
  assert.match(unknown.stderr, /docs\/configuration\.md/);
});

test('sdlc config exits 1 with the config errors on stderr for invalid, legacy, and missing configuration', () => {
  const invalidRoot = mkdtempSync(join(tmpdir(), 'sdlc-config-cli-'));
  mkdirSync(join(invalidRoot, '.agents'), { recursive: true });
  writeFileSync(join(invalidRoot, '.agents', 'sdlc.json'), JSON.stringify({ version: 1, targets: [], beads: { mode: 'cluster' } }));
  const invalid = spawnSync(process.execPath, [cli, 'config'], { cwd: invalidRoot, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /beads\.mode "cluster"/);

  const legacyRoot = mkdtempSync(join(tmpdir(), 'sdlc-config-cli-'));
  mkdirSync(join(legacyRoot, 'thoughts'), { recursive: true });
  writeFileSync(join(legacyRoot, 'thoughts', 'AGENTS.md'), '## Project Configuration\n\n- **Targets:** `app`\n');
  const legacy = spawnSync(process.execPath, [cli, 'config'], { cwd: legacyRoot, encoding: 'utf8' });
  assert.equal(legacy.status, 1);
  assert.match(legacy.stderr, /legacy "## Project Configuration"/);

  const missingRoot = mkdtempSync(join(tmpdir(), 'sdlc-config-cli-'));
  const missing = spawnSync(process.execPath, [cli, 'config'], { cwd: missingRoot, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is missing/);
});
