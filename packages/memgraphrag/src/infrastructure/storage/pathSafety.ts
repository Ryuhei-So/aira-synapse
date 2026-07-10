/**
 * Infrastructure Layer — path confinement guard.
 *
 * Defense-in-depth against path traversal: resolve a child path under a base
 * directory and assert the result stays inside that base. Callers pass
 * caller-controlled segments (e.g. corpusId) that are validated at the MCP
 * boundary; this guard is the last line so any bypass (CLI, direct API use)
 * still cannot escape the storage root.
 */
import { resolve, sep } from 'node:path';

export function resolveWithin(baseDir: string, ...segments: string[]): string {
  const base = resolve(baseDir);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(
      `Path escapes storage root: ${segments.join('/')} resolves outside ${base}`,
    );
  }
  return target;
}
