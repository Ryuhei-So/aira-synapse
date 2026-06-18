/**
 * Translate HotpotQA dataset from English to Japanese
 *
 * Usage:
 *   node scripts/translate-hotpotqa.mjs [--num N] [--concurrency C]
 *
 * Reads benchmark_500.json, translates questions/answers via GPT-5.4-mini,
 * outputs hotpotqa_ja_500.json. Results are cached per question ID.
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REPO_ROOT = resolve(process.cwd(), '../..');
const EN_FILE = resolve(REPO_ROOT, 'data/benchmark/hotpotqa/benchmark_500.json');
const JA_DIR = resolve(REPO_ROOT, 'data/benchmark/hotpotqa-ja');
const JA_FILE = resolve(JA_DIR, 'hotpotqa_ja_500.json');
const CACHE_FILE = resolve(JA_DIR, 'translation_cache.json');

const NUM_Q = parseInt(process.env.NUM_QUESTIONS || '0');
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10');
const MODEL = process.env.TRANSLATION_MODEL || 'gpt-5.4-mini';

// ─── API Key ───
function loadApiKey() {
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) return envKey;
  const keyFile = resolve(process.cwd(), 'config/openai_api_key');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf-8').trim();
  throw new Error('OPENAI_API_KEY not set and config/openai_api_key not found');
}

const API_KEY = loadApiKey();

// ─── Cache ───
function loadCache() {
  if (existsSync(CACHE_FILE)) {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  }
  return {};
}

function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ─── Translation ───
async function translateQuestion(item) {
  const supportingTitles = item.supporting_facts?.title || [];
  const prompt = `以下の英語のQAペアを日本語に翻訳してください。
固有名詞は日本語Wikipediaでの一般的な表記に従ってください。
人名はカタカナ表記、地名は一般的な日本語表記にしてください。

Question: ${item.question}
Answer: ${item.answer}
Supporting article titles: ${JSON.stringify(supportingTitles)}

以下のJSON形式で返してください（JSONのみ、他のテキストは不要）:
{
  "question_ja": "日本語の質問",
  "answer_ja": "日本語の回答",
  "supporting_titles_ja": ["日本語タイトル1", "日本語タイトル2"]
}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 500,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const content = data.choices[0].message.content;
  return JSON.parse(content);
}

// ─── Main ───
async function main() {
  const enData = JSON.parse(readFileSync(EN_FILE, 'utf-8'));
  const questions = NUM_Q > 0 ? enData.slice(0, NUM_Q) : enData;
  const cache = loadCache();

  console.log(`=== Translating ${questions.length} HotpotQA questions to Japanese ===`);
  console.log(`  Model: ${MODEL}, Concurrency: ${CONCURRENCY}`);
  console.log(`  Cached: ${Object.keys(cache).length} items`);

  let translated = 0;
  let cached = 0;
  const results = [];

  for (let i = 0; i < questions.length; i += CONCURRENCY) {
    const batch = questions.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (item) => {
      if (cache[item.id]) {
        cached++;
        return { ...item, ...cache[item.id] };
      }

      try {
        const translation = await translateQuestion(item);
        cache[item.id] = {
          question_ja: translation.question_ja,
          answer_ja: translation.answer_ja,
          supporting_titles_ja: translation.supporting_titles_ja || [],
          translation_model: MODEL,
        };
        translated++;
        return { ...item, ...cache[item.id] };
      } catch (err) {
        console.error(`  ✗ Failed to translate ${item.id}: ${err.message}`);
        return { ...item, question_ja: null, answer_ja: null, supporting_titles_ja: [], translation_model: MODEL };
      }
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

    // Save cache periodically
    if ((i + CONCURRENCY) % 50 === 0 || i + CONCURRENCY >= questions.length) {
      saveCache(cache);
    }

    const total = Math.min(i + CONCURRENCY, questions.length);
    console.log(`  [${total}/${questions.length}] Translated: ${translated}, Cached: ${cached}`);
  }

  // Save final output
  writeFileSync(JA_FILE, JSON.stringify(results, null, 2));
  saveCache(cache);

  const failedCount = results.filter(r => !r.question_ja).length;
  console.log(`\n=== Translation Complete ===`);
  console.log(`  Total: ${results.length}`);
  console.log(`  Translated: ${translated}`);
  console.log(`  Cached: ${cached}`);
  console.log(`  Failed: ${failedCount}`);
  console.log(`  Output: ${JA_FILE}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
