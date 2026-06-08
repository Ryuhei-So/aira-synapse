import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/memgraphrag-ci.yml',
);

describe('TASK-MG-004: CI workflow contract', () => {
  const raw = readFileSync(WORKFLOW_PATH, 'utf-8');
  const workflow = parse(raw) as Record<string, unknown>;
  const jobs = workflow['jobs'] as Record<
    string,
    { 'runs-on': string; steps: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }> }
  >;

  it('should have required jobs: lint, test, coverage, build', () => {
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining(['lint', 'test', 'coverage', 'build']),
    );
  });

  it('should run on ubuntu-latest for all jobs', () => {
    for (const [_name, job] of Object.entries(jobs)) {
      expect(job['runs-on']).toBe('ubuntu-latest');
    }
  });

  it('should set up Node 22 in all jobs', () => {
    for (const [_name, job] of Object.entries(jobs)) {
      const nodeStep = job.steps.find(
        (s) => s.uses?.startsWith('actions/setup-node'),
      );
      expect(nodeStep).toBeDefined();
      expect(nodeStep?.with?.['node-version']).toBe('22');
    }
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
    expect(testRuns.some((r) => r?.includes('test'))).toBe(true);
  });

  it('should run npm run test:coverage in coverage job', () => {
    const covRuns = jobs['coverage']!.steps
      .filter((s) => s.run)
      .map((s) => s.run);
    expect(covRuns.some((r) => r?.includes('test:coverage'))).toBe(true);
  });
});
