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
4. "confidence" is REQUIRED on every relation and must be a plain number between 0 and 1 (use 0.5-1.0 based on how clearly the relation is stated). A relation without a numeric confidence is discarded.
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
8. confidence は**全relationに必須**。0〜1の数値のみ（明確さに応じて0.5-1.0）。数値のconfidenceが無いrelationは破棄される
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

interface ParsedLLMResponse extends LLMExtractionResult {
  /** Why each unusable relation was rejected, for a diagnosable warning. */
  readonly dropReasons: readonly string[];
  /** Finite confidences outside the documented 0-1 range, kept but reported. */
  readonly outOfRangeConfidences: readonly number[];
  readonly parseFailed: boolean;
}

/**
 * A relation is usable exactly when it satisfies the storage domain contract:
 * the five identity strings, plus a `confidence` that is a finite number (what
 * Fact and SchemaAlias declare). The bound stops at the contract on purpose —
 * a stricter range check here would silently discard a whole corpus if a model
 * ever drifted to a 0-100 scale, and this layer is not the place to invent a
 * policy the storage boundary does not have.
 *
 * `confidence` is never defaulted: it is provenance, folded across duplicate
 * evidence with Math.max, so inventing a value would fabricate an evidence
 * strength the model never asserted and let it win over real ones, with
 * nothing recording that it was invented.
 */
function relationDropReason(r: LLMExtractionResult['relations'][number] | undefined): string | null {
  for (const field of ['head', 'headType', 'relation', 'tail', 'tailType'] as const) {
    if (typeof r?.[field] !== 'string') return `${field}:not-a-string`;
  }
  if (typeof r?.confidence !== 'number') return `confidence:${r?.confidence === undefined ? 'missing' : typeof r?.confidence}`;
  if (!Number.isFinite(r.confidence)) return 'confidence:not-finite';
  return null;
}

function parseLLMResponse(text: string): ParsedLLMResponse {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as LLMExtractionResult;
    // LLMs (especially small local models) sometimes emit items with missing
    // fields; drop them here so downstream canonicalization never sees them.
    const entities = (Array.isArray(parsed.entities) ? parsed.entities : []).filter(
      (e) => typeof e?.name === 'string' && typeof e?.type === 'string',
    );
    const relations: LLMExtractionResult['relations'][number][] = [];
    const dropReasons: string[] = [];
    const outOfRangeConfidences: number[] = [];
    for (const relation of Array.isArray(parsed.relations) ? parsed.relations : []) {
      const reason = relationDropReason(relation);
      if (reason !== null) {
        dropReasons.push(reason);
        continue;
      }
      // Kept (the contract accepts any finite number) but surfaced: a value
      // outside the prompted 0-1 range means the model changed scale, which
      // would otherwise silently distort every Math.max confidence fold.
      if (relation.confidence < 0 || relation.confidence > 1) {
        outOfRangeConfidences.push(relation.confidence);
      }
      relations.push(relation);
    }
    return { entities, relations, dropReasons, outOfRangeConfidences, parseFailed: false };
  } catch {
    return {
      entities: [], relations: [], dropReasons: [], outOfRangeConfidences: [], parseFailed: true,
    };
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
    // Silence here is what made the production incident take a night to
    // diagnose: a malformed response simply produced fewer relations, and the
    // defect only surfaced later as a storage contract error on a whole
    // document. Report every way a chunk can quietly yield less than it should.
    if (result.parseFailed) {
      console.warn(`[extraction] ${chunk.chunkId}: response was not parseable JSON; extracted nothing`);
    }
    if (result.dropReasons.length > 0) {
      const byReason = result.dropReasons.reduce<Record<string, number>>(
        (counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }),
        {},
      );
      const detail = Object.entries(byReason).map(([reason, count]) => `${reason}=${count}`).join(' ');
      const total = result.dropReasons.length;
      const message = `[extraction] ${chunk.chunkId}: dropped ${total} relation(s) violating the domain contract (${detail})`;
      // Losing every relation is a different failure from losing a few: the
      // document can still be banked as indexed while carrying no knowledge.
      console.warn(result.relations.length === 0 ? `${message} — chunk yielded no usable relations` : message);
    }
    if (result.outOfRangeConfidences.length > 0) {
      console.warn(
        `[extraction] ${chunk.chunkId}: ${result.outOfRangeConfidences.length} relation(s) carry a confidence outside 0-1 `
        + `(e.g. ${result.outOfRangeConfidences[0]}); kept, but the model may have changed scale`,
      );
    }

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
