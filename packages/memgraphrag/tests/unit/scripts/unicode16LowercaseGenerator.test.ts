import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const generatorPath = join(packageRoot, 'scripts/generate-unicode16-lowercase.mjs');
const ucdNames = ['UnicodeData.txt', 'SpecialCasing.txt', 'DerivedCoreProperties.txt'] as const;
const temporaryRoots: string[] = [];

async function makeGeneratorRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'synapse-unicode16-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'vendor/unicode/16.0.0/ucd'), { recursive: true });
  await copyFile(generatorPath, join(root, 'scripts/generate-unicode16-lowercase.mjs'));
  for (const name of ucdNames) {
    await copyFile(join(packageRoot, 'vendor/unicode/16.0.0/ucd', name), join(root, 'vendor/unicode/16.0.0/ucd', name));
  }
  execFileSync(process.execPath, [join(root, 'scripts/generate-unicode16-lowercase.mjs')], { cwd: root, stdio: 'pipe' });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Unicode 16 generator failure gates', () => {
  it('checks the repository artifacts without rewriting them', () => {
    expect(() => execFileSync(process.execPath, [generatorPath, '--check'], { cwd: packageRoot, stdio: 'pipe' })).not.toThrow();
  });

  it('rejects generated-output drift', async () => {
    const root = await makeGeneratorRoot();
    const generated = join(root, 'src/domain/text/unicode16Lowercase.generated.ts');
    await writeFile(generated, `${await readFile(generated, 'utf8')}\n// drift\n`, 'utf8');
    const result = spawnSync(process.execPath, [join(root, 'scripts/generate-unicode16-lowercase.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/drift detected/);
  });

  it('rejects a one-byte UCD authority change before generation', async () => {
    const root = await makeGeneratorRoot();
    const unicodeData = join(root, 'vendor/unicode/16.0.0/ucd/UnicodeData.txt');
    const bytes = await readFile(unicodeData);
    bytes[0] = bytes[0] === 0x30 ? 0x31 : 0x30;
    await writeFile(unicodeData, bytes);
    const result = spawnSync(process.execPath, [join(root, 'scripts/generate-unicode16-lowercase.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/UnicodeData\.txt SHA-256 mismatch/);
  });
});

