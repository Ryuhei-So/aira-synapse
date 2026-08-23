import { describe, expect, it } from 'vitest';
import { shouldRunNeo4jE2E, type Neo4jE2EConfig } from '../../e2e/neo4j-e2e-gate.js';

const VALID_CONFIG: Neo4jE2EConfig = {
  uri: 'bolt://localhost:7687',
  username: 'neo4j',
  password: 'test-password',
};

describe('Neo4j E2E prerequisite gate', () => {
  it.each([
    { name: 'opt-in off and credential absent', optIn: undefined, apiKey: undefined, expected: false },
    { name: 'opt-in off and credential present', optIn: '0', apiKey: 'sk-test', expected: false },
    { name: 'opt-in on and credential absent', optIn: '1', apiKey: undefined, expected: false },
    { name: 'opt-in on and credential present', optIn: '1', apiKey: 'sk-test', expected: true },
  ])('$name', ({ optIn, apiKey, expected }) => {
    expect(shouldRunNeo4jE2E(optIn, apiKey, VALID_CONFIG)).toBe(expected);
  });

  it('rejects missing or blank Neo4j connection configuration', () => {
    expect(shouldRunNeo4jE2E('1', 'sk-test', {})).toBe(false);
    expect(shouldRunNeo4jE2E('1', 'sk-test', { ...VALID_CONFIG, password: '  ' })).toBe(false);
  });

  it('does not treat a blank API key as a credential', () => {
    expect(shouldRunNeo4jE2E('1', '  ', VALID_CONFIG)).toBe(false);
  });
});
