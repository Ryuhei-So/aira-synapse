import type { DocumentMetadata } from '../../domain/memory/passage.js';
import type { ExtractionChunk } from '../../domain/agent/index.js';
import type { LanguageCode } from '../../domain/memory/types.js';
import type { ISentenceChunker } from '../../domain/provider/llmProvider.js';
import { detectLanguage } from '../../domain/language/index.js';
import { JapaneseLanguageStrategy } from '../../domain/language/index.js';
import { EnglishLanguageStrategy } from '../../domain/language/index.js';

const jaStrategy = new JapaneseLanguageStrategy();
const enStrategy = new EnglishLanguageStrategy();

/** Estimate token count for a text based on language */
export function estimateTokens(text: string): number {
  const lang = detectLanguage(text);
  return lang === 'ja' ? jaStrategy.estimateTokens(text) : enStrategy.estimateTokens(text);
}

/** Max tokens per chunk — JA uses smaller chunks for denser extraction */
const MAX_TOKENS_JA = 500;
const MAX_TOKENS_EN = 800;

/**
 * Split text into paragraphs with overlap for fallback chunking.
 */
export function fallbackParagraphSplit(
  text: string,
  maxTokens: number,
  overlapSentences = 1,
): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (currentTokens + paraTokens > maxTokens && current.length > 0) {
      chunks.push(current.join('\n\n'));
      // Overlap: keep last paragraph
      const overlap = current.slice(-overlapSentences);
      current = [...overlap];
      currentTokens = overlap.reduce((sum, p) => sum + estimateTokens(p), 0);
    }
    current.push(para);
    currentTokens += paraTokens;
  }
  if (current.length > 0) {
    chunks.push(current.join('\n\n'));
  }
  return chunks;
}

/** Normalize chunk text using language-aware strategy */
function normalizeChunkText(text: string): string {
  const lang = detectLanguage(text);
  return lang === 'ja' ? jaStrategy.normalizeText(text) : text.toLowerCase();
}

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
      // sectionPath can contain non-string entries for malformed headings
      sectionPath.some((section) => typeof section === 'string'
        && section.toLowerCase().includes('reference'))
      || /(^|\n)\[[0-9]+\]/.test(normalized),
  };
}

