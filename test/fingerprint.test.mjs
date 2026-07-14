import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprintContent, fingerprintFile, formatFingerprint, normalizeArtifactBytes, parseFingerprint } from '../lib/fingerprint.mjs';

test('fingerprints normalize line endings and terminal newlines', () => {
  const variants = [
    'alpha\nbeta',
    'alpha\nbeta\n',
    'alpha\nbeta\n\n',
    'alpha\r\nbeta\r\n',
    'alpha\rbeta\r',
  ];
  assert.equal(new Set(variants.map(fingerprintContent)).size, 1);
  assert.equal(normalizeArtifactBytes('alpha\r\nbeta'), 'alpha\nbeta\n');
});

test('fingerprints preserve substantive UTF-8 content', () => {
  assert.notEqual(fingerprintContent('café'), fingerprintContent('cafe'));
  assert.equal(fingerprintContent('こんにちは'), fingerprintContent(Buffer.from('こんにちは', 'utf8')));
});

test('file fingerprint and public representation are deterministic', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-fingerprint-'));
  const path = join(directory, 'artifact.md');
  writeFileSync(path, 'body\r\n');
  const digest = fingerprintFile(path);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(parseFingerprint(formatFingerprint(digest)), digest);
  assert.equal(parseFingerprint(digest), undefined);
});

test('invalid UTF-8 is rejected instead of silently replaced', () => {
  assert.throws(() => fingerprintContent(Uint8Array.from([0xff])), /encoded data|encoding|UTF-8/i);
});
