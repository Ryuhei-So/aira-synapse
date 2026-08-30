import { describe, expect, it } from 'vitest';
import retrievalFixture from '../../../fixtures/bounded-retrieval/bounded-retrieval-fixture.json';
import retrievalManifest from '../../../fixtures/bounded-retrieval/bounded-retrieval-fixture.manifest.json';
import domainFixture from '../../../fixtures/bounded-domain-fixture.json';
import { canonicalJson } from '../../../../src/domain/contract/structural.js';
import {
  BOUNDED_RETRIEVAL_OPERATION_NAMES,
  BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
  type BoundedSemanticDeclaration,
  type BoundedRetrievalOperationName,
} from '../../../../src/domain/retrieval/boundedContract.js';
import { projectBoundedRetrievalExchanges } from '../../../../src/domain/retrieval/boundedFixtureProjection.js';
import {
  BOUNDED_RETRIEVAL_FIXTURE_VERSION,
  BOUNDED_RETRIEVAL_PUBLICATION_BUDGET_BYTES,
  BOUNDED_RETRIEVAL_WITNESS_VERSION,
  applyBoundedReplacementPatch,
  assertBoundedRetrievalPublicationBudget,
  deriveBoundedAssertionCoverage,
  generateBoundedAssertionWitnesses,
  validateBoundedReplacementPatch,
  validateBoundedRetrievalFixture,
  type BoundedRetrievalFixture,
} from '../../../../src/domain/retrieval/boundedWitnesses.js';

const fixture = retrievalFixture as unknown as BoundedRetrievalFixture;

function withWitnesses(witnesses: unknown): unknown {
  return { ...fixture, witnesses };
}

function withPatch(index: number, patch: unknown): unknown {
  const witnesses = fixture.witnesses.map((witness, witnessIndex) =>
    witnessIndex === index ? { ...witness, patch } : witness);
  return withWitnesses(witnesses);
}

