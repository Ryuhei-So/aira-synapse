/**
 * Fetch Japanese Wikipedia articles for HotpotQA benchmark
 *
 * Usage:
 *   node scripts/fetch-ja-wikipedia.mjs [--num N] [--concurrency C]
 *
 * Strategy (2-stage fallback):
 *   1. English Wikipedia langlinks API → Japanese article
 *   2. Japanese Wikipedia search API → best match
 *   3. Not found → ja_coverage: false
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const REPO_ROOT = resolve(process.cwd(), '../..');
const JA_DIR = resolve(REPO_ROOT, 'data/benchmark/hotpotqa-ja');
const JA_FILE = resolve(JA_DIR, 'hotpotqa_ja_500.json');
const CORPUS_DIR = resolve(JA_DIR, 'corpus');
const COVERAGE_FILE = resolve(JA_DIR, 'coverage_report.json');
const FETCH_CACHE_FILE = resolve(JA_DIR, 'wiki_fetch_cache.json');

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5');
const RATE_LIMIT_MS = 200; // Wikipedia API courtesy delay

if (!existsSync(CORPUS_DIR)) mkdirSync(CORPUS_DIR, { recursive: true });

// ─── Cache ───
function loadFetchCache() {
  if (existsSync(FETCH_CACHE_FILE)) {
    return JSON.parse(readFileSync(FETCH_CACHE_FILE, 'utf-8'));
  }
  return {};
}

function saveFetchCache(cache) {
  writeFileSync(FETCH_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ─── Wikipedia API helpers ───
async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'aira-synapse/0.4.0 (https://github.com/nahisaho/aira-synapse)' },
      });
      if (resp.ok) return await resp.json();
      if (resp.status === 429) {
        await sleep(2000 * (i + 1));
        continue;
      }
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(1000);
    }
  }
}

/**
 * Stage 1: Get Japanese article title via English Wikipedia langlinks
 */
async function getJaTitleViaLanglinks(enTitle) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(enTitle)}&prop=langlinks&lllang=ja&format=json`;
  const data = await fetchWithRetry(url);
  const pages = data?.query?.pages;
  if (!pages) return null;
  for (const page of Object.values(pages)) {
    if (page.langlinks && page.langlinks.length > 0) {
      return page.langlinks[0]['*'];
    }
  }
  return null;
}

/**
 * Stage 2: Search Japanese Wikipedia with translated title
 */
async function searchJaWikipedia(jaTitle) {
  const url = `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(jaTitle)}&srlimit=1&format=json`;
  const data = await fetchWithRetry(url);
  const results = data?.query?.search;
  if (results && results.length > 0) {
    return results[0].title;
  }
  return null;
}

/**
 * Get article content as plain text from Japanese Wikipedia
 */
async function getJaArticleContent(jaTitle) {
  const url = `https://ja.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(jaTitle)}&prop=extracts&explaintext=1&format=json`;
  const data = await fetchWithRetry(url);
  const pages = data?.query?.pages;
  if (!pages) return null;
  for (const page of Object.values(pages)) {
    if (page.extract) return { title: page.title, content: page.extract };
  }
  return null;
}

function sanitizeFilename(title) {
  return title.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, '_').substring(0, 200);
}

/**
 * Fetch a single article with 2-stage fallback
 */
async function fetchArticle(enTitle, jaTitle, cache) {
  const cacheKey = enTitle;
  if (cache[cacheKey]) return cache[cacheKey];

  // Stage 1: langlinks
  let resolvedJaTitle = await getJaTitleViaLanglinks(enTitle);
  let method = 'langlinks';

  // Stage 2: search with translated title
  if (!resolvedJaTitle && jaTitle) {
    await sleep(RATE_LIMIT_MS);
    resolvedJaTitle = await searchJaWikipedia(jaTitle);
    method = 'search';
  }

  if (!resolvedJaTitle) {
    cache[cacheKey] = { title_en: enTitle, title_ja: null, method: 'not_found', fetched: false };
    return cache[cacheKey];
  }

  await sleep(RATE_LIMIT_MS);
  const article = await getJaArticleContent(resolvedJaTitle);
  if (!article) {
    cache[cacheKey] = { title_en: enTitle, title_ja: resolvedJaTitle, method, fetched: false };
    return cache[cacheKey];
  }

  // Save as markdown
  const filename = sanitizeFilename(article.title) + '.md';
  const mdContent = `---
title_en: "${enTitle}"
title_ja: "${article.title}"
source: "ja.wikipedia.org"
fetched_at: "${new Date().toISOString()}"
---

# ${article.title}

${article.content}
`;
  writeFileSync(resolve(CORPUS_DIR, filename), mdContent);

  cache[cacheKey] = {
    title_en: enTitle,
    title_ja: article.title,
    method,
    fetched: true,
    filename,
    content_length: article.content.length,
  };
  return cache[cacheKey];
}