export function chunkMarkdownDocument(request: ChunkDocumentRequest): readonly MarkdownChunk[] {
  if (request.markdown.trim().length === 0) {
    return [];
  }

  const lang = detectLanguage(request.markdown);
  const maxTokens = lang === 'ja' ? MAX_TOKENS_JA : MAX_TOKENS_EN;

  const matches = [...request.markdown.matchAll(/^(#{1,6})\s+(.*)$/gm)];
  if (matches.length === 0) {
    const text = request.markdown.trim();
    const tokens = estimateTokens(text);
    // Fallback: split by paragraphs if too large
    if (tokens > maxTokens) {
      const parts = fallbackParagraphSplit(text, maxTokens);
      return parts.map((part, idx) => ({
        chunkId: `${request.documentId}:${idx}`,
        text: part,
        normalizedText: normalizeChunkText(part),
        sectionPath: [],
        chunkIndex: idx,
        offsetStart: 0,
        offsetEnd: part.length,
        features: detectFeatures(part, []),
      }));
    }
    return [{
      chunkId: `${request.documentId}:0`,
      text,
      normalizedText: normalizeChunkText(text),
      sectionPath: [],
      chunkIndex: 0,
      offsetStart: 0,
      offsetEnd: text.length,
      features: detectFeatures(text, []),
    }];
  }

  const rawChunks: MarkdownChunk[] = [];
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

    rawChunks.push({
      chunkId: `${request.documentId}:${rawChunks.length}`,
      text,
      normalizedText: normalizeChunkText(text),
      sectionPath: [...sectionStack],
      chunkIndex: rawChunks.length,
      offsetStart: start,
      offsetEnd: nextStart,
      features: detectFeatures(text, sectionStack),
    });
  }

  // Split oversized chunks for JA (EN keeps heading-based chunks)
  if (lang === 'ja') {
    const result: MarkdownChunk[] = [];
    for (const chunk of rawChunks) {
      const tokens = estimateTokens(chunk.text);
      if (tokens > maxTokens) {
        const parts = fallbackParagraphSplit(chunk.text, maxTokens);
        for (const part of parts) {
          result.push({
            chunkId: `${request.documentId}:${result.length}`,
            text: part,
            normalizedText: normalizeChunkText(part),
            sectionPath: chunk.sectionPath,
            chunkIndex: result.length,
            offsetStart: chunk.offsetStart,
            offsetEnd: chunk.offsetEnd,
            features: detectFeatures(part, chunk.sectionPath),
          });
        }
      } else {
        result.push({
          ...chunk,
          chunkId: `${request.documentId}:${result.length}`,
          chunkIndex: result.length,
        });
      }
    }
    return result;
  }

  return rawChunks;
}

/**
 * GINZA-based Japanese chunking using Python sidecar.
 * Splits text into sentence-aware chunks that respect linguistic boundaries.
 * Falls back to paragraph-based splitting if sidecar is unavailable.
 */
export async function chunkMarkdownDocumentWithGinza(
  request: ChunkDocumentRequest,
  sidecar: ISentenceChunker,
): Promise<readonly MarkdownChunk[]> {
  if (request.markdown.trim().length === 0) {
    return [];
  }

  const lang = detectLanguage(request.markdown);

  // Only use GINZA for Japanese; delegate English to the sync version
  if (lang !== 'ja') {
    return chunkMarkdownDocument(request);
  }

  const maxTokens = MAX_TOKENS_JA;
  const matches = [...request.markdown.matchAll(/^(#{1,6})\s+(.*)$/gm)];

  // Extract sections (heading-based)
  const sections: Array<{ heading: string; level: number; text: string; start: number; end: number }> = [];
  if (matches.length === 0) {
    sections.push({ heading: '', level: 0, text: request.markdown.trim(), start: 0, end: request.markdown.length });
  } else {
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const level = match[1]!.length;
      const heading = match[2]?.trim() ?? '';
      const start = match.index!;
      const end = matches[i + 1]?.index ?? request.markdown.length;
      const text = request.markdown.slice(start, end).trim();
      if (text.length > 0) {
        sections.push({ heading, level, text, start, end });
      }
    }
  }

  const result: MarkdownChunk[] = [];
  const sectionStack: string[] = [];

  for (const section of sections) {
    if (section.level > 0) {
      sectionStack.splice(section.level - 1);
      sectionStack[section.level - 1] = section.heading;
    }

    const sectionTokens = jaStrategy.estimateTokens(section.text);

    if (sectionTokens <= maxTokens) {
      // Section fits in one chunk
      result.push({
        chunkId: `${request.documentId}:${result.length}`,
        text: section.text,
        normalizedText: normalizeChunkText(section.text),
        sectionPath: [...sectionStack],
        chunkIndex: result.length,
        offsetStart: section.start,
        offsetEnd: section.end,
        features: detectFeatures(section.text, sectionStack),
      });
    } else {
      // Use GINZA sentence splitting for oversized sections
      try {
        const chunks = await sidecar.chunkSentences(section.text, maxTokens);
        for (const chunk of chunks) {
          result.push({
            chunkId: `${request.documentId}:${result.length}`,
            text: chunk.text,
            normalizedText: normalizeChunkText(chunk.text),
            sectionPath: [...sectionStack],
            chunkIndex: result.length,
            offsetStart: section.start,
            offsetEnd: section.end,
            features: detectFeatures(chunk.text, sectionStack),
          });
        }
      } catch {
        // Fallback to paragraph-based splitting if sidecar fails
        const parts = fallbackParagraphSplit(section.text, maxTokens);
        for (const part of parts) {
          result.push({
            chunkId: `${request.documentId}:${result.length}`,
            text: part,
            normalizedText: normalizeChunkText(part),
            sectionPath: [...sectionStack],
            chunkIndex: result.length,
            offsetStart: section.start,
            offsetEnd: section.end,
            features: detectFeatures(part, sectionStack),
          });
        }
      }
    }
  }

  return result;
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
