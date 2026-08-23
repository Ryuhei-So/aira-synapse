#!/usr/bin/env node

/**
 * Run the complete Vitest inventory with isolated processes for tests that
 * open native/Ladybug resources.  The partition is derived from Vitest's own
 * file inventory so ordinary and resource-heavy tests cannot silently drift.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = resolve(packageRoot, '../../node_modules/.bin/vitest');
const resourcePattern = /ladybug|native|aira[-_]graphdb/i;
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

function partition(files) {
  const seen = new Set();
  const regular = [];
  const resource = [];
  for (const file of files) {
    const key = file.toLowerCase();
    if (seen.has(key)) throw new Error(`Vitest inventory contains duplicate file: ${file}`);
    seen.add(key);
    const authority = `${file}\n${readFileSync(file, 'utf8')}`;
    (resourcePattern.test(authority) ? resource : regular).push(file);
  }
  if (regular.length + resource.length !== files.length) {
    throw new Error('Vitest partition lost files');
  }
  return { regular, resource };
}

function runVitest(files, { coverage, blobDir, config }) {
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
    env: process.env,
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
  if (new Set([...groups.regular, ...groups.resource].map((file) => file.toLowerCase())).size !== files.length) {
    throw new Error('Vitest partition is not a complete set-union');
  }

  if (process.argv.includes('--print-partition')) {
    process.stdout.write(`${JSON.stringify({
      files,
      ...groups,
      invocations: [groups.regular, ...groups.resource.map((file) => [file])],
      coverageMerge: true,
    })}\n`);
    return;
  }

  const temp = mkdtempSync(resolve(tmpdir(), 'aira-synapse-vitest-'));
  const blobDir = resolve(temp, 'blob');
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
    await runVitest(groups.regular, { coverage, blobDir, config });
    for (const file of groups.resource) {
      await runVitest([file], { coverage, blobDir, config });
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
