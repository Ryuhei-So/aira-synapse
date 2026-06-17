/**
 * Shared comparison query detection.
 * Used by QueryService (prompt routing).
 *
 * Recall: ~90% on HotpotQA comparison questions
 * Precision: ~77% (25/400 bridge false positives)
 */
export const COMPARISON_PATTERNS = /\b(who is (more|less|taller|shorter|older|younger|bigger|smaller|larger|heavier|lighter)|(?:compare|comparison|differ(?:ent|ence)?|between)\b.*\b(?:and|or|vs)\b|(?:which|who)\b.*\b(?:more|less|earlier|later|first|last|bigger|smaller|larger|longer|shorter|higher|lower|greater|fewer|older|younger|taller|heavier|lighter)\b|(?:both)\b.*\b(?:and|or)\b|\b(?:are both|were both|is both)\b|(?:which is a|which was a|which is an|which was an)\b.*\b(?:,|or)\b|(?:which \w+)\b.*\b(?:,\s*\w+\s+(?:\w+\s+)*or\s+)|(?:^are |^were |^did |^do |^is |^was |^have |^has ).*\b(?:and|or)\b|(?:\w+\s+or\s+\w+).*(?:\?|$).*\b(?:which|what)\b|\bolder\b|\bnewer\b|\bfounded (?:earlier|later|first|before|after)\b|\b(?:was|were)\b.*\b(?:before|after)\b|\bboth (?:held|share|hold|have|had)\b|\bhave in common\b|\bin common\b|\bsame (?:type|kind|genre|country|city|decade|century|year)\b)/i;

/** Existing boolean detection — maintained for backward compatibility. */
export function isComparisonQuery(text: string): boolean {
  return COMPARISON_PATTERNS.test(text);
}

// --- Phase 2 (DES-MG4-003): Fine-grained comparison analysis ---

export type ComparisonType = 'yesno' | 'which' | 'shared_attribute' | 'none';

export interface ComparisonAnalysis {
  readonly type: ComparisonType;
  readonly entities: readonly string[];
  readonly confidence: number;
}

/**
 * Yes/No answer expectation pattern:
 * Queries starting with auxiliary verbs that expect yes/no answers,
 * combined with 2+ entity references.
 */
const YESNO_PATTERN = /^(are|is|do|does|did|was|were|have|has|had|can|could|will|would|should)\b/i;

/**
 * "Which" comparison pattern — expects an entity name as answer, not yes/no.
 */
const WHICH_PATTERN = /\b(which|who)\b.*\b(more|less|earlier|later|first|last|bigger|smaller|larger|longer|shorter|higher|lower|greater|fewer|older|younger|taller|heavier|lighter)\b/i;

/**
 * Shared attribute pattern — "what do X and Y have in common"
 */
const SHARED_ATTR_PATTERN = /\b(have in common|in common|same \w+|both (?:held|share|hold|have|had))\b/i;

/**
 * Extract likely entity references (capitalized phrases) from a query.
 */
function extractEntities(query: string): string[] {
  const matches = query.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  // Also try quoted entities or entities around "and"/"or"
  const andOrMatch = query.match(/(.+?)\s+(?:and|or)\s+(.+?)(?:\s+both|\?|$)/i);
  if (andOrMatch && matches.length < 2) {
    return [andOrMatch[1]!.trim(), andOrMatch[2]!.trim()].filter(e => e.length > 1);
  }
  return matches.filter(m => m.length > 1);
}

/**
 * Analyze a query for comparison type with fine-grained classification.
 * DES-MG4-003: Separates Yes/No expectation from "which" comparisons.
 */
export function analyzeComparisonQuery(query: string): ComparisonAnalysis {
  const entities = extractEntities(query);

  // Check Yes/No pattern first (auxiliary verb + 2+ entities)
  if (YESNO_PATTERN.test(query) && entities.length >= 2) {
    return { type: 'yesno', entities, confidence: 0.85 };
  }
  if (YESNO_PATTERN.test(query) && COMPARISON_PATTERNS.test(query)) {
    return { type: 'yesno', entities, confidence: 0.7 };
  }

  // "Which/Who is more..." = expects entity answer
  if (WHICH_PATTERN.test(query)) {
    return { type: 'which', entities, confidence: 0.8 };
  }

  // Shared attribute
  if (SHARED_ATTR_PATTERN.test(query)) {
    return { type: 'shared_attribute', entities, confidence: 0.75 };
  }

  // General comparison (detected by legacy pattern) but not specifically yes/no
  if (COMPARISON_PATTERNS.test(query) && entities.length >= 2) {
    return { type: 'which', entities, confidence: 0.6 };
  }

  return { type: 'none', entities: [], confidence: 0 };
}
