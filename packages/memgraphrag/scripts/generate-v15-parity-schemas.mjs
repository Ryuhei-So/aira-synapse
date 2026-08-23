#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  serializeV15ParityJson,
  v15CopyManifestSchema,
  v15ParityArtifactSchema,
  v15ParityAttestationSchema,
} from '../dist/domain/retrieval/v15ParityEvidence.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(packageRoot, 'config/v15-parity');
const check = process.argv.slice(2).includes('--check');

const schemas = [
  ['copy-manifest.schema.json', v15CopyManifestSchema, 'V15CopiedProductionCopyManifest@1'],
  ['private-artifact.schema.json', v15ParityArtifactSchema, 'V15CopiedProductionParityArtifact@1'],
  ['public-attestation.schema.json', v15ParityAttestationSchema, 'V15CopiedProductionParityAttestation@1'],
];

if (!check) await mkdir(outputRoot, { recursive: true });
for (const [filename, schema, id] of schemas) {
  const path = resolve(outputRoot, filename);
  const bytes = serializeV15ParityJson({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }),
  });
  if (check) {
    let existing;
    try {
      existing = await readFile(path);
    } catch {
      throw new Error(`MISSING_GENERATED_SCHEMA:${filename}`);
    }
    if (!existing.equals(bytes)) throw new Error(`STALE_GENERATED_SCHEMA:${filename}`);
  } else {
    await writeFile(path, bytes, { mode: 0o644 });
  }
}
