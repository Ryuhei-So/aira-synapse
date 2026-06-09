/**
 * Infrastructure Layer — API key resolver.
 * Resolves the OpenAI API key from: file (config) → environment variable → empty.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolves the API key using the following priority:
 *   1. File specified in `providers.api_key_file` config
 *   2. `OPENAI_API_KEY` environment variable
 *   3. Empty string (triggers local-only / degraded mode)
 */
export function resolveApiKey(
  apiKeyFile: string | undefined,
  env: Record<string, string | undefined> = process.env,
  basePath: string = process.cwd(),
): string {
  // Priority 1: File
  if (apiKeyFile) {
    const filePath = resolve(basePath, apiKeyFile);
    if (existsSync(filePath)) {
      const key = readFileSync(filePath, 'utf-8').trim();
      if (key.length > 0) {
        return key;
      }
    }
  }

  // Priority 2: Environment variable
  const envKey = env['OPENAI_API_KEY'];
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }

  // Priority 3: Empty (degraded mode)
  return '';
}
