import { describe, expect, it } from 'vitest';
import { assessNeo4jE2E, enforceNeo4jE2E, type Neo4jE2EConfig } from '../../e2e/neo4j-e2e-gate.js';

const VALID_CONFIG: Neo4jE2EConfig = {
  uri: 'bolt://localhost:7687',
  username: 'neo4j',
  password: 'test-password',
};

describe('Neo4j E2E prerequisite gate', () => {
  it.each([
    { name: 'opt-in absent', optIn: undefined, apiKey: 'sk-test', expected: { state: 'skip', reason: 'opt_in_not_requested' } },
    { name: 'opt-in on and credential absent', optIn: '1', apiKey: undefined, expected: { state: 'fail', reason: 'OPENAI_API_KEY or api_key_file is required' } },
    { name: 'opt-in on and credential present', optIn: '1', apiKey: 'sk-test', expected: { state: 'run' } },
  ])('$name', ({ optIn, apiKey, expected }) => {
    expect(assessNeo4jE2E(optIn, apiKey, VALID_CONFIG)).toEqual(expected);
  });

  it.each([
    { name: 'missing config', config: {} },
    { name: 'blank password', config: { ...VALID_CONFIG, password: '  ' } },
  ])('fails synchronously for $name when opt-in is enabled', ({ config }) => {
    expect(assessNeo4jE2E('1', 'sk-test', config)).toEqual({
      state: 'fail',
      reason: 'Neo4j uri, username, and password are required',
    });
  });

  it('fails for a blank API key when opt-in is enabled', () => {
    expect(assessNeo4jE2E('1', '  ', VALID_CONFIG)).toEqual({
      state: 'fail',
      reason: 'OPENAI_API_KEY or api_key_file is required',
    });
  });

  it('fails for an invalid opt-in value instead of silently skipping', () => {
    expect(assessNeo4jE2E('0', 'sk-test', VALID_CONFIG)).toEqual({
      state: 'fail',
      reason: 'RUN_NEO4J_E2E must equal 1 when set',
    });
  });

  it('throws synchronously for an opted-in missing credential', () => {
    expect(() => enforceNeo4jE2E('1', undefined, VALID_CONFIG)).toThrow(
      'Neo4j E2E prerequisites failed: OPENAI_API_KEY or api_key_file is required',
    );
  });
});
