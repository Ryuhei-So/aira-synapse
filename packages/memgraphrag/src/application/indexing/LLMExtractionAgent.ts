/**
 * LLM-based Extraction Agent.
 * Uses an ILLMProvider to extract entities, schemas, and facts from text chunks.
 */
import type {
  CompositeExtractionRecord,
  ExtractionChunk,
  IExtractionAgent,
} from '../../domain/agent/index.js';
import type { FactCandidate } from '../../domain/memory/fact.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { SchemaCandidate } from '../../domain/memory/schema.js';
import { computeCanonicalKey } from '../../domain/memory/schema.js';
import type { ILLMProvider } from '../../domain/provider/index.js';

const EXTRACTION_PROMPT = `You are a knowledge graph extraction agent. Given a text chunk from an academic paper, extract structured knowledge.

Return a JSON object with:
- "entities": array of { "name": string, "type": string } — named entities found in the text
- "relations": array of { "head": string, "headType": string, "relation": string, "tail": string, "tailType": string, "confidence": number } — factual relations between entities

Rules:
1. Entity types should be general categories: "Method", "Dataset", "Metric", "Task", "Model", "Organization", "Person", "Concept", "Technology", "Algorithm"
2. Relations should be verb phrases: "uses", "outperforms", "is_a", "part_of", "evaluates_on", "proposes", "extends", "compares_to", "achieves", "based_on"
3. Only extract explicitly stated facts, not inferences
4. Confidence should be 0.5-1.0 based on how clearly the relation is stated
5. Return valid JSON only, no markdown fences

Text:
`;

interface LLMExtractionResult {
  readonly entities: readonly { name: string; type: string }[];
  readonly relations: readonly {
    head: string;
    headType: string;
    relation: string;
    tail: string;
    tailType: string;
    confidence: number;
  }[];
}

function parseLLMResponse(text: string): LLMExtractionResult {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as LLMExtractionResult;
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
    };
  } catch {
    return { entities: [], relations: [] };
  }
}

export class LLMExtractionAgent implements IExtractionAgent {
  public constructor(private readonly llm: ILLMProvider) {}

  public async extract(chunk: ExtractionChunk): Promise<CompositeExtractionRecord> {
    const response = await this.llm.generate({
      prompt: EXTRACTION_PROMPT + chunk.normalizedText.slice(0, 3000),
      maxTokens: 1500,
      temperature: 0.1,
    });

    const result = parseLLMResponse(response.text);

    const rawEntities = result.entities.map((e) => e.name);

    const candidateSchemas: SchemaCandidate[] = result.relations.map((r) => ({
      headType: r.headType,
      relation: r.relation,
      tailType: r.tailType,
      canonicalKey: computeCanonicalKey(r.headType, r.relation, r.tailType),
      aliases: [{
        label: `${r.headType} ${r.relation} ${r.tailType}`,
        language: chunk.language || 'unknown',
        source: 'llm' as const,
        confidence: r.confidence,
        isCanonical: true,
      }],
      confidence: r.confidence,
    }));

    const candidateFacts: FactCandidate[] = result.relations.map((r) => ({
      headEntity: r.head,
      headType: r.headType,
      relation: r.relation,
      tailEntity: r.tail,
      tailType: r.tailType,
      supportingSpanIds: [chunk.chunkId],
      confidence: r.confidence,
    }));

    const now = new Date().toISOString();
    const sourcePassage: Passage = {
      passageId: `passage:${chunk.chunkId}`,
      corpusId: chunk.corpusId,
      text: chunk.text,
      normalizedText: chunk.normalizedText,
      metadata: chunk.metadata,
      factIds: [],
      entityMentions: rawEntities,
      qualityFlags: ['llm-extracted'],
      qualityScore: 0.8,
      createdAt: now,
      updatedAt: now,
    };

    return {
      chunk,
      candidateSchemas,
      candidateFacts,
      sourcePassage,
      rawEntities,
    };
  }
}
