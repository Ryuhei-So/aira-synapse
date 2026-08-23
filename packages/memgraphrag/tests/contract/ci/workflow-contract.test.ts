import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/memgraphrag-ci.yml',
);
const BACKEND_WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/aira-synapse-backend-compat.yml',
);
const PACKAGE_PATH = resolve(REPO_ROOT, 'packages/memgraphrag/package.json');

type WorkflowStep = {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  'runs-on': string;
  env?: Record<string, string>;
  strategy?: {
    matrix?: Record<string, unknown>;
  };
  steps: Array<WorkflowStep & { 'working-directory'?: string }>;
};

describe('TASK-MG-004: CI workflow contract', () => {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8');
  const workflow = parse(raw) as Record<string, unknown>;
  const jobs = workflow['jobs'] as Record<string, WorkflowJob>;

  it('should have required jobs: Unicode conformance, lint, test, coverage, build', () => {
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining([
        'unicode16-conformance',
        'unicode16-oracle',
        'lint',
        'test',
        'coverage',
        'build',
      ]),
    );
  });

  it('should run on ubuntu-latest for all jobs', () => {
    for (const [_name, job] of Object.entries(jobs)) {
      expect(job['runs-on']).toBe('ubuntu-latest');
    }
  });

  it('should keep standard jobs on Node 22', () => {
    for (const jobName of ['lint', 'test', 'coverage', 'build']) {
      const job = jobs[jobName];
      expect(job).toBeDefined();
      const nodeStep = job.steps.find(
        (s) => s.uses?.startsWith('actions/setup-node'),
      );
      expect(nodeStep).toBeDefined();
      expect(nodeStep?.with?.['node-version']).toBe('22');
    }
  });

  it('should prove Unicode 16 conformance on exactly Node 22 and Node 24', () => {
    const job = jobs['unicode16-conformance'];
    expect(job).toBeDefined();
    expect(job!.strategy?.matrix?.['node-version']).toEqual(['22', '24']);

    const nodeStep = job!.steps.find(
      (s) => s.uses?.startsWith('actions/setup-node'),
    );
    expect(nodeStep?.with?.['node-version']).toBe('${{ matrix.node-version }}');

    const runs = job!.steps.flatMap((step) =>
      typeof step.run === 'string' ? [step.run] : [],
    );
    expect(runs).toContain(
      'npm run check:unicode16-lowercase --workspace=packages/memgraphrag',
    );
    expect(runs).toContain(
      'npm test --workspace=packages/memgraphrag -- tests/unit/domain/text/unicode16Lowercase.test.ts tests/unit/scripts/unicode16LowercaseGenerator.test.ts',
    );
  });

  it('should pin the ambient Unicode 16 oracle to Node 24.11.1', () => {
    const job = jobs['unicode16-oracle'];
    expect(job).toBeDefined();
    expect(job!.env).toEqual({ UNICODE16_AMBIENT_ORACLE: '1' });
    const nodeStep = job!.steps.find(
      (s) => s.uses?.startsWith('actions/setup-node'),
    );
    expect(nodeStep?.with?.['node-version']).toBe('24.11.1');
    const runs = job!.steps.flatMap((step) =>
      typeof step.run === 'string' ? [step.run] : [],
    );
    expect(runs).toContain(
      'npm run check:unicode16-lowercase --workspace=packages/memgraphrag',
    );
    expect(runs).toContain(
      'npm test --workspace=packages/memgraphrag -- tests/unit/domain/text/unicode16Lowercase.test.ts tests/unit/scripts/unicode16LowercaseGenerator.test.ts',
    );
  });

  it('should set up Python in test and coverage jobs', () => {
    for (const jobName of ['test', 'coverage']) {
      const job = jobs[jobName];
      expect(job).toBeDefined();
      const pyStep = job!.steps.find(
        (s) => s.uses?.startsWith('actions/setup-python'),
      );
      expect(pyStep).toBeDefined();
    }
  });

  it('should trigger on PR changes to packages/memgraphrag/**', () => {
    const on = workflow['on'] as Record<string, unknown>;
    const pr = on['pull_request'] as { paths: string[] };
    expect(pr.paths).toContain('packages/memgraphrag/**');
  });

  it('should trigger workflow changes and production-runtime branch pushes', () => {
    const on = workflow['on'] as Record<string, unknown>;
    const pr = on['pull_request'] as { paths: string[] };
    const push = on['push'] as { branches: string[]; paths: string[] };
    const workflowPaths = [
      '.github/workflows/aira-synapse-backend-compat.yml',
      '.github/workflows/memgraphrag-ci.yml',
    ];

    expect(pr.paths).toEqual(expect.arrayContaining(workflowPaths));
    expect(push.paths).toEqual(expect.arrayContaining(workflowPaths));
    expect(push.branches).toEqual(expect.arrayContaining(['main', 'production-runtime', 'production-runtime/**']));
  });

  it('checks out the attested GraphDB authority for native test and coverage jobs', () => {
    for (const jobName of ['test', 'coverage']) {
      const job = jobs[jobName]!;
      expect(job.env).toEqual(expect.objectContaining({
        AIRA_GRAPHDB_REPO_PATH: '${{ github.workspace }}/aira-graphdb',
        AIRA_GRAPHDB_EXPECTED_SHA: '164092aa47f39330c0c771495d9d42e4e935e41b',
        AIRA_GRAPHDB_NATIVE_CMD: '${{ github.workspace }}/aira-graphdb/target/release/aira-graphdb-native',
      }));
      const graphDbCheckout = job.steps.find(
        (step) => step.uses === 'actions/checkout@v4'
          && step.with?.repository === 'Ryuhei-So/aira-graphdb',
      );
      expect(graphDbCheckout).toBeDefined();
      expect(graphDbCheckout?.with).toEqual(expect.objectContaining({
        ref: '164092aa47f39330c0c771495d9d42e4e935e41b',
        path: 'aira-graphdb',
      }));
      const nativeBuild = job.steps.find((step) => step.run?.includes('cargo build'));
      expect(nativeBuild?.run).toContain(
        'cargo build --locked --release --bin aira-graphdb-native',
      );
      expect(nativeBuild?.run).toContain(
        '--manifest-path "$AIRA_GRAPHDB_REPO_PATH/Cargo.toml"',
      );
    }
  });

  it('keeps contract discovery explicit and rejects candidate-controlled gates', () => {
    const contractConfig = readFileSync(
      resolve(REPO_ROOT, 'packages/memgraphrag/vitest.contract.config.ts'),
      'utf-8',
    );
    expect(contractConfig).toContain('tests/contracts/aira_synapse_storage_ports_contract.spec.ts');
    expect(contractConfig).toContain('tests/setup/vitest.setup.ts');

    const backendWorkflow = readFileSync(BACKEND_WORKFLOW_PATH, 'utf-8');
    for (const content of [raw, backendWorkflow]) {
      expect(content).not.toMatch(/continue-on-error|baseline|ratchet|\|\|\s*true/);
    }
  });

  it('should run npm run lint in lint job', () => {
    const lintRuns = jobs['lint']!.steps
      .filter((s) => s.run)
      .map((s) => s.run);
    expect(lintRuns.some((r) => r?.includes('lint'))).toBe(true);
  });

  it('should run npm run test in test job', () => {
    const testRuns = jobs['test']!.steps
      .filter((s) => s.run)
      .map((s) => s.run);
    expect(testRuns.some((r) => r === 'npm run test:ci --workspace=packages/memgraphrag')).toBe(true);
    const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      scripts?: { 'test:ci'?: string };
    };
    expect(packageJson.scripts?.['test:ci']).toBe('node scripts/run-vitest-partitions.mjs');
  });

  it('should run npm run test:coverage in coverage job', () => {
    const covRuns = jobs['coverage']!.steps
      .filter((s) => s.run)
      .map((s) => s.run);
    expect(covRuns.some((r) => r === 'npm run test:coverage:ci --workspace=packages/memgraphrag')).toBe(true);
    const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      scripts?: { 'test:coverage:ci'?: string };
    };
    expect(packageJson.scripts?.['test:coverage:ci']).toBe('node scripts/run-vitest-partitions.mjs --coverage');
  });
});