// ─── Main ───
async function main() {
  if (!existsSync(JA_FILE)) {
    console.error(`Error: ${JA_FILE} not found. Run translate-hotpotqa.mjs first.`);
    process.exit(1);
  }

  const jaData = JSON.parse(readFileSync(JA_FILE, 'utf-8'));
  const cache = loadFetchCache();

  // Collect unique article titles to fetch
  const titleMap = new Map(); // enTitle → jaTitle
  for (const item of jaData) {
    const enTitles = item.supporting_facts?.title || item.context_titles || [];
    const jaTitles = item.supporting_titles_ja || [];
    for (let i = 0; i < enTitles.length; i++) {
      const enTitle = typeof enTitles[i] === 'string' ? enTitles[i] : enTitles[i];
      if (!titleMap.has(enTitle)) {
        titleMap.set(enTitle, jaTitles[i] || null);
      }
    }
  }

  const titles = [...titleMap.entries()];
  console.log(`=== Fetching ${titles.length} unique Wikipedia articles ===`);
  console.log(`  Cached: ${Object.keys(cache).length} items`);
  console.log(`  Concurrency: ${CONCURRENCY}`);

  let fetched = 0, cached = 0, notFound = 0;

  for (let i = 0; i < titles.length; i += CONCURRENCY) {
    const batch = titles.slice(i, i + CONCURRENCY);
    const promises = batch.map(async ([enTitle, jaTitle]) => {
      if (cache[enTitle]?.fetched !== undefined) {
        cached++;
        return;
      }
      try {
        const result = await fetchArticle(enTitle, jaTitle, cache);
        if (result.fetched) fetched++;
        else notFound++;
      } catch (err) {
        console.error(`  ✗ Failed: ${enTitle}: ${err.message}`);
        notFound++;
      }
      await sleep(RATE_LIMIT_MS);
    });
    await Promise.all(promises);

    if ((i + CONCURRENCY) % 50 === 0 || i + CONCURRENCY >= titles.length) {
      saveFetchCache(cache);
      const total = Math.min(i + CONCURRENCY, titles.length);
      console.log(`  [${total}/${titles.length}] Fetched: ${fetched}, Cached: ${cached}, NotFound: ${notFound}`);
    }
  }

  saveFetchCache(cache);

  // Update ja_coverage in dataset
  const updatedData = jaData.map(item => {
    const enTitles = item.supporting_facts?.title || [];
    const allFound = enTitles.every(t => cache[t]?.fetched === true);
    return { ...item, ja_coverage: allFound };
  });
  writeFileSync(JA_FILE, JSON.stringify(updatedData, null, 2));

  // Coverage report
  const coveredCount = updatedData.filter(q => q.ja_coverage).length;
  const report = {
    total_questions: updatedData.length,
    covered: coveredCount,
    not_covered: updatedData.length - coveredCount,
    coverage_rate: (coveredCount / updatedData.length * 100).toFixed(1) + '%',
    total_articles: titles.length,
    articles_fetched: Object.values(cache).filter(c => c.fetched).length,
    articles_not_found: Object.values(cache).filter(c => !c.fetched).length,
    by_method: {
      langlinks: Object.values(cache).filter(c => c.method === 'langlinks' && c.fetched).length,
      search: Object.values(cache).filter(c => c.method === 'search' && c.fetched).length,
      not_found: Object.values(cache).filter(c => c.method === 'not_found').length,
    },
    generated_at: new Date().toISOString(),
  };
  writeFileSync(COVERAGE_FILE, JSON.stringify(report, null, 2));

  console.log(`\n=== Fetch Complete ===`);
  console.log(`  Articles: ${report.articles_fetched}/${titles.length} (${report.by_method.langlinks} langlinks, ${report.by_method.search} search)`);
  console.log(`  Coverage: ${report.coverage_rate} (${coveredCount}/${updatedData.length} questions)`);
  console.log(`  Report: ${COVERAGE_FILE}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
