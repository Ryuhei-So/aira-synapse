import type { ISchemaCanonicalizer, CanonicalizationResult } from '../../domain/agent/index.js';
import {
  normalizeSchemaTerm,
  type SchemaAlias,
  type SchemaCandidate,
} from '../../domain/memory/schema.js';

export interface SymbolicCanonicalizerOptions {
  readonly exactAliases?: Readonly<Record<string, string>>;
}

function dedupeAliases(aliases: readonly SchemaAlias[]): readonly SchemaAlias[] {
  const seen = new Set<string>();
  const result: SchemaAlias[] = [];
  for (const alias of aliases) {
    const key = `${normalizeSchemaTerm(alias.label)}:${alias.language}:${alias.source}`;
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
    const normalizedHeadType = normalizeSchemaTerm(candidate.headType);
    const normalizedRelation = normalizeSchemaTerm(candidate.relation);
    const normalizedTailType = normalizeSchemaTerm(candidate.tailType);
    const canonicalHeadType = aliasMap[normalizedHeadType] ?? normalizedHeadType;
    const canonicalRelation = aliasMap[normalizedRelation] ?? normalizedRelation;
    const canonicalTailType = aliasMap[normalizedTailType] ?? normalizedTailType;

    return {
      canonicalHeadType,
      canonicalRelation,
      canonicalTailType,
      aliases: dedupeAliases(candidate.aliases),
      confidence: candidate.confidence,
    };
  }
}
