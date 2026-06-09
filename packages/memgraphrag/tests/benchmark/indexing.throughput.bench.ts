import { describe, expect, it } from 'vitest';
import { preprocessMarkdown } from '../../src/application/indexing/MarkdownPreprocessor.js';
import { chunkMarkdownDocument } from '../../src/application/indexing/MarkdownChunker.js';

describe.skip('TASK-MG-050 benchmark: indexing throughput', () => {
  it('processes 100 markdown documents within a lightweight budget', () => {
    const docs = Array.from({ length: 100 }, (_, index) => `# Document ${index}\n\nGraph retrieval content `.repeat(20));
    const start = Date.now();
    const chunkCount = docs
      .map((markdown, index) => chunkMarkdownDocument({
        corpusId: 'corpus-1',
        documentId: `doc-${index}`,
        title: `Doc ${index}`,
        sourceUrl: `https://example.com/${index}`,
        markdown: preprocessMarkdown(markdown),
        language: 'en',
      }).length)
      .reduce((total, count) => total + count, 0);
    const elapsed = Date.now() - start;

    expect(chunkCount).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2_000);
  });
});
