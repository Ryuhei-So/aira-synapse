import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/aira-synapse-backend-compat.yml',
);

type WorkflowStep = {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
};

type WorkflowJob = {
  'runs-on': string;
  env?: Record<string, string>;
  steps: WorkflowStep[];
};

describe('TASK-AGDB-040/041: backend compatibility workflow contract', () => {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8');
  const workflow = parse(raw) as Record<string, unknown>;
  const jobs = workflow.jobs as Record<string, WorkflowJob>;

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

  it('triggers workflow changes and production-runtime branch pushes', () => {
    const on = workflow.on as Record<string, unknown>;
    const pr = on.pull_request as { paths: string[] };
    const push = on.push as { branches: string[]; paths: string[] };
    const workflowPaths = [
      '.github/workflows/aira-synapse-backend-compat.yml',
      '.github/workflows/memgraphrag-ci.yml',
    ];

    expect(pr.paths).toEqual(expect.arrayContaining(workflowPaths));
    expect(push.paths).toEqual(expect.arrayContaining(workflowPaths));
    expect(push.branches).toEqual(expect.arrayContaining(['main', 'production-runtime', 'production-runtime/**']));
  });

  it('checks out the exact GraphDB authority in every owning job', () => {
    const graphDbJobs = Object.keys(jobs);
    for (const jobName of graphDbJobs) {
      const job = jobs[jobName]!;
      expect(job.env, `missing GraphDB env in ${jobName}`).toEqual(expect.objectContaining({
        AIRA_GRAPHDB_REPO_PATH: '${{ github.workspace }}/aira-graphdb',
        AIRA_GRAPHDB_EXPECTED_SHA: 'a5e25c008a704363a323782fa6571f07a47f9975',
      }));
      const graphDbCheckout = job.steps.find(
        (step) => step.uses === 'actions/checkout@v4'
          && step.with?.repository === 'Ryuhei-So/aira-graphdb',
      );
      expect(graphDbCheckout, `missing exact GraphDB checkout in ${jobName}`).toBeDefined();
      expect(graphDbCheckout?.with).toEqual(expect.objectContaining({
        ref: 'a5e25c008a704363a323782fa6571f07a47f9975',
        path: 'aira-graphdb',
      }));
    }
  });

  it('uses a test-only transaction owner whenever CI mutates the exact native', () => {
    for (const jobName of ['storage-port-compat', 'backend-compat', 'backend-compat-strict']) {
      const job = jobs[jobName]!;
      expect(job.env?.AIRA_GRAPHDB_NATIVE_CMD).toBe(
        'node ${{ github.workspace }}/packages/memgraphrag/scripts/native-transaction-owner.test-fixture.mjs ${{ github.workspace }}/aira-graphdb/target/release/aira-graphdb-native',
      );
      expect(job.steps.some((step) => step.run?.includes(
        'cargo build --locked --release --bin aira-graphdb-native',
      ))).toBe(true);
    }
    expect(raw).not.toContain('batch_prepare_commit');
  });

  it('discovers the .spec.ts contract and preserves raw command exits', () => {
    const contractJob = jobs['storage-port-contract']!;
    const contractRun = contractJob.steps.find((step) => step.run?.includes('vitest.contract.config.ts'));
    expect(contractRun?.run).toContain('vitest.contract.config.ts');
    expect(contractRun?.['working-directory']).toBe('packages/memgraphrag');
    expect(raw).toContain('exit "$status"');
    expect(raw).not.toMatch(/continue-on-error|baseline|ratchet|\|\|\s*true/);
  });
});
