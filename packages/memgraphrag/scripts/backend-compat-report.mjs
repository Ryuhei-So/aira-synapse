#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1]?.startsWith('--') ? 'true' : argv[++i];
    args[key] = value;
  }
  return args;
}

const args = parseArgs(process.argv);
const out = args.out ?? 'artifacts/backend-compat-report-untrusted.json';
const backend = args.backend ?? 'aira-graphdb';
const status = args.status ?? 'pass';
const errorCode = args.errorCode ?? 'INVALID_ARGUMENT';
const failedCompatibilityTestIds = (args.failedTests ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const report = status === 'pass'
  ? { backend, status: 'pass' }
  : {
    backend,
    status: 'fail',
    errorCode,
    failedCompatibilityTestIds: failedCompatibilityTestIds.length > 0
      ? failedCompatibilityTestIds
      : ['backend-compat:unknown'],
  };

const outPath = resolve(process.cwd(), out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

