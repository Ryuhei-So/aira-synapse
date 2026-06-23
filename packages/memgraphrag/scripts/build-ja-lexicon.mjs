/**
 * Build Japanese dictionary + thesaurus from aira-graphdb JA corpus entities.
 * 
 * 1. Dictionary: Extract all unique entities → term_dictionary table
 * 2. Thesaurus: Detect synonym pairs (katakana variants, EN↔JA mappings)
 * 
 * Usage: node scripts/build-ja-lexicon.mjs
 */
import { resolve } from 'node:path';
import { AiraGraphDbNativeClient, AiraGraphDbMemoryStore, openDatabase, SQLiteLexiconStore } from '../dist/infrastructure/index.js';
import { createHash } from 'node:crypto';

const PKG_DATA_DIR = resolve(process.cwd(), 'data/benchmark/hotpotqa-ja');
const ROOT_DATA_DIR = resolve(process.cwd(), '../../data/benchmark/hotpotqa-ja');
const CORPUS_ID = '4484a03a-210a-4154-ac2f-c98d648f358a';

// --- Katakana normalization (same as benchmark) ---
const KATAKANA_VARIANTS = [
  [/ヴァ/g, 'バ'], [/ヴィ/g, 'ビ'], [/ヴェ/g, 'ベ'], [/ヴォ/g, 'ボ'], [/ヴ/g, 'ブ'],
  [/ティ/g, 'チ'], [/ディ/g, 'ジ'], [/デュ/g, 'ジュ'],
  [/ファ/g, 'ハ'], [/フィ/g, 'ヒ'], [/フェ/g, 'ヘ'], [/フォ/g, 'ホ'],
  [/ウィ/g, 'ウイ'], [/ウェ/g, 'ウエ'], [/ウォ/g, 'ウオ'],
  [/ッ/g, ''], [/ー/g, ''],
];

function normalizeKatakana(s) {
  let r = s;
  for (const [pat, rep] of KATAKANA_VARIANTS) r = r.replace(pat, rep);
  return r;
}

function isJapanese(s) {
  return /[\u3040-\u9FFF]/.test(s);
}

function isKatakana(s) {
  return /^[\u30A0-\u30FFー・\s]+$/.test(s);
}

