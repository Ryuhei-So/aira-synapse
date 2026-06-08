import type { DocumentMetadata } from '../../domain/memory/passage.js';
import type { ExtractionChunk } from '../../domain/agent/index.js';
import type { LanguageCode } from '../../domain/memory/types.js';

export interface MarkdownChunkFeatures {
  readonly hasCodeBlock: boolean;
  readonly hasTable: boolean;
  readonly hasReferences: boolean;
}

export interface MarkdownChunk {
  readonly chunkId: string;
  readonly text: string;
  readonly normalizedText: string;
  readonly sectionPath: readonly string[];
  readonly chunkIndex: number;
  readonly offsetStart: number;
  readonly offsetEnd: number;
  readonly features: MarkdownChunkFeatures;
}

export interface ChunkDocumentRequest {
  readonly corpusId: string;
  readonly documentId: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly markdown: string;
  readonly doi?: string;
  readonly sourceDb?: string;
  readonly sourceType?: 'pdf' | 'html' | 'docx' | 'pptx' | 'md';
  readonly language: LanguageCode;
}

function detectFeatures(text: string, sectionPath: readonly string[]): MarkdownChunkFeatures {
  const normalized = text.toLowerCase();
  return {
    hasCodeBlock: /```/.test(text),
    hasTable: /\|.+\|/.test(text),
    hasReferences:
      sectionPath.some((section) => section.toLowerCase().includes('reference'))
      || /(^|\n)\[[0-9]+\]/.test(normalized),
  };
}

export function chunkMarkdownDocument(request: ChunkDocumentRequest): readonly MarkdownChunk[] {
  if (request.markdown.trim().length === 0) {
    return [];
  }

  const matches = [...request.markdown.matchAll(/^(#{1,6})\s+(.*)$/gm)];
  if (matches.length === 0) {
    const text = request.markdown.trim();
    return [{
      chunkId: `${request.documentId}:0`,
      text,
      normalizedText: text.toLowerCase(),
      sectionPath: [],
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: text.length,
      features: detectFeatures(text, []),
    }];
  }

  const chunks: MarkdownChunk[] = [];
  const sectionStack: string[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) {
      continue;
    }
    const headingLevel = match[1]?.length ?? 1;
    const heading = match[2]?.trim() ?? 'Section';
    const start = match.index;
    const nextStart = matches[index + 1]?.index ?? request.markdown.length;
    const text = request.markdown.slice(start, nextStart).trim();

    sectionStack.splice(headingLevel - 1);
    sectionStack[headingLevel - 1] = heading;

    if (text.length === 0) {
      continue;
    }

    chunks.push({
      chunkId: `${request.documentId}:${chunks.length}`,
      text,
      normalizedText: text.toLowerCase(),
      sectionPath: [...sectionStack],
      chunkIndex: chunks.length,
      offsetStart: start,
      offsetEnd: nextStart,
      features: detectFeatures(text, sectionStack),
    });
  }

  return chunks;
}

export function toExtractionChunk(
  corpusId: string,
  chunk: MarkdownChunk,
  request: ChunkDocumentRequest,
): ExtractionChunk {
  const metadata: DocumentMetadata = {
    documentId: request.documentId,
    title: request.title,
    sourceUrl: request.sourceUrl,
    doi: request.doi,
    sourceDb: request.sourceDb,
    sourceType: request.sourceType,
    language: request.language,
    sectionPath: chunk.sectionPath,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    offsetStart: chunk.offsetStart,
    offsetEnd: chunk.offsetEnd,
  };

  return {
    corpusId,
    documentId: request.documentId,
    chunkId: chunk.chunkId,
    text: chunk.text,
    normalizedText: chunk.normalizedText,
    language: request.language,
    metadata,
  };
}
