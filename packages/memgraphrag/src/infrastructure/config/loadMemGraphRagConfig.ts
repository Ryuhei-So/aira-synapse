/**
 * YAML config loader for MemGraphRAG.
 * DES-MG-050: loadMemGraphRagConfig(path) → MemGraphRagConfig.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { MemGraphRagConfig } from './memGraphRagConfigSchema.js';
import { validateMemGraphRagConfig } from './memGraphRagConfigSchema.js';

/** Converts snake_case YAML keys to camelCase TS config */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

function transformKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(transformKeys);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[snakeToCamel(key)] = transformKeys(value);
  }
  return result;
}

/**
 * Loads and validates a MemGraphRAG config from a YAML file.
 *
 * @param path - Path to the YAML config file
 * @returns Validated MemGraphRagConfig
 * @throws Error if the file cannot be read or config is invalid
 */
export function loadMemGraphRagConfig(path: string): MemGraphRagConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw) as unknown;
  const transformed = transformKeys(parsed);

  const result = validateMemGraphRagConfig(transformed);
  if (!result.valid) {
    const messages = result.errors
      .map((e) => `  ${e.path || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid MemGraphRAG config:\n${messages}`);
  }

  return transformed as MemGraphRagConfig;
}