function isLatin(s) {
  return /^[a-zA-Z0-9\s\-_.,']+$/.test(s);
}

function termId(prefix, term) {
  return `${prefix}:${createHash('sha1').update(term).digest('hex').slice(0, 12)}`;
}

const now = new Date().toISOString();

async function main() {
  // 1. Load entities from agdb
  const agdbPath = resolve(PKG_DATA_DIR, 'hotpotqa-ja.agdb');
  const client = new AiraGraphDbNativeClient(agdbPath);
  await client.request('ping');
  console.log(`[build-ja-lexicon] Connected to ${agdbPath}`);

  const memStore = new AiraGraphDbMemoryStore(client);
  const snap = await memStore.load(CORPUS_ID);
  console.log(`[build-ja-lexicon] Facts: ${snap.facts.length}, Passages: ${snap.passages.length}`);

  // Count entity frequencies
  const entityFreq = new Map();
  for (const f of snap.facts) {
    entityFreq.set(f.headEntity, (entityFreq.get(f.headEntity) || 0) + 1);
    entityFreq.set(f.tailEntity, (entityFreq.get(f.tailEntity) || 0) + 1);
  }
  console.log(`[build-ja-lexicon] Unique entities: ${entityFreq.size}`);

  // Also extract from relations (schema-like terms)
  const relationFreq = new Map();
  for (const f of snap.facts) {
    relationFreq.set(f.relation, (relationFreq.get(f.relation) || 0) + 1);
  }

  // 2. Open SQLite
  const sqlitePath = resolve(ROOT_DATA_DIR, 'hotpotqa-ja.sqlite');
  const db = openDatabase(sqlitePath);
  const store = new SQLiteLexiconStore(db, CORPUS_ID);

  // 3. Build dictionary entries
  const dictEntries = [];
  for (const [entity, freq] of entityFreq) {
    if (entity.length < 2) continue;
    // Skip overly generic sentence-like entities
    if (entity.length > 50) continue;

    const isJa = isJapanese(entity);
    const domain = isJa ? 'ja-entity' : 'en-entity';
    const confidence = Math.min(1.0, 0.4 + (freq / 10) * 0.6);

    // Build aliases: katakana-normalized form
    const aliases = [];
    if (isKatakana(entity)) {
      const normalized = normalizeKatakana(entity);
      if (normalized !== entity && normalized.length >= 2) {
        aliases.push(normalized);
      }
    }

    dictEntries.push({
      termId: termId('ja-dict', entity),
      term: entity,
      canonicalForm: entity.toLowerCase(),
      domainCategory: domain,
      aliases,
      frequency: freq,
      confidence,
      source: 'extracted',
      version: 'ja-v1',
      createdAt: now,
      updatedAt: now,
    });
  }

  await store.upsertEntries(dictEntries);
  console.log(`[build-ja-lexicon] Dictionary: ${dictEntries.length} entries written`);

  // 4. Build thesaurus relations

  const thesaurusRelations = [];

  // 4a. Katakana variant synonyms
  const katakanaEntities = [...entityFreq.keys()].filter(e => isKatakana(e) && e.length >= 3);
  const kataGroups = new Map(); // normalized → [original forms]
  for (const e of katakanaEntities) {
    const norm = normalizeKatakana(e);
    if (norm !== e) {
      const group = kataGroups.get(norm) || [];
      group.push(e);
      kataGroups.set(norm, group);
    }
  }

  // Find entities that share the same normalized katakana form
  for (const [norm, variants] of kataGroups) {
    // Also check if the normalized form itself is an entity
    const allForms = entityFreq.has(norm) ? [norm, ...variants] : variants;
    if (allForms.length < 2) continue;

    for (let i = 0; i < allForms.length; i++) {
      for (let j = i + 1; j < allForms.length; j++) {
        thesaurusRelations.push({
          relationId: termId('thes-kata', `${allForms[i]}:${allForms[j]}`),
          sourceTerm: allForms[i],
          targetTerm: allForms[j],
          relationType: 'synonym',
          language: 'ja',
          weight: 0.9,
          bidirectional: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
  console.log(`[build-ja-lexicon] Katakana synonym pairs: ${thesaurusRelations.length}`);

  // 4b. English abbreviation ↔ full form (from facts with same head/tail)
  // Look for patterns like "FSH" appearing near "卵胞刺激ホルモン"
  const enEntities = [...entityFreq.keys()].filter(e => isLatin(e) && e.length >= 2 && e.length <= 20);
  const jaEntities = [...entityFreq.keys()].filter(e => isJapanese(e) && e.length >= 2 && e.length <= 30);

  // Build co-occurrence: EN and JA entities that appear in same fact
  const cooccurrence = new Map(); // "en|ja" → count
  for (const f of snap.facts) {
    const h = f.headEntity;
    const t = f.tailEntity;
    if (isLatin(h) && isJapanese(t)) {
      const key = `${h}|${t}`;
      cooccurrence.set(key, (cooccurrence.get(key) || 0) + 1);
    }
    if (isJapanese(h) && isLatin(t)) {
      const key = `${t}|${h}`;
      cooccurrence.set(key, (cooccurrence.get(key) || 0) + 1);
    }
  }

  // Also check facts where relation contains "の略称", "の別名", "は〜である" patterns
  const aliasPatterns = /別名|略称|正式名称|英語名|日本語名|とも呼ばれ|とも称され|の略/;
  let aliasRelCount = 0;
  for (const f of snap.facts) {
    if (aliasPatterns.test(f.relation)) {
      thesaurusRelations.push({
        relationId: termId('thes-alias', `${f.headEntity}:${f.tailEntity}`),
        sourceTerm: f.headEntity,
        targetTerm: f.tailEntity,
        relationType: 'synonym',
        language: 'ja',
        weight: 0.95,
        bidirectional: true,
        createdAt: now,
        updatedAt: now,
      });
      aliasRelCount++;
    }
  }
  console.log(`[build-ja-lexicon] Alias-pattern synonym pairs: ${aliasRelCount}`);

  // 4c. Co-occurring EN↔JA pairs as "related"
  let cooccurRelCount = 0;
  for (const [key, count] of cooccurrence) {
    if (count >= 2) {
      const [en, ja] = key.split('|');
      thesaurusRelations.push({
        relationId: termId('thes-cooc', key),
        sourceTerm: en,
        targetTerm: ja,
        relationType: 'related',
        language: 'ja',
        weight: Math.min(1.0, 0.5 + count * 0.1),
        bidirectional: true,
        createdAt: now,
        updatedAt: now,
      });
      cooccurRelCount++;
    }
  }
  console.log(`[build-ja-lexicon] EN↔JA co-occurrence related pairs: ${cooccurRelCount}`);

  // Write thesaurus
  if (thesaurusRelations.length > 0) {
    await store.importJson({
      corpusId: CORPUS_ID,
      thesaurusRelations,
    });
  }
  console.log(`[build-ja-lexicon] Thesaurus: ${thesaurusRelations.length} relations written`);

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Dictionary entries: ${dictEntries.length}`);
  console.log(`  JA entities: ${dictEntries.filter(e => e.domainCategory === 'ja-entity').length}`);
  console.log(`  EN entities: ${dictEntries.filter(e => e.domainCategory === 'en-entity').length}`);
  console.log(`Thesaurus relations: ${thesaurusRelations.length}`);
  console.log(`  Katakana synonyms: ${thesaurusRelations.filter(r => r.relationId.startsWith('thes-kata')).length}`);
  console.log(`  Alias synonyms: ${aliasRelCount}`);
  console.log(`  EN↔JA co-occurrence: ${cooccurRelCount}`);

  await client.close();
  db.close();
  console.log('\n[build-ja-lexicon] Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
