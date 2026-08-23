import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export const METRICS = ['lines', 'statements', 'functions', 'branches'];

function metric(value, label) {
  if (!value || !Number.isInteger(value.covered) || !Number.isInteger(value.total)
    || value.covered < 0 || value.total < 0 || value.covered > value.total) {
    throw new Error(`invalid ${label} coverage metric`);
  }
  return { covered: value.covered, total: value.total };
}

export function normalizeSummary(summary, packageRoot = process.cwd()) {
  if (!summary || typeof summary !== 'object' || !summary.total) {
    throw new Error('coverage summary is missing total');
  }
  const files = Object.keys(summary).filter((key) => key !== 'total')
    .map((key) => relative(packageRoot, key).split('\\').join('/')).sort();
  if (files.length === 0 || files.some((file) => file.startsWith('../') || file === '..')) {
    throw new Error('coverage summary has invalid source file set');
  }
  const metrics = Object.fromEntries(METRICS.map((name) => [name, metric(summary.total[name], name)]));
  return {
    metrics,
    sourceFiles: files,
    sourceFileSetSha256: createHash('sha256').update(`${files.join('\n')}\n`).digest('hex'),
  };
}

export function compareRatchet(candidate, baseline) {
  if (!baseline || typeof baseline !== 'object' || baseline.version !== 1
    || baseline.targetPct !== 80 || typeof baseline.sourceFileSetSha256 !== 'string'
    || !baseline.metrics) throw new Error('malformed coverage baseline');
  if (candidate.sourceFileSetSha256 !== baseline.sourceFileSetSha256) {
    throw new Error('coverage source file set drifted; intentional baseline refresh required');
  }
  for (const name of METRICS) {
    const current = candidate.metrics[name];
    const previous = metric(baseline.metrics[name], name);
    if (current.covered * previous.total < previous.covered * current.total) {
      throw new Error(`${name} coverage regressed (${current.covered}/${current.total} < ${previous.covered}/${previous.total})`);
    }
  }
  return true;
}

export function baselineFor(summary, packageRoot = process.cwd()) {
  const normalized = normalizeSummary(summary, packageRoot);
  const currentDebt = Object.fromEntries(METRICS.map((name) => {
    const { covered, total } = normalized.metrics[name];
    const actualPct = total === 0 ? 100 : (covered * 100) / total;
    return [name, { targetPct: 80, actualPct: Number(actualPct.toFixed(2)), debtPct: Number(Math.max(0, 80 - actualPct).toFixed(2)) }];
  }));
  return { version: 1, targetPct: 80, sourceFileSetSha256: normalized.sourceFileSetSha256,
    metrics: normalized.metrics, currentDebt };
}

function main(args) {
  const mode = args[0];
  if (mode !== 'verify' && mode !== 'update') throw new Error('usage: coverage-ratchet.mjs verify|update [summary] [baseline]');
  const summaryPath = resolve(args[1] ?? 'coverage/coverage-summary.json');
  const baselinePath = resolve(args[2] ?? '../../.github/memgraphrag-coverage-baseline.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const next = baselineFor(summary, dirname(dirname(summaryPath)));
  if (mode === 'update') {
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  compareRatchet(next, baseline);
  console.log('coverage ratchet passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
