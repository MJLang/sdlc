import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Normalize gate-artifact bytes before hashing.
 *
 * The workflow intentionally ignores platform line endings and the presence of
 * terminal newlines, while preserving every other character (including
 * frontmatter and trailing spaces).
 */
export function normalizeArtifactBytes(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Artifact content must be a string or Uint8Array.');
  }

  const text = utf8.decode(bytes).replace(/\r\n?/g, '\n');
  return `${text.replace(/\n+$/g, '')}\n`;
}

export function fingerprintContent(value) {
  return createHash('sha256').update(normalizeArtifactBytes(value), 'utf8').digest('hex');
}

export function fingerprintFile(path) {
  return fingerprintContent(readFileSync(path));
}

export function formatFingerprint(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError('Expected a lowercase SHA-256 digest.');
  return `sha256=${hex}`;
}

export function parseFingerprint(value) {
  return String(value ?? '').trim().match(/^sha256=([0-9a-f]{64})$/)?.[1];
}
