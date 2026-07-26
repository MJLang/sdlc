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

test('sdlc-implement defers the review contract to a sibling loaded at mode=review', () => {
  const skillDir = join(packageRoot, 'skills', 'sdlc-implement');
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const review = readFileSync(join(skillDir, 'review.md'), 'utf8');

  // Execution is loaded at the first guard call; review is not.
  assert(skill.split('\n').length < 130, 'sdlc-implement/SKILL.md must stay execution-sized');
  assert.match(skill, /review\.md/);
  assert.match(skill, /mode=review/);

  // The aggregate contract lives in exactly one place.
  for (const section of ['Reviewer set and immutable inputs', 'Component contract', 'Aggregate artifact', 'Convergence']) {
    assert.match(review, new RegExp(`^## ${section}$`, 'm'), `review.md must carry the ${section} contract`);
    assert.equal(new RegExp(`^#+ ${section}$`, 'm').test(skill), false, `${section} must not remain in SKILL.md`);
  }
  assert.equal(/Clean-Pass Evidence/.test(skill), false, 'the component contract belongs in review.md');
  // Generate → fill → validate replaces the hand-authored grammar.
  assert.match(review, /sdlc review-artifact --template/);
  assert.match(review, /sdlc review-artifact --validate/);
});

test('no skill or reviewer profile still names the retired Project Configuration section', () => {
  const reviewerProfiles = ['backend-code-reviewer', 'frontend-code-reviewer', 'general-code-reviewer'];
  const paths = [
    ...skillNames.map((skill) => join(packageRoot, 'skills', skill, 'SKILL.md')),
    ...reviewerProfiles.map((profile) => join(packageRoot, 'template', 'agents', `${profile}.md`)),
  ];
  for (const path of paths) {
    const source = readFileSync(path, 'utf8');
    assert.equal(/Project Configuration/.test(source), false, `${path} must not name the retired Project Configuration section`);
  }
});

test('sdlc-ticket and sdlc-chore each run exactly one sdlc config call, since neither rides a guard', () => {
  for (const skill of ['sdlc-ticket', 'sdlc-chore']) {
    const source = readFileSync(join(packageRoot, 'skills', skill, 'SKILL.md'), 'utf8');
    const calls = source.match(/`sdlc config[^`]*`/g) ?? [];
    assert.equal(calls.length, 1, `${skill} must run exactly one sdlc config call (AA-004); found ${JSON.stringify(calls)}`);
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
