#!/usr/bin/env node

/**
 * Run the complete Vitest inventory with isolated processes for tests that
 * open native/Ladybug resources.  The partition is derived from Vitest's own
 * file inventory so ordinary and resource-heavy tests cannot silently drift.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = resolve(packageRoot, '../../node_modules/.bin/vitest');
const resourceManifestPath = resolve(
  packageRoot,
  'tests/contract/ci/vitest-resource-partitions.json',
);
let blobSequence = 0;
let activeChild;
let receivedSignal;
let signalEscalation;

function listFiles(config) {
  const args = ['list', '--filesOnly'];
  if (config) args.push('--config', config);
  const output = execFileSync(vitest, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: process.env,
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => resolve(packageRoot, file));
}

function listTests(config) {
  const args = ['list', '--json', '--includeTaskLocation'];
  if (config) args.push('--config', config);
  const output = execFileSync(vitest, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: process.env,
  });
  const tests = JSON.parse(output);
  if (!Array.isArray(tests)) throw new Error('Vitest test inventory is not an array');
  return tests.map((test) => {
    if (!test || typeof test.name !== 'string' || typeof test.file !== 'string'
        || !Number.isSafeInteger(test.location?.line) || test.location.line < 1) {
      throw new Error('Vitest test inventory contains an invalid entry');
    }
    return { name: test.name, file: resolve(test.file), line: test.location.line };
  });
}

function readResourceManifest() {
  const manifest = JSON.parse(readFileSync(resourceManifestPath, 'utf8'));
  if (!manifest || manifest.version !== 1
      || !Array.isArray(manifest.freshProcessPerFile)
      || !Array.isArray(manifest.freshProcessPerTest)) {
    throw new Error('Vitest resource partition manifest is invalid');
  }
  return manifest;
}

function partition(files) {
  const seen = new Set();
  const inventory = new Map();
  for (const file of files) {
    const key = file.toLowerCase();
    if (seen.has(key)) throw new Error(`Vitest inventory contains duplicate file: ${file}`);
    seen.add(key);
    inventory.set(key, file);
  }
  const manifest = readResourceManifest();
  const resolveEntries = (entries, mode) => entries.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`Vitest resource partition ${mode} contains an invalid path`);
    }
    const absolute = resolve(packageRoot, entry);
    const inventoried = inventory.get(absolute.toLowerCase());
    if (!inventoried) throw new Error(`Vitest resource partition is not in inventory: ${entry}`);
    return inventoried;
  });
  const resourceFile = resolveEntries(manifest.freshProcessPerFile, 'freshProcessPerFile');
  const resourceCaseFiles = resolveEntries(manifest.freshProcessPerTest, 'freshProcessPerTest');
  const resourceKeys = [...resourceFile, ...resourceCaseFiles].map((file) => file.toLowerCase());
  if (new Set(resourceKeys).size !== resourceKeys.length) {
    throw new Error('Vitest resource partition manifest contains duplicate or overlapping paths');
  }
  const resourceSet = new Set(resourceKeys);
  const regular = files.filter((file) => !resourceSet.has(file.toLowerCase()));
  if (regular.length + resourceFile.length + resourceCaseFiles.length !== files.length) {
    throw new Error('Vitest partition lost files');
  }
  return { regular, resourceFile, resourceCaseFiles };
}

function runVitest(files, { coverage, blobDir, config, childEnv }) {
  if (files.length === 0) return;
  if (receivedSignal) throw new Error(`Vitest partition runner interrupted by ${receivedSignal}`);
  const args = ['run', '--config', config, ...files];
  if (coverage) {
    mkdirSync(blobDir, { recursive: true });
    blobSequence += 1;
    const partitionCoverageDir = resolve(dirname(blobDir), 'coverage-parts', String(blobSequence));
    args.push(
      '--coverage',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${partitionCoverageDir}`,
      '--coverage.thresholds.lines=0',
      '--coverage.thresholds.statements=0',
      '--coverage.thresholds.branches=0',
      '--coverage.thresholds.functions=0',
      '--reporter=blob',
      `--outputFile=${resolve(blobDir, `${process.pid}-${blobSequence}.json`)}`,
    );
  }
  const result = spawn(vitest, args, {
    cwd: packageRoot,
    env: childEnv,
    stdio: 'inherit',
  });
  activeChild = result;
  return new Promise((resolvePromise, reject) => {
    result.once('error', reject);
    result.once('close', (code, signal) => {
      if (signalEscalation) clearTimeout(signalEscalation);
      signalEscalation = undefined;
      activeChild = undefined;
      if (code === 0) resolvePromise();
      else reject(new Error(`Vitest partition failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
  });
}

async function main() {
  const coverage = process.argv.includes('--coverage');
  const configIndex = process.argv.indexOf('--config');
  const config = configIndex >= 0 ? process.argv[configIndex + 1] : 'vitest.config.ts';
  const files = listFiles(config);
  const groups = partition(files);
  const resource = [...groups.resourceFile, ...groups.resourceCaseFiles];
  if (new Set([...groups.regular, ...resource].map((file) => file.toLowerCase())).size !== files.length) {
    throw new Error('Vitest partition is not a complete set-union');
  }
  const caseFileSet = new Set(groups.resourceCaseFiles.map((file) => file.toLowerCase()));
  const resourceTests = listTests(config).filter((test) => caseFileSet.has(test.file.toLowerCase()));
  const testKeys = resourceTests.map((test) => `${test.file.toLowerCase()}\0${test.line}`);
  if (new Set(testKeys).size !== testKeys.length) {
    throw new Error('Resource test locations must be unique within each file');
  }
  for (const file of groups.resourceCaseFiles) {
    if (!resourceTests.some((test) => test.file.toLowerCase() === file.toLowerCase())) {
      throw new Error(`Resource case file has no tests: ${file}`);
    }
  }
  const invocations = [
    { files: groups.regular },
    ...groups.resourceFile.map((file) => ({ files: [file] })),
    ...resourceTests.map((test) => ({ files: [`${test.file}:${test.line}`], test })),
  ];
  const plan = {
    files,
    ...groups,
    resource,
    resourceTests,
    invocations,
    coverageMerge: true,
  };

  if (process.argv.includes('--print-partition')) {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }

  const temp = mkdtempSync(resolve(tmpdir(), 'aira-synapse-vitest-'));
  const blobDir = resolve(temp, 'blob');
  const planPath = resolve(temp, 'partition-plan.json');
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { encoding: 'utf8', mode: 0o600 });
  const childEnv = { ...process.env, VITEST_PARTITION_PLAN_PATH: planPath };
  const cleanup = () => rmSync(temp, { recursive: true, force: true });
  const onSignal = (signal) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    activeChild?.kill(signal);
    signalEscalation = setTimeout(() => activeChild?.kill('SIGKILL'), 2_000);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await runVitest(groups.regular, { coverage, blobDir, config, childEnv });
    for (const file of groups.resourceFile) {
      await runVitest([file], { coverage, blobDir, config, childEnv });
    }
    for (const test of resourceTests) {
      await runVitest([`${test.file}:${test.line}`], { coverage, blobDir, config, childEnv });
    }
    if (coverage) {
      const merge = spawn(vitest, ['--merge-reports', blobDir, '--coverage', '--config', config], {
        cwd: packageRoot,
        env: process.env,
        stdio: 'inherit',
      });
      activeChild = merge;
      const code = await new Promise((resolvePromise, reject) => {
        merge.once('error', reject);
        merge.once('close', (exitCode, signal) => {
          if (signalEscalation) clearTimeout(signalEscalation);
          signalEscalation = undefined;
          activeChild = undefined;
          resolvePromise(exitCode === 0 ? 0 : (signal ? 1 : exitCode ?? 1));
        });
      });
      if (code !== 0) throw new Error(`Vitest coverage merge failed (code=${code})`);
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (signalEscalation) clearTimeout(signalEscalation);
    signalEscalation = undefined;
    cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = receivedSignal === 'SIGINT' ? 130 : receivedSignal === 'SIGTERM' ? 143 : 1;
});
