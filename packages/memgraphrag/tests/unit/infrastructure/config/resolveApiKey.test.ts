import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveApiKey } from '../../../../src/infrastructure/config/resolveApiKey.js';

describe('resolveApiKey authority', () => {
  it('prefers a non-empty configured file over the environment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memgraphrag-api-key-'));
    try {
      writeFileSync(join(directory, 'openai.key'), '  file-secret\n', { mode: 0o600 });
      expect(resolveApiKey('openai.key', { OPENAI_API_KEY: 'env-secret' }, directory))
        .toBe('file-secret');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses a trimmed environment key when the file is missing or empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memgraphrag-api-key-'));
    try {
      expect(resolveApiKey('missing.key', { OPENAI_API_KEY: '  env-secret  ' }, directory))
        .toBe('env-secret');
      writeFileSync(join(directory, 'empty.key'), '   \n', { mode: 0o600 });
      expect(resolveApiKey('empty.key', { OPENAI_API_KEY: 'env-fallback' }, directory))
        .toBe('env-fallback');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns degraded-mode empty authority for absent or whitespace-only sources', () => {
    expect(resolveApiKey(undefined, {})).toBe('');
    expect(resolveApiKey(undefined, { OPENAI_API_KEY: '   ' })).toBe('');
  });
});
