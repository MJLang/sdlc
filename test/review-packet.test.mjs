import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprintContent } from '../lib/fingerprint.mjs';
import { createReviewPackets, createStepPacket, formatReviewPacket, textualReferences } from '../lib/review-packet.mjs';

function fixture({ targetPaths = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-review-packet-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'SDLC Tests'], { cwd: root });
  for (const directory of ['thoughts/tickets', 'thoughts/plans', 'src/backend', 'src/frontend', 'src/shared', 'assets', 'docs']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'thoughts', 'AGENTS.md'), `# Workflow

## Project Configuration

- **Targets:** \`backend | frontend\`
- **Quality gates:** \`node --test\`
- **Target gates:** \`backend -> npm run test:backend\`
${targetPaths ? '- **Target paths:** `backend -> src/backend/**, src/shared/**`\n- **Target paths:** `frontend -> src/frontend/**, src/shared/**`\n' : ''}- **Reviewers:** \`backend -> backend-code-reviewer; frontend -> frontend-code-reviewer\`
- **Frontend constraints:** use the repository design tokens
`);
  const ticket = `---
Status: approved
Tags: [backend, frontend]
Type: feature
Target: backend
---

# Shared export

## Summary

Export records through the API and UI.

## Acceptance Criteria

- AC-001: The API exports a selected record.
- AC-002: The UI displays the exported record.
`;
  writeFileSync(join(root, 'thoughts', 'tickets', '001-export.md'), ticket);
  const plan = `---
Status: approved
Tags: [backend, frontend]
Type: feature
Target: backend
Ticket Origin: thoughts/tickets/001-export.md
Source Ticket Hash: sha256=${fingerprintContent(ticket)}
Beads Epic: fixture-epic
---

# Export plan

## Current-State Findings

| Area or path | Finding | Evidence | Implication |
|---|---|---|---|
| src | Existing lanes | src/backend/api.js:1 | Update both |

### Step 1 - Backend export

Covers: AC-001
Files:
- src/backend/**
- src/shared/**
Depends on: none
Parallelizable: yes

Update the API.

### Step 2 - Frontend export

Covers: AC-002
Files:
- src/frontend/**
Depends on: step 1
Parallelizable: no

Update the UI.

## Verification

- AC-001: API test.
- AC-002: UI test.

## Approval Attention

None

## Plan Critique

Pass 1 Verdict: APPROVED
`;
  writeFileSync(join(root, 'thoughts', 'plans', '001-f-export.md'), plan);
  writeFileSync(join(root, 'src', 'backend', 'api.js'), "import { contract } from '../frontend/contracts.js';\nexport const api = () => contract;\n");
  writeFileSync(join(root, 'src', 'frontend', 'contracts.js'), "export const contract = 'v1';\n");
  writeFileSync(join(root, 'src', 'frontend', 'consumer.js'), "import { api } from '../backend/api.js';\nexport const consume = api;\n");
  writeFileSync(join(root, 'src', 'shared', 'common.js'), "export const common = 1;\n");
  writeFileSync(join(root, 'assets', 'data.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, 'docs', 'note.md'), 'before\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'approved plan'], { cwd: root, stdio: 'ignore' });
  const approvalCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['checkout', '-b', '001-f-export'], { cwd: root, stdio: 'ignore' });
  // The api import is deliberately unchanged; interface discovery must scan
  // complete changed-file contents instead of only diff hunks.
  writeFileSync(join(root, 'src', 'backend', 'api.js'), "import { contract } from '../frontend/contracts.js';\nexport const api = () => `${contract}-api`;\n");
  writeFileSync(join(root, 'src', 'frontend', 'contracts.js'), "export const contract = 'v2';\n");
  writeFileSync(join(root, 'src', 'frontend', 'consumer.js'), "import { api } from '../backend/api.js';\nexport const consume = () => api();\n");
  writeFileSync(join(root, 'src', 'shared', 'common.js'), "export const common = 2;\n");
  writeFileSync(join(root, 'assets', 'data.bin'), Buffer.from([0, 9, 8, 7]));
  writeFileSync(join(root, 'docs', 'note.md'), 'after\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'implement export'], { cwd: root, stdio: 'ignore' });
  return { root, approvalCommit };
}

test('reference extraction covers direct, relative, require, and include specifiers', () => {
  assert.deepEqual(textualReferences(`import './a.js';\nconst b = require('../b');\n#include "c.h"\nexport { x } from 'src/x.js';\n`), [
    '../b', './a.js', 'c.h', 'src/x.js',
  ]);
});

test('review packets scope the diff, retain complete inventory, and include interfaces in both directions', () => {
  const { root, approvalCommit } = fixture();
  const packets = createReviewPackets('1', { cwd: root, approvedPlanCommit: approvalCommit });
  assert.deepEqual(packets.map((packet) => packet.reviewer), ['backend-code-reviewer', 'frontend-code-reviewer', 'general-code-reviewer']);
  const backend = packets.find((packet) => packet.reviewer === 'backend-code-reviewer');
  const byPath = new Map(backend.changedFileInventory.map((file) => [file.path, file]));
  assert.equal(byPath.size, 6);
  assert.deepEqual(byPath.get('src/shared/common.js').targets, ['backend', 'frontend']);
  assert.equal(byPath.get('src/frontend/contracts.js').role, 'cross-lane-interface');
  assert.equal(byPath.get('src/frontend/consumer.js').role, 'cross-lane-interface');
  assert.equal(byPath.get('assets/data.bin').role, 'inventory-only');
  assert.equal(byPath.get('assets/data.bin').scan, 'binary');
  assert.equal(byPath.get('docs/note.md').role, 'inventory-only');
  assert(backend.fallbacks.some((fallback) => fallback.path === 'assets/data.bin' && fallback.reason === 'binary-inventory-only'));
  assert(backend.fallbacks.some((fallback) => fallback.path === 'docs/note.md' && fallback.reason === 'no-computable-interface-match'));
  assert.match(backend.laneDiff, /src\/frontend\/contracts\.js/);
  assert.match(backend.laneDiff, /src\/frontend\/consumer\.js/);
  assert.match(backend.laneDiff, /src\/shared\/common\.js/);
  assert.doesNotMatch(backend.laneDiff, /docs\/note\.md/);
  assert.match(formatReviewPacket(backend), /Complete changed-file inventory/);
});

test('missing Target paths makes classification explicitly model-owned and retains the complete diff', () => {
  const { root } = fixture({ targetPaths: false });
  const packets = createReviewPackets('001', { cwd: root, reviewerNames: ['backend-code-reviewer'] });
  assert.equal(packets[0].classification.mode, 'model-required');
  assert(packets[0].changedFileInventory.filter((file) => file.scan === 'text').every((file) => file.role === 'lane'));
  assert.equal(packets[0].changedFileInventory.find((file) => file.path === 'assets/data.bin').role, 'inventory-only');
  assert.match(packets[0].laneDiff, /docs\/note\.md/);
});

test('unreadable changed files are retained in every inventory with an explicit fallback', () => {
  const { root } = fixture();
  const packet = createReviewPackets('001', {
    cwd: root,
    reviewerNames: ['backend-code-reviewer'],
    fileRecordReader: (cwd, head, path) => path === 'docs/note.md'
      ? { status: 'unreadable', references: [] }
      : (() => {
        const value = execFileSync('git', ['show', `${head}:${path}`], { cwd });
        if (value.includes(0)) return { status: 'binary', references: [] };
        return { status: 'text', contents: value.toString('utf8'), references: textualReferences(value.toString('utf8')) };
      })(),
  })[0];
  assert(packet.fallbacks.some((fallback) => fallback.path === 'docs/note.md' && fallback.reason === 'unreadable-inventory-only'));
});

test('step packets quote live AC text, configured gates, identity, constraints, and compact result contract', () => {
  const { root, approvalCommit } = fixture();
  const packet = createStepPacket('001', 1, {
    cwd: root,
    issueId: 'step-1',
    approvalCommit,
    worktreeRoot: root,
    target: 'backend',
  });
  assert.deepEqual(packet.acceptanceCriteria, ['AC-001: The API exports a selected record.']);
  assert.deepEqual(packet.gates.map((gate) => gate.source), ['global', 'target:backend']);
  assert.equal(packet.plan.approvalCommit, approvalCommit);
  assert.equal(packet.constraints, 'use the repository design tokens');
  assert.match(packet.resultContract, /^status=<pass\|blocked> commit=/);
  assert.equal(readFileSync(join(root, packet.plan.path), 'utf8').includes(packet.plan.sha256), false);
});
