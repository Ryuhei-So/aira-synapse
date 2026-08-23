import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fixture from '../../../fixtures/bounded-domain-fixture.json';
import manifest from '../../../fixtures/bounded-domain-fixture.manifest.json';
import {
  DOMAIN_CONTRACT_VERSION,
  isDomainObject,
  validateDomainObject,
} from '../../../../src/domain/memory/domainContract.js';

type FixtureObject = Record<string, unknown>;

function fixtureItem(namespace: string): FixtureObject {
  const hit = fixture.candidateHits.find((candidate) => candidate.namespace === namespace);
  if (!hit) throw new Error(`missing ${namespace} fixture`);
  return hit.item as FixtureObject;
}

describe('bounded domain structural contract', () => {
  it('accepts complete generated Passage, Fact, and Schema shapes', () => {
    expect(fixture.contractVersion).toBe(DOMAIN_CONTRACT_VERSION);
    const fixtureSha256 = createHash('sha256')
      .update(readFileSync(new URL('../../../fixtures/bounded-domain-fixture.json', import.meta.url)))
      .digest('hex');
    expect(manifest.fixtureSha256).toBe(fixtureSha256);
    for (const namespace of ['passage', 'fact', 'schema'] as const) {
      const result = validateDomainObject(namespace, fixtureItem(namespace));
      expect(result, `${namespace}: ${result.errors.join('; ')}`).toEqual({ valid: true, errors: [] });
      expect(isDomainObject(namespace, fixtureItem(namespace))).toBe(true);
    }
  });

  it('accepts omitted optional fields but rejects an explicit undefined JSON boundary', () => {
    const passage = fixtureItem('passage');
    const metadata = { ...(passage.metadata as FixtureObject) };
    delete metadata.doi;
    delete metadata.sourceDb;
    delete metadata.sourceType;
    delete metadata.convertedAt;
    const withoutPassageOptionalFields = { ...passage, metadata };
    delete withoutPassageOptionalFields.qualityScore;
    expect(validateDomainObject('passage', withoutPassageOptionalFields).valid).toBe(true);

    const fact = fixtureItem('fact');
    delete fact.temporalScope;
    delete fact.granularityParentFactId;
    expect(validateDomainObject('fact', fact).valid).toBe(true);
    expect(validateDomainObject('fact', { ...fact, temporalScope: undefined }).valid).toBe(false);
  });

  it('rejects missing required fields at every domain boundary', () => {
    const passage = fixtureItem('passage');
    const missingPassageId = { ...passage };
    delete missingPassageId.passageId;
    expect(validateDomainObject('passage', missingPassageId)).toMatchObject({ valid: false });

    const fact = fixtureItem('fact');
    const missingFactState = { ...fact };
    delete missingFactState.state;
    expect(validateDomainObject('fact', missingFactState)).toMatchObject({ valid: false });

    const schema = fixtureItem('schema');
    const missingAliases = { ...schema };
    delete missingAliases.aliases;
    expect(validateDomainObject('schema', missingAliases)).toMatchObject({ valid: false });
  });

  it('rejects wrong nested types and unknown top-level or nested fields', () => {
    const passage = fixtureItem('passage');
    expect(validateDomainObject('passage', {
      ...passage,
      metadata: { ...(passage.metadata as FixtureObject), sectionPath: 'Results' },
    }).valid).toBe(false);
    expect(validateDomainObject('passage', {
      ...passage,
      unknownTopLevel: true,
    }).valid).toBe(false);
    expect(validateDomainObject('passage', {
      ...passage,
      metadata: { ...(passage.metadata as FixtureObject), unknownNested: true },
    }).valid).toBe(false);

    const schema = fixtureItem('schema');
    const aliases = [...schema.aliases as FixtureObject[]];
    aliases[0] = { ...aliases[0], confidence: 'high' };
    expect(validateDomainObject('schema', { ...schema, aliases }).valid).toBe(false);
    aliases[0] = { ...aliases[0], unknownAliasField: true };
    expect(validateDomainObject('schema', { ...schema, aliases }).valid).toBe(false);
  });
});
