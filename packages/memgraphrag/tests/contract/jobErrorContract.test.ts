import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JOB_ERROR_CONTRACT, parseJobErrorContract } from '../../src/application/indexing/jobErrorContract.js';

describe('graphdb owner job-error package contract', () => {
  it('ships the runtime authority through the published config directory', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      files?: unknown;
    };
    expect(packageJson.files).toContain('config');
    expect(JOB_ERROR_CONTRACT.contract).toBe('graphdb-owner-job-errors');
    expect(JOB_ERROR_CONTRACT.version).toBe(1);
    expect(JOB_ERROR_CONTRACT.ownerError.code).not.toBe(
      JOB_ERROR_CONTRACT.documentError.code,
    );
    expect(JOB_ERROR_CONTRACT.documentError.documentId.length).toBeGreaterThan(0);
  });

  it('fails closed on malformed or ambiguous contract boundaries', () => {
    expect(() => parseJobErrorContract('{')).toThrow();
    expect(() => parseJobErrorContract(JSON.stringify({
      ...JOB_ERROR_CONTRACT,
      version: 2,
    }))).toThrow(/unsupported/);
    expect(() => parseJobErrorContract(JSON.stringify({
      ...JOB_ERROR_CONTRACT,
      documentError: { ...JOB_ERROR_CONTRACT.documentError, documentId: '' },
    }))).toThrow(/invalid documentError/);
    expect(() => parseJobErrorContract(JSON.stringify({
      ...JOB_ERROR_CONTRACT,
      ownerError: {
        ...JOB_ERROR_CONTRACT.ownerError,
        code: JOB_ERROR_CONTRACT.documentError.code,
      },
    }))).toThrow(/must be distinct/);
  });
});
