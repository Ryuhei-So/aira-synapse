import { describe, it, expect } from 'vitest';
import { RegexExtractor } from '../../../../src/infrastructure/nlp/RegexExtractor.js';

describe('TASK-MG-026: RegexExtractor fallback', () => {
  const extractor = new RegexExtractor();

  describe('English extraction', () => {
    it('should extract title case entities', async () => {
      const result = await extractor.extract({
        text: 'Machine Learning and Natural Language Processing are important.',
        language: 'en',
      });
      const texts = result.entities.map((e) => e.text);
      expect(texts).toContain('Machine Learning');
      expect(texts).toContain('Natural Language Processing');
    });

    it('should extract acronyms', async () => {
      const result = await extractor.extract({
        text: 'The NLP model uses GPT and BERT for inference.',
        language: 'en',
      });
      const texts = result.entities.map((e) => e.text);
      expect(texts).toContain('NLP');
      expect(texts).toContain('GPT');
      expect(texts).toContain('BERT');
    });

    it('should extract hyphenated compounds', async () => {
      const result = await extractor.extract({
        text: 'A state-of-the-art graph-based retrieval system.',
        language: 'en',
      });
      const texts = result.entities.map((e) => e.text);
      expect(texts.some((t) => t.includes('state-of-the-art') || t.includes('graph-based'))).toBe(true);
    });

    it('should return noun phrases', async () => {
      const result = await extractor.extract({
        text: 'Knowledge Graph is useful for Information Retrieval tasks.',
        language: 'en',
      });
      expect(result.nounPhrases.length).toBeGreaterThan(0);
    });
  });

  describe('Japanese extraction', () => {
    it('should extract katakana terms', async () => {
      const result = await extractor.extract({
        text: 'ニューラルネットワークによるデータマイニング手法',
        language: 'ja',
      });
      const texts = result.entities.map((e) => e.text);
      expect(texts).toContain('ニューラルネットワーク');
      expect(texts).toContain('データマイニング');
    });

    it('should extract kanji compounds', async () => {
      const result = await extractor.extract({
        text: '自然言語処理と機械学習の研究',
        language: 'ja',
      });
      const texts = result.entities.map((e) => e.text);
      expect(texts.some((t) => t.includes('自然言語処理') || t.includes('機械学習'))).toBe(true);
    });
  });

  describe('mixed language', () => {
    it('should extract from both English and Japanese', async () => {
      const result = await extractor.extract({
        text: 'Deep Learningとニューラルネットワークの比較研究',
        language: 'mixed',
      });
      const texts = result.entities.map((e) => e.text);
      expect(texts).toContain('Deep Learning');
      expect(texts).toContain('ニューラルネットワーク');
    });
  });

  describe('deduplication', () => {
    it('should deduplicate entities', async () => {
      const result = await extractor.extract({
        text: 'NLP is NLP. Machine Learning and Machine Learning.',
        language: 'en',
      });
      const nlpCount = result.entities.filter((e) => e.text === 'NLP').length;
      expect(nlpCount).toBe(1);
    });
  });

  describe('healthCheck', () => {
    it('should always return healthy', async () => {
      const health = await extractor.healthCheck();
      expect(health.healthy).toBe(true);
    });
  });
});
