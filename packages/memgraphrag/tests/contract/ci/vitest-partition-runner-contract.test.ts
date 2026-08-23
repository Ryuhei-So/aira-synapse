import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const PACKAGE_ROOT = resolve(REPO_ROOT, 'packages/memgraphrag');
const RUNNER = resolve(PACKAGE_ROOT, 'scripts/run-vitest-partitions.mjs');

type Partition = {
  files: string[];
  regular: string[];
  resource: string[];
  invocations: string[][];
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
  it('partitions Vitest inventory into a complete, case-insensitive set union', () => {
    const partition = readPartition();
    const inventory = new Set(partition.files.map((file) => file.toLowerCase()));
    const regular = new Set(partition.regular.map((file) => file.toLowerCase()));
    const resource = new Set(partition.resource.map((file) => file.toLowerCase()));

    expect(partition.files.length).toBeGreaterThan(0);
    expect(regular.size + resource.size).toBe(inventory.size);
    expect([...regular].some((file) => resource.has(file))).toBe(false);
    expect(new Set([...regular, ...resource])).toEqual(inventory);
    const isResource = (file: string) => /ladybug|native|aira[-_]graphdb/i.test(
      `${file}\n${readFileSync(file, 'utf8')}`,
    );
    expect(partition.resource.every(isResource)).toBe(true);
    expect(partition.regular.some(isResource)).toBe(false);
  });

  it('keeps resource tests as individual files for fresh processes', () => {
    const partition = readPartition();
    const flattened = partition.invocations.flat();
    expect(partition.resource.length).toBeGreaterThan(0);
    expect(partition.invocations[0]).toEqual(partition.regular);
    expect(partition.invocations.slice(1)).toEqual(
      partition.resource.map((file) => [file]),
    );
    expect(new Set(flattened).size).toBe(flattened.length);
    expect([...flattened].sort()).toEqual([...partition.files].sort());
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
