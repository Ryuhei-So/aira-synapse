import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import {
  checkV15ParityArtifact,
  checkV15ParityAttestation,
  projectV15ParityAttestation,
  serializeV15ParityJson,
} from '../../domain/retrieval/v15ParityEvidence.js';

const LIMITS = {
  artifact: 64 * 1024 * 1024,
  copyManifest: 1024 * 1024,
  fixture: 128 * 1024 * 1024,
  attestation: 16 * 1024 * 1024,
} as const;

export async function readV15ParityInput(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('UNSAFE_INPUT_FILE');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path, { bigint: true });
    if (
      bytes.length !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || BigInt(after.dev) !== pathAfter.dev
      || BigInt(after.ino) !== pathAfter.ino
      || BigInt(after.size) !== pathAfter.size
      || !pathAfter.isFile()
      || pathAfter.nlink !== 1n
    ) throw new Error('INPUT_IDENTITY_CHANGED');
    return bytes;
  } finally {
    await handle.close();
  }
}

function requireArgs(actual: readonly string[], expected: number, usage: string): void {
  if (actual.length !== expected) throw new Error(`USAGE:${usage}`);
}

export async function runV15ParityEvidenceCli(operation: string | undefined, args: readonly string[]): Promise<Buffer> {
  if (operation === '--check-private') {
    requireArgs(args, 3, '--check-private <artifact> <copy-manifest> <fixture>');
    const [artifact, copyManifest, fixture] = await Promise.all([
      readV15ParityInput(args[0]!, LIMITS.artifact),
      readV15ParityInput(args[1]!, LIMITS.copyManifest),
      readV15ParityInput(args[2]!, LIMITS.fixture),
    ]);
    checkV15ParityArtifact(artifact, copyManifest, fixture);
    return Buffer.from('V15_PARITY_PRIVATE_OK\n');
  }
  if (operation === '--project-private') {
    requireArgs(args, 3, '--project-private <artifact> <copy-manifest> <fixture>');
    const [artifact, copyManifest, fixture] = await Promise.all([
      readV15ParityInput(args[0]!, LIMITS.artifact),
      readV15ParityInput(args[1]!, LIMITS.copyManifest),
      readV15ParityInput(args[2]!, LIMITS.fixture),
    ]);
    return serializeV15ParityJson(projectV15ParityAttestation(artifact, copyManifest, fixture));
  }
  if (operation === '--check-public') {
    requireArgs(args, 1, '--check-public <attestation>');
    const attestation = await readV15ParityInput(args[0]!, LIMITS.attestation);
    checkV15ParityAttestation(attestation);
    return Buffer.from('V15_PARITY_PUBLIC_OK\n');
  }
  throw new Error('USAGE:--check-private|--project-private|--check-public');
}
