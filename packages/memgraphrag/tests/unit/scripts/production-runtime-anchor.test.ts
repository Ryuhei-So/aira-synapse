import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  artifactSha256,
  EXPECTED_ARTIFACT_SHA256,
  TRUSTED_BASE,
  verifyProductionRuntimeAnchor,
} from '../../../scripts/production-runtime-anchor.mjs';

const packageRoot = resolve(import.meta.dirname, '../../..');
const repoRoot = resolve(packageRoot, '../..');
const anchorPath = resolve(repoRoot, '.github/anchors/production-runtime-8414946.json');

function readAnchor(): Record<string, unknown> {
  return JSON.parse(readFileSync(anchorPath, 'utf8')) as Record<string, unknown>;
}

describe('trusted production-runtime baseline anchor', () => {
  it('verifies the reviewed base evidence and seals its artifact', () => {
    const artifact = readAnchor();

    expect(artifactSha256(artifact)).toBe(EXPECTED_ARTIFACT_SHA256);
    expect(verifyProductionRuntimeAnchor(repoRoot)).toEqual(TRUSTED_BASE);
    expect(TRUSTED_BASE.source).toMatchObject({
      repository: 'Ryuhei-So/aira-synapse',
      branch: 'production-runtime',
      upstreamIssue: 'nahisaho/aira-synapse#1',
    });
    expect(artifact.status).toBe('inconclusive');
    expect(artifact.decision).toBe('no-improvement');
    expect((artifact.strictCoverage as { metrics: unknown }).metrics).toBeNull();
  });

  it('rejects candidate-controlled base or coverage substitutions', () => {
    const changedBase = readAnchor();
    (changedBase.source as { headSha: string }).headSha = 'c2413c1d9dd7903caad19c0b3007f8d6c0b76655';
    expect(() => verifyProductionRuntimeAnchor(repoRoot, changedBase)).toThrow();

    const changedCoverage = readAnchor();
    (changedCoverage.strictCoverage as { metrics: unknown }).metrics = {
      lines: { covered: 1, total: 1 },
    };
    expect(() => verifyProductionRuntimeAnchor(repoRoot, changedCoverage)).toThrow();

    const changedAuthority = readAnchor();
    (changedAuthority.source as { repository: string }).repository = 'nahisaho/aira-synapse';
    expect(() => verifyProductionRuntimeAnchor(repoRoot, changedAuthority)).toThrow();
  });
});
