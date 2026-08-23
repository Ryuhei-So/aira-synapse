import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const PACKAGE_ROOT = resolve(REPO_ROOT, 'packages/memgraphrag');
const RUNNER = resolve(PACKAGE_ROOT, 'scripts/run-vitest-partitions.mjs');
const RESOURCE_MANIFEST = resolve(
  PACKAGE_ROOT,
  'tests/contract/ci/vitest-resource-partitions.json',
);

type Partition = {
  files: string[];
  regular: string[];
  resource: string[];
  resourceFile: string[];
  resourceCaseFiles: string[];
  resourceTests: Array<{ file: string; name: string; line: number }>;
  invocations: Array<{
    files: string[];
    test?: { file: string; name: string; line: number };
  }>;
  coverageMerge: boolean;
};

function readPartition(): Partition {
  const output = execFileSync(process.execPath, [RUNNER, '--print-partition'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(output) as Partition;
}

describe('Vitest process partition runner contract', () => {
  it('partitions Vitest inventory from the explicit resource manifest', async () => {
    const partition = readPartition();
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(
      RESOURCE_MANIFEST,
      'utf8',
    )) as { freshProcessPerFile: string[]; freshProcessPerTest: string[] };
    const inventory = new Set(partition.files.map((file) => file.toLowerCase()));
    const regular = new Set(partition.regular.map((file) => file.toLowerCase()));
    const resource = new Set(partition.resource.map((file) => file.toLowerCase()));
    const expectedResourceFile = manifest.freshProcessPerFile.map((file) => resolve(PACKAGE_ROOT, file));
    const expectedResourceCaseFiles = manifest.freshProcessPerTest.map((file) => resolve(PACKAGE_ROOT, file));

    expect(partition.files.length).toBeGreaterThan(0);
    expect(regular.size + resource.size).toBe(inventory.size);
    expect([...regular].some((file) => resource.has(file))).toBe(false);
    expect(new Set([...regular, ...resource])).toEqual(inventory);
    expect(partition.resourceFile).toEqual(expectedResourceFile);
    expect(partition.resourceCaseFiles).toEqual(expectedResourceCaseFiles);
  });

  it('keeps resource tests as individual files for fresh processes', () => {
    const partition = readPartition();
    const invokedFiles = partition.invocations.flatMap((invocation) => invocation.files);
    expect(partition.resource.length).toBeGreaterThan(0);
    expect(partition.resourceCaseFiles.length).toBeGreaterThan(0);
    expect(partition.resourceCaseFiles).toContain(
      resolve(PACKAGE_ROOT, 'tests/infrastructure/storage/ladybug/LadybugConnection.test.ts'),
    );
    expect(partition.invocations[0]).toEqual({ files: partition.regular });
    expect(partition.invocations.slice(1, 1 + partition.resourceFile.length)).toEqual(
      partition.resourceFile.map((file) => ({ files: [file] })),
    );
    expect(partition.invocations.slice(1 + partition.resourceFile.length)).toEqual(
      partition.resourceTests.map((test) => ({ files: [`${test.file}:${test.line}`], test })),
    );
    expect(new Set(partition.resourceTests.map((test) => `${test.file}\0${test.line}`)).size)
      .toBe(partition.resourceTests.length);
    expect(partition.resourceCaseFiles.every((file) => (
      invokedFiles.some((invocation) => invocation.startsWith(`${file}:`))
    ))).toBe(true);
    expect(partition.coverageMerge).toBe(true);
  });

  it('uses an isolated temporary blob directory and merges coverage once', async () => {
    const source = await import('node:fs/promises');
    const runnerSource = await source.readFile(RUNNER, 'utf8');
    expect(runnerSource).toContain("mkdtempSync(resolve(tmpdir(), 'aira-synapse-vitest-'))");
    expect(runnerSource).toContain("'--reporter=blob'");
    expect(runnerSource).toContain("'--merge-reports', blobDir");
    expect(runnerSource).toContain("process.once('SIGINT'");
    expect(runnerSource).toContain("process.once('SIGTERM'");
  });
});
