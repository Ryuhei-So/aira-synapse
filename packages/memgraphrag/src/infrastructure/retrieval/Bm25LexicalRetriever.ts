import type { Passage } from '../../domain/memory/passage.js';
import type { ILexicalRetriever } from '../../domain/retrieval/ppr.js';

interface IndexedPassage {
  readonly passageId: string;
  readonly documentId: string;
  readonly length: number;
  readonly termFrequencies: ReadonlyMap<string, number>;
}

interface CorpusIndex {
  readonly passages: Map<string, IndexedPassage>;
  readonly documentFrequency: Map<string, number>;
  readonly documentPassages: Map<string, Set<string>>;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function averageDocumentLength(index: CorpusIndex): number {
  if (index.passages.size === 0) {
    return 0;
  }
  let total = 0;
  for (const passage of index.passages.values()) {
    total += passage.length;
  }
  return total / index.passages.size;
}

function createCorpusIndex(): CorpusIndex {
  return {
    passages: new Map<string, IndexedPassage>(),
    documentFrequency: new Map<string, number>(),
    documentPassages: new Map<string, Set<string>>(),
  };
}

export class Bm25LexicalRetriever implements ILexicalRetriever {
  private readonly corpora = new Map<string, CorpusIndex>();

  public async indexPassages(corpusId: string, passages: readonly Passage[]): Promise<void> {
    const index = this.corpora.get(corpusId) ?? createCorpusIndex();

    for (const passage of passages) {
      const tokens = tokenize(passage.normalizedText || passage.text);
      const frequencies = new Map<string, number>();
      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }

      if (index.passages.has(passage.passageId)) {
        this.removePassage(index, passage.passageId);
      }

      index.passages.set(passage.passageId, {
        passageId: passage.passageId,
        documentId: passage.metadata.documentId,
        length: Math.max(tokens.length, 1),
        termFrequencies: frequencies,
      });

      for (const term of frequencies.keys()) {
        index.documentFrequency.set(term, (index.documentFrequency.get(term) ?? 0) + 1);
      }

      const passageIds = index.documentPassages.get(passage.metadata.documentId) ?? new Set<string>();
      passageIds.add(passage.passageId);
      index.documentPassages.set(passage.metadata.documentId, passageIds);
    }

    this.corpora.set(corpusId, index);
  }

  public async search(
    corpusId: string,
    query: string,
    topK: number,
  ): Promise<readonly { passageId: string; score: number }[]> {
    const index = this.corpora.get(corpusId);
    if (!index || index.passages.size === 0) {
      return [];
    }

    const queryTerms = tokenize(query);
    const avgLength = averageDocumentLength(index) || 1;
    const documentCount = index.passages.size;
    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const df = index.documentFrequency.get(term) ?? 0;
      if (df === 0) {
        continue;
      }
      const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
      for (const passage of index.passages.values()) {
        const tf = passage.termFrequencies.get(term) ?? 0;
        if (tf === 0) {
          continue;
        }
        const numerator = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (passage.length / avgLength));
        const score = idf * (numerator / denominator);
        scores.set(passage.passageId, (scores.get(passage.passageId) ?? 0) + score);
      }
    }

    return [...scores.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, Math.max(topK, 0))
      .map(([passageId, score]) => ({ passageId, score }));
  }

  public async deleteByDocument(corpusId: string, documentId: string): Promise<void> {
    const index = this.corpora.get(corpusId);
    if (!index) {
      return;
    }

    const passageIds = index.documentPassages.get(documentId);
    if (!passageIds) {
      return;
    }

    for (const passageId of passageIds) {
      this.removePassage(index, passageId);
    }
    index.documentPassages.delete(documentId);
  }

  private removePassage(index: CorpusIndex, passageId: string): void {
    const existing = index.passages.get(passageId);
    if (!existing) {
      return;
    }

    for (const term of existing.termFrequencies.keys()) {
      const next = (index.documentFrequency.get(term) ?? 0) - 1;
      if (next <= 0) {
        index.documentFrequency.delete(term);
      } else {
        index.documentFrequency.set(term, next);
      }
    }

    index.documentPassages.get(existing.documentId)?.delete(existing.passageId);
    index.passages.delete(passageId);
  }
}
