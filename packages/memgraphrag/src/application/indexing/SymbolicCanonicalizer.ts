import type { ISchemaCanonicalizer, CanonicalizationResult } from '../../domain/agent/index.js';
import type { SchemaAlias, SchemaCandidate } from '../../domain/memory/schema.js';

export interface SymbolicCanonicalizerOptions {
  readonly exactAliases?: Readonly<Record<string, string>>;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupeAliases(aliases: readonly SchemaAlias[]): readonly SchemaAlias[] {
  const seen = new Set<string>();
  const result: SchemaAlias[] = [];
  for (const alias of aliases) {
    const key = `${normalize(alias.label)}:${alias.language}:${alias.source}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(alias);
  }
  return result;
}

export class SymbolicCanonicalizer implements ISchemaCanonicalizer {
  public constructor(private readonly options: SymbolicCanonicalizerOptions = {}) {}

  public async canonicalize(candidate: SchemaCandidate): Promise<CanonicalizationResult> {
    const aliasMap = this.options.exactAliases ?? {};
    const canonicalHeadType = aliasMap[normalize(candidate.headType)] ?? normalize(candidate.headType);
    const canonicalRelation = aliasMap[normalize(candidate.relation)] ?? normalize(candidate.relation);
    const canonicalTailType = aliasMap[normalize(candidate.tailType)] ?? normalize(candidate.tailType);

    return {
      canonicalHeadType,
      canonicalRelation,
      canonicalTailType,
      aliases: dedupeAliases(candidate.aliases),
      confidence: candidate.confidence,
    };
  }
}
