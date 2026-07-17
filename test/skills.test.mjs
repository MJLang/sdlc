import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillNames = [
  'sdlc-approve',
  'sdlc-cancel',
  'sdlc-chore',
  'sdlc-implement',
  'sdlc-land',
  'sdlc-next',
  'sdlc-plan',
  'sdlc-queue',
  'sdlc-review',
  'sdlc-ticket',
];

function assertScalar(source, key, expected, message) {
  const values = [...source.matchAll(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'gm'))]
    .map((match) => match[1]);

  assert.deepEqual(values, [expected], message);
}

test('skill directories and frontmatter use the sdlc namespace', () => {
  assert.deepEqual(readdirSync(join(packageRoot, 'skills')).sort(), skillNames);
  for (const skill of skillNames) {
    const source = readFileSync(join(packageRoot, 'skills', skill, 'SKILL.md'), 'utf8');
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];

    assert(frontmatter, `${skill} skill is missing YAML frontmatter`);
    assertScalar(frontmatter, 'name', skill, `${skill} frontmatter name must match its directory`);
  }
});

test('ticket and chore workflows require manual invocation across supported agents', () => {
  for (const skill of ['sdlc-ticket', 'sdlc-chore']) {
    const source = readFileSync(join(packageRoot, 'skills', skill, 'SKILL.md'), 'utf8');
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];

    assert(frontmatter, `${skill} skill is missing YAML frontmatter`);
    assertScalar(
      frontmatter,
      'disable-model-invocation',
      'true',
      `${skill} must disable implicit Claude invocation`,
    );

    const openAiConfig = readFileSync(
      join(packageRoot, 'skills', skill, 'agents', 'openai.yaml'),
      'utf8',
    );
    assertScalar(
      openAiConfig,
      'allow_implicit_invocation',
      'false',
      `${skill} must disable implicit Codex invocation`,
    );
  }
});
