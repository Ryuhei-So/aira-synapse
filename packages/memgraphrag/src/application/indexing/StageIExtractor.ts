import type { CompositeExtractionRecord, ExtractionChunk, IExtractionAgent } from '../../domain/agent/index.js';
import type { Passage } from '../../domain/memory/passage.js';
import type { LanguageCode } from '../../domain/memory/types.js';
import type { INLPExtractor } from '../../domain/provider/index.js';
import { preprocessMarkdown as defaultPreprocessMarkdown } from './MarkdownPreprocessor.js';
import {
  chunkMarkdownDocument,
  toExtractionChunk,
  type ChunkDocumentRequest,
  type MarkdownChunk,
} from './MarkdownChunker.js';

export interface IndexDocumentInput {
  readonly documentId: string;
  readonly markdown: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly doi?: string;
  readonly sourceDb?: string;
  readonly sourceType?: 'pdf' | 'html' | 'docx' | 'pptx' | 'md';
  readonly language?: LanguageCode;
}

export interface MarkdownQualityAssessment {
  readonly score: number;
  readonly flags: readonly string[];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function buildPassage(chunk: ExtractionChunk, flags: readonly string[], entities: readonly string[]): Passage {
  const now = new Date().toISOString();
  return {
    passageId: `passage:${chunk.chunkId}`,
    corpusId: chunk.corpusId,
    text: chunk.text,
    normalizedText: chunk.normalizedText,
    metadata: chunk.metadata,
    factIds: [],
    entityMentions: entities,
    qualityFlags: flags,
    qualityScore: flags.includes('well-formed') ? 1 : 0.75,
    createdAt: now,
    updatedAt: now,
  };
}

export class StageIExtractor {
  public constructor(
    private readonly nlpExtractor: INLPExtractor,
    private readonly extractionAgent: IExtractionAgent,
  ) {}

  public preprocessMarkdown(markdown: string): string {
    return defaultPreprocessMarkdown(markdown);
  }

  public validateMarkdownQuality(markdown: string): MarkdownQualityAssessment {
    const flags: string[] = [];
    const codeBlocks = (markdown.match(/```/g) ?? []).length / 2;
    const tableRows = (markdown.match(/^\|.*\|$/gm) ?? []).length;

    if (codeBlocks > 0) {
      flags.push('code-heavy');
    }
    if (tableRows > 0) {
      flags.push('table-heavy');
    }
    if (/^\[[0-9]+\]/m.test(markdown) || /^#+\s+references/im.test(markdown)) {
      flags.push('references-present');
    }
    if (flags.length === 0) {
      flags.push('well-formed');
    }

    return {
      score: Math.max(0.2, 1 - (flags.length - (flags.includes('well-formed') ? 1 : 0)) * 0.2),
      flags,
    };
  }

  public chunkMarkdown(corpusId: string, input: IndexDocumentInput): readonly MarkdownChunk[] {
    const markdown = this.preprocessMarkdown(input.markdown);
    const request: ChunkDocumentRequest = {
      corpusId,
      documentId: input.documentId,
      title: input.title,
      sourceUrl: input.sourceUrl,
      doi: input.doi,
      sourceDb: input.sourceDb,
      sourceType: input.sourceType,
      language: input.language ?? 'unknown',
      markdown,
    };
    return chunkMarkdownDocument(request);
  }

  public chunkDocument(corpusId: string, input: IndexDocumentInput): readonly ExtractionChunk[] {
    const markdown = this.preprocessMarkdown(input.markdown);
    const request: ChunkDocumentRequest = {
      corpusId,
      documentId: input.documentId,
      title: input.title,
      sourceUrl: input.sourceUrl,
      doi: input.doi,
      sourceDb: input.sourceDb,
      sourceType: input.sourceType,
      language: input.language ?? 'unknown',
      markdown,
    };

    return chunkMarkdownDocument(request).map((chunk) =>
      toExtractionChunk(corpusId, chunk, request),
    );
  }

  public async extractChunks(
    corpusId: string,
    input: IndexDocumentInput,
    concurrency: number = Number(process.env.MEMGRAPHRAG_EXTRACT_CONCURRENCY ?? 5),
  ): Promise<readonly CompositeExtractionRecord[]> {
    const chunks = this.chunkDocument(corpusId, input);
    const quality = this.validateMarkdownQuality(this.preprocessMarkdown(input.markdown));

    const processChunk = async (chunk: ExtractionChunk): Promise<CompositeExtractionRecord> => {
      const [nlp, extracted] = await Promise.all([
        this.nlpExtractor.extract({ text: chunk.normalizedText, language: chunk.language }),
        this.extractionAgent.extract(chunk),
      ]);

      const rawEntities = unique([
        ...extracted.rawEntities,
        ...nlp.entities.map((entity) => entity.text),
        ...nlp.nounPhrases,
      ]);

      const qualityFlags = unique([
        ...extracted.sourcePassage.qualityFlags,
        ...quality.flags,
      ]);

      return {
        chunk,
        candidateSchemas: extracted.candidateSchemas,
        candidateFacts: extracted.candidateFacts,
        rawEntities,
        sourcePassage: {
          ...(extracted.sourcePassage ?? buildPassage(chunk, qualityFlags, rawEntities)),
          entityMentions: rawEntities,
          qualityFlags,
        },
      };
    };

    // Process chunks with bounded concurrency
    const records: CompositeExtractionRecord[] = [];
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(processChunk));
      records.push(...batchResults);
    }

    return records;
  }
}
