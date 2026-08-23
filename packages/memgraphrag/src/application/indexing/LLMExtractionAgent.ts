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
import { detectLanguage } from '../../domain/language/index.js';

const EXTRACTION_PROMPT_EN = `You are a knowledge graph extraction agent. Given a text chunk from an academic paper, extract structured knowledge.

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

const EXTRACTION_PROMPT_JA = `あなたは知識グラフ抽出エージェントです。与えられたテキストから、できるだけ多くの構造化知識を抽出してください。

以下のJSON形式で返してください:
- "entities": 配列 { "name": string, "type": string } — テキスト中の固有名詞・概念
- "relations": 配列 { "head": string, "headType": string, "relation": string, "tail": string, "tailType": string, "confidence": number } — エンティティ間の事実関係

ルール:
1. エンティティ型: "人物", "組織", "場所", "作品", "イベント", "概念", "日時", "数値", "方法", "技術"
2. 関係は動詞句: "は", "に所属する", "で生まれた", "を制作した", "に位置する", "で活動した", "と共演した", "を受賞した", "に分類される", "の別名である", "と比較される", "を設立した", "に参加した", "で公開された", "から派生した"
3. テキストに明示された事実のみ抽出（推測は不可）
4. **最低15個以上のrelationsを抽出すること**。テキストのあらゆる事実を漏れなく捉えてください
5. 人名、地名、作品名、組織名は原文のまま抽出（翻訳しない）
6. 同じエンティティの別表記（略称、英語名等）も別のrelationとして抽出: "の別名である"
7. 数値情報（年号、人数、金額等）もエンティティとして抽出
8. confidence は 0.5-1.0（明確さに応じて）
9. 有効なJSONのみ返す（マークダウンフェンス不要）

テキスト:
`;

function getExtractionPrompt(text: string): string {
  return detectLanguage(text) === 'ja' ? EXTRACTION_PROMPT_JA : EXTRACTION_PROMPT_EN;
}

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseLLMResponse(text: string): LLMExtractionResult {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { entities: [], relations: [] };
    }
    const value = parsed as Record<string, unknown>;
    // LLMs (especially small local models) sometimes emit items with missing
    // fields; drop them here so downstream canonicalization never sees them.
    const entities = (Array.isArray(value.entities) ? value.entities : []).filter(
      (entity): entity is { name: string; type: string } => typeof entity === 'object'
        && entity !== null
        && isNonEmptyString((entity as Record<string, unknown>).name)
        && isNonEmptyString((entity as Record<string, unknown>).type),
    );
    const relations = (Array.isArray(value.relations) ? value.relations : []).filter(
      (relation): relation is LLMExtractionResult['relations'][number] => typeof relation === 'object'
        && relation !== null
        && isNonEmptyString((relation as Record<string, unknown>).head)
        && isNonEmptyString((relation as Record<string, unknown>).headType)
        && isNonEmptyString((relation as Record<string, unknown>).relation)
        && isNonEmptyString((relation as Record<string, unknown>).tail)
        && isNonEmptyString((relation as Record<string, unknown>).tailType)
        && isConfidence((relation as Record<string, unknown>).confidence),
    );
    return { entities, relations };
  } catch {
    return { entities: [], relations: [] };
  }
}

export class LLMExtractionAgent implements IExtractionAgent {
  public constructor(private readonly llm: ILLMProvider) {}

  public async extract(chunk: ExtractionChunk): Promise<CompositeExtractionRecord> {
    const prompt = getExtractionPrompt(chunk.normalizedText);
    const response = await this.llm.generate({
      prompt: prompt + chunk.normalizedText.slice(0, 3000),
      maxTokens: 2000,
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