describe('bounded retrieval assertion witnesses', () => {
  it('generates exactly the pinned witness identities and manifest-derived coverage', () => {
    const generated = generateBoundedAssertionWitnesses(fixture.exchanges);
    expect(generated).toEqual(fixture.witnesses);
    expect(retrievalManifest.witnessVersion).toBe(BOUNDED_RETRIEVAL_WITNESS_VERSION);
    expect(retrievalManifest.fixtureVersion).toBe(BOUNDED_RETRIEVAL_FIXTURE_VERSION);
    expect(retrievalManifest.witnessCoverage).toEqual(deriveBoundedAssertionCoverage().byOperation);
  });

  it('rejects missing, duplicate, extra, reordered, unknown, and out-of-range identities', () => {
    const first = fixture.witnesses[0]!;
    const missing = validateBoundedRetrievalFixture(withWitnesses(fixture.witnesses.slice(1)));
    expect(missing.valid).toBe(false);
    expect(missing.errors.join(' ')).toMatch(/missing identity/);

    const duplicate = validateBoundedRetrievalFixture(withWitnesses([...fixture.witnesses, first]));
    expect(duplicate.valid).toBe(false);
    expect(duplicate.errors.join(' ')).toMatch(/duplicate identity/);

    const extra = validateBoundedRetrievalFixture(withWitnesses([
      ...fixture.witnesses,
      { ...first, operation: 'future_operation@1' },
    ]));
    expect(extra.valid).toBe(false);
    expect(extra.errors.join(' ')).toMatch(/operation is unknown/);

    const reorderedWitnesses = [...fixture.witnesses];
    [reorderedWitnesses[0], reorderedWitnesses[1]] = [reorderedWitnesses[1]!, reorderedWitnesses[0]!];
    const reordered = validateBoundedRetrievalFixture(withWitnesses(reorderedWitnesses));
    expect(reordered.valid).toBe(false);
    expect(reordered.errors.join(' ')).toMatch(/canonical.*order/);

    const unknownPartition = validateBoundedRetrievalFixture(withWitnesses([
      { ...first, partition: 'result' },
      ...fixture.witnesses.slice(1),
    ]));
    expect(unknownPartition.valid).toBe(false);
    expect(unknownPartition.errors.join(' ')).toMatch(/partition is unknown/);

    const outOfRange = validateBoundedRetrievalFixture(withWitnesses([
      { ...first, assertionIndex: Number.MAX_SAFE_INTEGER },
      ...fixture.witnesses.slice(1),
    ]));
    expect(outOfRange.valid).toBe(false);
    expect(outOfRange.errors.join(' ')).toMatch(/assertionIndex is out of range/);

    expect(BOUNDED_RETRIEVAL_OPERATION_NAMES).toHaveLength(3);
  });

  it('rejects unknown versions, patch keys, roots, pointers, and schema-only replacements', () => {
    expect(validateBoundedRetrievalFixture({ ...fixture, fixtureVersion: 'future-fixture@1' }).valid).toBe(false);
    expect(validateBoundedRetrievalFixture({ ...fixture, witnessVersion: 'future-witness@1' }).valid).toBe(false);

    const first = fixture.witnesses[0]!;
    expect(validateBoundedRetrievalFixture(withPatch(0, { ...first.patch, future: true })).valid).toBe(false);
    expect(validateBoundedRetrievalFixture(withPatch(0, {
      root: first.patch.root,
      value: first.patch.value,
    })).valid).toBe(false);
    expect(validateBoundedRetrievalFixture(withPatch(0, {
      root: 'result',
      path: first.patch.path,
      value: first.patch.value,
    })).valid).toBe(false);
    expect(validateBoundedRetrievalFixture(withPatch(0, {
      root: 'request',
      path: '/does/not/exist',
      value: '',
    })).valid).toBe(false);
    expect(validateBoundedRetrievalFixture(withPatch(0, {
      root: 'request',
      path: first.patch.path,
      value: 'fixture-corpus',
    })).errors.join(' ')).toMatch(/does not fail at/);

    const invalidPatch = validateBoundedReplacementPatch({
      root: 'request',
      path: '/bad~pointer',
      value: Number.NaN,
    });
    expect(invalidPatch.valid).toBe(false);
    expect(invalidPatch.errors.join(' ')).toMatch(/canonical JSON Pointer|finite number/);
  });

  it('fails mechanically when a canonical assertion is added without a producer recipe', () => {
    const operation = BOUNDED_RETRIEVAL_OPERATION_NAMES[0];
    const declaration = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation];
    const extendedPrograms = {
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [operation]: {
        ...declaration,
        refinement: {
          ...declaration.refinement,
          requestAssertions: [
            ...declaration.refinement.requestAssertions,
            declaration.refinement.requestAssertions[0]!,
          ],
        },
      },
    } as unknown as Readonly<Record<BoundedRetrievalOperationName, BoundedSemanticDeclaration>>;

    expect(() => generateBoundedAssertionWitnesses(fixture.exchanges, extendedPrograms)).toThrow(
      /request witness recipe count/,
    );
  });

  it('changes canonical witness coverage when a formerly nested clause is removed', () => {
    const operation = BOUNDED_RETRIEVAL_OPERATION_NAMES[0];
    const declaration = BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS[operation];
    const nestedClauseIndex = declaration.refinement.exchangeAssertions.findIndex(
      (assertion) => assertion.op === 'for_each',
    );
    expect(nestedClauseIndex).toBeGreaterThanOrEqual(0);

    const reducedPrograms = {
      ...BOUNDED_RETRIEVAL_STRUCTURAL_DECLARATIONS,
      [operation]: {
        ...declaration,
        refinement: {
          ...declaration.refinement,
          exchangeAssertions: declaration.refinement.exchangeAssertions.filter(
            (_assertion, index) => index !== nestedClauseIndex,
          ),
        },
      },
    } as unknown as Readonly<Record<BoundedRetrievalOperationName, BoundedSemanticDeclaration>>;
    const fullCoverage = deriveBoundedAssertionCoverage();
    const reducedCoverage = deriveBoundedAssertionCoverage(reducedPrograms);
    expect(reducedCoverage.byOperation[operation].exchange).toBe(
      fullCoverage.byOperation[operation].exchange - 1,
    );
    expect(() => generateBoundedAssertionWitnesses(fixture.exchanges, reducedPrograms)).toThrow(
      /exchange witness recipe count/,
    );
  });

  it('keeps the canonical fixture within the producer budget and rejects an oversized publication', () => {
    const fixtureText = canonicalJson(fixture);
    expect(Buffer.byteLength(fixtureText, 'utf8')).toBeLessThanOrEqual(
      BOUNDED_RETRIEVAL_PUBLICATION_BUDGET_BYTES,
    );
    expect(() => assertBoundedRetrievalPublicationBudget(
      'x'.repeat(BOUNDED_RETRIEVAL_PUBLICATION_BUDGET_BYTES + 1),
    )).toThrow(/producer publication budget/);
  });

  it('causally projects mutated passage, fact, and schema values from the domain fixture', () => {
    const mutated = structuredClone(domainFixture);
    const sourcePassage = mutated.candidateHits.find((hit) => hit.namespace === 'passage')!;
    const sourceFact = mutated.candidateHits.find((hit) => hit.namespace === 'fact')!;
    const sourceSchema = mutated.candidateHits.find((hit) => hit.namespace === 'schema')!;
    sourcePassage.item.text = 'sentinel-passage-text';
    sourceFact.item.updatedAt = '2099-01-02T03:04:05.000Z';
    sourceSchema.item.canonicalKey = 'sentinel::schema::key';

    const projected = projectBoundedRetrievalExchanges(mutated);
    const candidate = projected[BOUNDED_RETRIEVAL_OPERATION_NAMES[0]] as {
      readonly result: { readonly slots: readonly { readonly hits: readonly { readonly item: Record<string, unknown> }[] }[] };
    };
    const [passageSlot, factSlot, schemaSlot] = candidate.result.slots;
    expect(passageSlot!.hits[0]!.item.text).toBe('sentinel-passage-text');
    expect(factSlot!.hits[0]!.item.updatedAt).toBe('2099-01-02T03:04:05.000Z');
    expect(schemaSlot!.hits[0]!.item.canonicalKey).toBe('sentinel::schema::key');
  });

  it('fails closed when the pinned domain fixture lacks required projection seeds', () => {
    expect(() => projectBoundedRetrievalExchanges({ candidateHits: [] })).toThrow(
      /must provide passage, two fact, and schema seeds/,
    );
  });

  it('keeps patch application copy-on-write', () => {
    const witness = fixture.witnesses[0]!;
    const exchange = fixture.exchanges[witness.operation];
    const before = JSON.stringify(exchange);
    const mutated = applyBoundedReplacementPatch(exchange, witness.patch);
    expect(JSON.stringify(exchange)).toBe(before);
    expect(mutated).not.toBe(exchange);
  });
});
