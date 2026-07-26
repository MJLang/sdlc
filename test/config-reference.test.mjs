import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CONFIG_SCHEMA, localAllowedTopLevelKeys } from '../lib/config-schema.mjs';
import { readProjectConfig } from '../lib/config.mjs';
import { renderConfigReference } from '../scripts/render-config-reference.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rendered = renderConfigReference();

test('renderConfigReference is byte-identical to the committed artifacts (AC-013 drift check)', () => {
  for (const [relativePath, contents] of Object.entries(rendered)) {
    const committed = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
    assert.equal(
      contents, committed,
      `${relativePath} does not match its rendered form; run \`npm run config:docs\` and commit the result`,
    );
  }
});

test('the shipped template resolves through readProjectConfig with zero errors (AC-012)', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-config-reference-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'sdlc.json'), rendered['template/sdlc.template.json']);

  const config = readProjectConfig(root);
  assert.deepEqual(config.errors, []);
  assert.equal(config.version, 1);
  assert.deepEqual(config.targets, ['app']);
});

test('both generated JSON Schema documents are valid JSON; the local schema is restricted to the derived local-allowed keys', () => {
  const schema = JSON.parse(rendered['template/sdlc.schema.json']);
  const localSchema = JSON.parse(rendered['template/sdlc.local.schema.json']);

  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['version', 'targets']);

  assert.equal(localSchema.type, 'object');
  assert.equal(localSchema.additionalProperties, false);
  assert.equal(localSchema.required, undefined, 'the local overlay requires nothing');
  assert.deepEqual(Object.keys(localSchema.properties), localAllowedTopLevelKeys());
});

test('docs/configuration.md names every non-meta key in CONFIG_SCHEMA, so a new key cannot ship undocumented', () => {
  const docs = rendered['docs/configuration.md'];
  for (const field of CONFIG_SCHEMA) {
    if (field.meta) continue;
    assert(docs.includes(`\`${field.key}\``), `docs/configuration.md does not name key "${field.key}"`);
  }
});
