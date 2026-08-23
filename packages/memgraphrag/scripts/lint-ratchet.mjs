import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function normalizeDiagnostics(data, cwd = process.cwd()) {
  if (!Array.isArray(data)) throw new Error('lint diagnostics must be an array');
  return data.flatMap((file) => (file.messages ?? []).map((message) => ({
    file: relative(cwd, file.filePath).split('\\').join('/'),
    line: message.line,
    column: message.column,
    endLine: message.endLine ?? null,
    endColumn: message.endColumn ?? null,
    severity: message.severity,
    ruleId: message.ruleId,
    message: message.message,
  }))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function compareDiagnostics(candidate, baseline) {
  const available = new Set((baseline ?? []).map((item) => JSON.stringify(item)));
  const added = candidate.filter((item) => !available.has(JSON.stringify(item)));
  if (added.length) throw new Error(`lint diagnostics added or changed: ${added.length}`);
  return true;
}

function baselineAtRef(repoRoot, sha) {
  try {
    return JSON.parse(execFileSync('git', ['-C', repoRoot, 'show', `${sha}:.github/memgraphrag-lint-baseline.json`], { encoding: 'utf8' }));
  } catch (error) {
    if (error?.status === 128) return null;
    throw error;
  }
}

const mode = process.argv[2];
if (mode === 'update') {
  const input = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  writeFileSync(process.argv[4], `${JSON.stringify(normalizeDiagnostics(input), null, 2)}\n`);
} else if (mode === 'verify') {
  try {
    const candidate = normalizeDiagnostics(JSON.parse(readFileSync(process.argv[3], 'utf8')), process.cwd());
    const checkedIn = JSON.parse(readFileSync(process.argv[4], 'utf8'));
    if (JSON.stringify(candidate) !== JSON.stringify(checkedIn)) throw new Error('checked-in lint baseline does not exactly match candidate diagnostics');
    const baseSha = process.argv[5];
    const base = baseSha ? baselineAtRef(resolve(process.cwd(), '../..'), baseSha) : null;
    compareDiagnostics(candidate, base ?? candidate);
    console.log(`lint ratchet passed: ${candidate.length} diagnostics`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  console.error('usage: lint-ratchet.mjs verify|update diagnostics.json baseline.json [base-sha]');
  process.exitCode = 1;
}
