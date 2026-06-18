/**
 * Japanese Evaluation Normalizer
 *
 * Normalizes Japanese text for answer comparison in HotpotQA benchmarks.
 * Handles fullwidth/halfwidth, chouon, katakana/hiragana, admin suffixes.
 *
 * Usage: imported by benchmark-hotpotqa-ja.mjs
 */

// ─── Fullwidth → Halfwidth conversion ───
const FW_START = 0xFF01; // ！
const FW_END   = 0xFF5E; // ～
const FW_OFFSET = 0xFEE0;

function fullwidthToHalfwidth(s) {
  return s.replace(/[\uFF01-\uFF5E]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - FW_OFFSET)
  ).replace(/\u3000/g, ' '); // fullwidth space
}

// ─── Katakana ↔ Hiragana ───
const KATA_START = 0x30A1; // ァ
const KATA_END   = 0x30F6; // ヶ
const HIRA_OFFSET = 0x0060;

function katakanaToHiragana(s) {
  return s.replace(/[\u30A1-\u30F6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - HIRA_OFFSET)
  );
}

function hiraganaToKatakana(s) {
  return s.replace(/[\u3041-\u3096]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + HIRA_OFFSET)
  );
}

// ─── Chouon (長音) normalization ───
// コンピューター → コンピュータ, サーバー → サーバ
function normalizeChouon(s) {
  return s.replace(/ー$/g, '');
}

// ─── Admin suffix removal ───
// 東京都 → 東京, 大阪府 → 大阪, 北海道 → 北海道 (keep 道 for 北海道)
const ADMIN_SUFFIXES = /^(.{2,})(都|府|県|市|区|町|村|郡)$/;

function removeAdminSuffix(s) {
  const m = s.match(ADMIN_SUFFIXES);
  if (m) return m[1];
  return s;
}

// ─── Vu kana normalization ───
// ヴァ→バ, ヴィ→ビ, ヴ→ブ, ヴェ→ベ, ヴォ→ボ
function normalizeVuKana(s) {
  return s
    .replace(/ヴァ/g, 'バ')
    .replace(/ヴィ/g, 'ビ')
    .replace(/ヴェ/g, 'ベ')
    .replace(/ヴォ/g, 'ボ')
    .replace(/ヴ/g, 'ブ');
}

// ─── Main normalizer ───
export function normalizeJapanese(text) {
  if (!text) return '';
  let s = text.trim();
  s = fullwidthToHalfwidth(s);
  s = normalizeVuKana(s);
  s = normalizeChouon(s);
  return s;
}

/**
 * Japanese-aware answer matching.
 * Tries multiple normalization strategies before falling back to English eval.
 *
 * @param {string} response - LLM response
 * @param {string} goldJa - Japanese gold answer
 * @param {string} goldEn - English gold answer (fallback)
 * @param {function} normalizedContainsEn - English normalizedContains function
 * @returns {boolean}
 */
export function normalizedContainsJa(response, goldJa, goldEn, normalizedContainsEn) {
  if (!response) return false;

  const cleanResp = response.replace(/\*\*/g, '');

  // 1. Direct Japanese match (normalized)
  if (goldJa) {
    const normResp = normalizeJapanese(cleanResp);
    const normGold = normalizeJapanese(goldJa);

    // Exact substring
    if (normResp.includes(normGold)) return true;
    if (normGold.includes(normResp) && normResp.length >= 2) return true;

    // Hiragana-unified match
    const hiraResp = katakanaToHiragana(normResp);
    const hiraGold = katakanaToHiragana(normGold);
    if (hiraResp.includes(hiraGold)) return true;

    // Admin suffix removal
    const noAdminResp = removeAdminSuffix(normResp);
    const noAdminGold = removeAdminSuffix(normGold);
    if (noAdminResp.includes(noAdminGold) || noAdminGold.includes(noAdminResp)) return true;

    // Token overlap for multi-word Japanese answers
    // Split on common delimiters (・、，,  spaces)
    const jaTokensGold = normGold.split(/[・、，,\s]+/).filter(t => t.length > 0);
    if (jaTokensGold.length >= 2) {
      const matched = jaTokensGold.filter(t => normResp.includes(t)).length;
      if (matched >= jaTokensGold.length * 0.8) return true;
    }
  }

  // 2. English fallback (LLM may answer in English even for JA questions)
  if (goldEn && normalizedContainsEn) {
    if (normalizedContainsEn(cleanResp, goldEn)) return true;
  }

  return false;
}
