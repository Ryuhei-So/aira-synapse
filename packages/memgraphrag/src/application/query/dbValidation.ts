/**
 * Application Layer — DB spec validation for federation.
 * DES-FED-005: Validates database specifications before federated query.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { FederatedDbConfig } from './federationTypes.js';
import { isValidDbId } from './federationTypes.js';

export interface DbSpecValidationError {
  readonly dbId: string;
  readonly reason: string;
}

/**
 * Parse a CLI --db spec string into FederatedDbConfig.
 * Format: "alias=path.agdb" or "path.agdb"
 */
export function parseDbSpec(spec: string): FederatedDbConfig {
  const eqIdx = spec.indexOf('=');
  if (eqIdx > 0) {
    return {
      dbId: spec.slice(0, eqIdx),
      dbPath: spec.slice(eqIdx + 1),
    };
  }
  return {
    dbId: basename(spec, '.agdb'),
    dbPath: spec,
  };
}

/**
 * Validate a list of FederatedDbConfig entries.
 * Returns an array of validation errors (empty = valid).
 */
export function validateDbSpecs(
  configs: readonly FederatedDbConfig[],
  checkPath = true,
): readonly DbSpecValidationError[] {
  const errors: DbSpecValidationError[] = [];
  const seenIds = new Set<string>();

  for (const config of configs) {
    // dbId format
    if (!isValidDbId(config.dbId)) {
      errors.push({ dbId: config.dbId, reason: `Invalid dbId "${config.dbId}": must match [a-zA-Z0-9_-]` });
    }

    // dbId uniqueness
    if (seenIds.has(config.dbId)) {
      errors.push({ dbId: config.dbId, reason: `Duplicate dbId "${config.dbId}"` });
    }
    seenIds.add(config.dbId);

    // aira-graphdb backend only (.agdb extension)
    if (!config.dbPath.endsWith('.agdb')) {
      errors.push({ dbId: config.dbId, reason: `Path "${config.dbPath}" must be an .agdb file (aira-graphdb only)` });
    }

    // Path existence
    if (checkPath && !existsSync(config.dbPath)) {
      errors.push({ dbId: config.dbId, reason: `Path "${config.dbPath}" does not exist` });
    }
  }

  return errors;
}
