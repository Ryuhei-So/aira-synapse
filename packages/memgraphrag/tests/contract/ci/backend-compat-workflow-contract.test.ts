import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/aira-synapse-backend-compat.yml',
);

describe('TASK-AGDB-040/041: backend compatibility workflow contract', () => {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8');
  const workflow = parse(raw) as Record<string, unknown>;
  const jobs = workflow.jobs as Record<string, { 'runs-on': string; steps: Array<{ uses?: string }> }>;

  it('contains required compatibility and governance jobs', () => {
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining([
      'storage-port-contract',
      'storage-port-compat',
      'backend-compat',
      'backend-compat-strict',
      'branch-protection-audit',
      'branch-protection-audit-strict',
    ]));
  });

  it('runs on ubuntu-latest', () => {
    for (const job of Object.values(jobs)) {
      expect(job['runs-on']).toBe('ubuntu-latest');
    }
  });

  it('sets up Node 22 in all jobs', () => {
    for (const [name, job] of Object.entries(jobs)) {
      const nodeStep = job.steps.find((s) => s.uses?.startsWith('actions/setup-node'));
      expect(nodeStep, `missing setup-node in ${name}`).toBeDefined();
    }
  });
});
