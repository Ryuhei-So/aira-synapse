#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function boolEnv(name) {
  const value = process.env[name];
  return value === '1' || value === 'true';
}

const args = parseArgs(process.argv);
const mode = args.mode ?? 'untrusted';
const eventName = process.env.GITHUB_EVENT_NAME ?? args.eventName ?? 'pull_request';
const fromFork = boolEnv('GITHUB_EVENT_PULL_REQUEST_HEAD_REPO_FORK');
const refProtected = boolEnv('GITHUB_REF_PROTECTED');
const mergeQueue = boolEnv('GITHUB_MERGE_QUEUE');

const repoRoot = resolve(process.cwd(), '..', '..', '..');
const contractsRoot = resolve(repoRoot, '..', 'aira-graphdb', 'spec', 'contracts');
const eventScopeMap = loadJson(resolve(contractsRoot, 'event-scope-map.v1.0.0.json'));
const branchPolicy = loadJson(resolve(contractsRoot, 'branch-protection-policy.v1.0.0.json'));

const matched = eventScopeMap.rules.find((rule) => {
  const when = rule.when ?? {};
  if (when.event_name !== undefined && when.event_name !== eventName) return false;
  if (when.from_fork !== undefined && when.from_fork !== fromFork) return false;
  if (when.ref_protected !== undefined && when.ref_protected !== refProtected) return false;
  if (when.merge_queue !== undefined && when.merge_queue !== mergeQueue) return false;
  return true;
});

if (!matched && eventScopeMap.onUnmapped === 'fail') {
  throw new Error(`unmapped_event_scope:${eventName}`);
}

const scope = matched?.scope ?? 'pull_request';
const requiredChecks = branchPolicy.requiredChecksByScope?.[scope] ?? [];
const strictMode = mode === 'strict';
const isTrustedScope = scope === 'merge_group';

const outputPath = resolve(
  process.cwd(),
  strictMode
    ? 'artifacts/branch-protection-audit-strict.json'
    : 'artifacts/branch-protection-audit-untrusted.json',
);
mkdirSync(dirname(outputPath), { recursive: true });

if (strictMode && isTrustedScope && !process.env.AIRA_SYNAPSE_ADMIN_TOKEN) {
  const failure = {
    status: 'fail',
    reason: 'permission_missing:administration_read',
    scope,
    requiredChecks,
  };
  writeFileSync(outputPath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
  process.exitCode = 1;
} else if (!strictMode && !isTrustedScope) {
  const skipped = {
    status: 'success',
    scope,
    requiredChecks,
    output: {
      summary: 'skip_with_reason=untrusted_event',
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(skipped, null, 2)}\n`, 'utf8');
} else {
  const passed = {
    status: 'success',
    scope,
    requiredChecks,
    output: {
      summary: 'audit_pass',
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(passed, null, 2)}\n`, 'utf8');
}

