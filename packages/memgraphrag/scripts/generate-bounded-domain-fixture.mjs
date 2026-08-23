#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DOMAIN_CONTRACT_VERSION,
  validateDomainObject,
} from '../dist/domain/memory/domainContract.js';

const FIXTURE_VERSION = 'aira-synapse-bounded-domain-fixture@1';
const MANIFEST_VERSION = 'aira-synapse-bounded-domain-manifest@1';
const fixturePath = fileURLToPath(new URL('../tests/fixtures/bounded-domain-fixture.json', import.meta.url));
const manifestPath = fileURLToPath(new URL('../tests/fixtures/bounded-domain-fixture.manifest.json', import.meta.url));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}
function objectBase(corpusId = 'fixture-corpus') {
  return {
    corpusId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function makePassage() {
  return {
    ...objectBase(),
    passageId: 'fixture-passage-1',
    text: 'A bounded retrieval fixture passage.',
    normalizedText: 'a bounded retrieval fixture passage.',
    metadata: {
      documentId: 'fixture-document-1',
      title: 'Bounded retrieval fixture',
      sourceUrl: 'https://example.invalid/fixture-document-1',
      doi: '10.5555/fixture.1',
      sourceDb: 'fixture-db',
      sourceType: 'pdf',
      language: 'en',
      convertedAt: '2026-01-01T00:01:00.000Z',
      sectionPath: ['Results', 'Bounded retrieval'],
      chunkId: 'fixture-chunk-1',
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: 36,
    },
    factIds: ['fixture-fact-inactive', 'fixture-fact-tie'],
    entityMentions: ['Alpha', 'Beta'],
    qualityFlags: ['fixture'],
    qualityScore: 0.95,
  };
}

function makeFact(factId, state = 'inactive') {
  return {
    ...objectBase(),
    factId,
    schemaId: 'fixture-schema-1',
    headEntity: 'Alpha',
    headType: 'Entity',
    relation: 'relates-to',
    tailEntity: 'Beta',
    tailType: 'Entity',
    state,
    passageIds: ['fixture-passage-1'],
    sourceDocumentIds: ['fixture-document-1'],
    confidence: 0.75,
    temporalScope: '2026',
    granularityParentFactId: 'fixture-parent-fact',
  };
}

function makeSchema() {
  return {
    ...objectBase(),
    schemaId: 'fixture-schema-1',
    headType: 'Entity',
    relation: 'relates-to',
    tailType: 'Entity',
    canonicalKey: 'entity::relates-to::entity',
    aliases: [
      {
        label: 'relates to',
        language: 'en',
        source: 'manual',
        confidence: 1,
        isCanonical: true,
      },
      {
        label: '関係する',
        language: 'ja',
        source: 'dictionary',
        confidence: 0.8,
        isCanonical: false,
      },
    ],
    frequency: 3,
    state: 'stable',
    stabilizationThreshold: 2,
    factIds: ['fixture-fact-inactive', 'fixture-fact-tie'],
    sourceDocumentIds: ['fixture-document-1'],
    version: 1,
  };
}

function buildFixture() {
  const passage = makePassage();
  const inactiveFact = makeFact('fixture-fact-inactive');
  const tieFact = makeFact('fixture-fact-tie');
  const schema = makeSchema();

  for (const [kind, value] of [
    ['passage', passage],
    ['fact', inactiveFact],
    ['fact', tieFact],
    ['schema', schema],
  ]) {
    const result = validateDomainObject(kind, value);
    if (!result.valid) {
      throw new Error(`fixture ${kind} failed its contract: ${result.errors.join('; ')}`);
    }
  }

  return {
    fixtureVersion: FIXTURE_VERSION,
    contractVersion: DOMAIN_CONTRACT_VERSION,
    candidateHits: [
      {
        namespace: 'passage',
        id: 'passage:fixture-passage-1',
        score: -0.125,
        item: passage,
      },
      {
        namespace: 'fact',
        id: 'fact:fixture-fact-inactive',
        score: -0.25,
        item: inactiveFact,
      },
      {
        namespace: 'fact',
        id: 'fact:fixture-fact-tie',
        score: -0.25,
        item: tieFact,
      },
      {
        namespace: 'schema',
        id: 'schema:fixture-schema-1',
        score: 0.25,
        item: schema,
      },
    ],
    pprMaterialization: {
      rankedPassages: [
        {
          nodeId: 'passage:fixture-passage-1',
          score: 0.75,
          rank: 1,
          passage,
        },
      ],
      rankedFacts: [
        {
          nodeId: 'fact:fixture-fact-inactive',
          score: 0.5,
          rank: 1,
          fact: inactiveFact,
        },
        {
          nodeId: 'fact:fixture-fact-tie',
          score: 0.5,
          rank: 2,
          fact: tieFact,
        },
      ],
    },
  };
}

function encode(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function expectedArtifacts() {
  const fixtureText = encode(buildFixture());
  const fixtureSha256 = createHash('sha256').update(fixtureText).digest('hex');
  const manifestText = encode({
    manifestVersion: MANIFEST_VERSION,
    fixtureVersion: FIXTURE_VERSION,
    contractVersion: DOMAIN_CONTRACT_VERSION,
    fixtureFile: 'bounded-domain-fixture.json',
    fixtureSha256,
  });
  return { fixtureText, manifestText };
}

const check = process.argv.includes('--check');
const { fixtureText, manifestText } = expectedArtifacts();

if (check) {
  const [actualFixture, actualManifest] = await Promise.all([
    readFile(fixturePath, 'utf8'),
    readFile(manifestPath, 'utf8'),
  ]);
  if (actualFixture !== fixtureText || actualManifest !== manifestText) {
    throw new Error('bounded domain fixture drift detected; run the generator and review the diff');
  }
  console.log(`bounded domain fixture is current (${JSON.parse(manifestText).fixtureSha256})`);
} else {
  await mkdir(fileURLToPath(new URL('../tests/fixtures/', import.meta.url)), { recursive: true });
  await Promise.all([
    writeFile(fixturePath, fixtureText),
    writeFile(manifestPath, manifestText),
  ]);
  console.log(`wrote bounded domain fixture (${JSON.parse(manifestText).fixtureSha256})`);
}
