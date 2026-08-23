import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../../../scripts/branch-protection-audit.mjs');

describe('branch-protection-audit GraphDB contract path', () => {
  it('uses AIRA_GRAPHDB_REPO_PATH as the contract authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'branch-protection-audit-'));
    const graphdb = join(root, 'graphdb');
    const contracts = join(graphdb, 'spec', 'contracts');
    mkdirSync(contracts, { recursive: true });
    writeFileSync(join(contracts, 'event-scope-map.v1.0.0.json'), JSON.stringify({
      rules: [{ when: { event_name: 'pull_request' }, scope: 'pull_request' }],
      onUnmapped: 'fail',
    }));
    writeFileSync(join(contracts, 'branch-protection-policy.v1.0.0.json'), JSON.stringify({
      requiredChecksByScope: { pull_request: ['branch-protection-audit'] },
    }));

    try {
      execFileSync(process.execPath, [SCRIPT, '--mode', 'untrusted'], {
        cwd: root,
        env: { ...process.env, AIRA_GRAPHDB_REPO_PATH: graphdb, GITHUB_EVENT_NAME: 'pull_request' },
        stdio: 'pipe',
      });
      const output = JSON.parse(readFileSync(join(root, 'artifacts/branch-protection-audit-untrusted.json'), 'utf8')) as {
        status: string;
        scope: string;
      };
      expect(output).toEqual(expect.objectContaining({ status: 'success', scope: 'pull_request' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the GraphDB path authority is absent', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, '--mode', 'untrusted'], {
      cwd: process.cwd(),
      env: { ...process.env, AIRA_GRAPHDB_REPO_PATH: undefined },
      stdio: 'pipe',
    })).toThrow();
  });
});
