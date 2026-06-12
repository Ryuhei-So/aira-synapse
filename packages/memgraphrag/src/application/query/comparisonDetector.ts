/**
 * Shared comparison query detection.
 * Used by QueryService (prompt routing).
 *
 * Recall: ~87% on HotpotQA comparison questions
 * Precision: ~77% (25/400 bridge false positives)
 */
export const COMPARISON_PATTERNS = /\b(who is (more|less|taller|shorter|older|younger|bigger|smaller|larger|heavier|lighter)|(?:compare|comparison|differ(?:ent|ence)?|between)\b.*\b(?:and|or|vs)\b|(?:which|who)\b.*\b(?:more|less|earlier|later|first|last|bigger|smaller|larger|longer|shorter|higher|lower|greater|fewer|older|younger|taller|heavier|lighter)\b|(?:both)\b.*\b(?:and|or)\b|\b(?:are both|were both|is both)\b|(?:which is a|which was a|which is an|which was an)\b.*\b(?:,|or)\b|(?:which \w+)\b.*\b(?:,\s*\w+\s+(?:\w+\s+)*or\s+)|(?:^are |^were |^did |^do |^is |^was |^have |^has ).*\b(?:and|or)\b|(?:\w+\s+or\s+\w+).*(?:\?|$).*\b(?:which|what)\b|\bolder\b|\bnewer\b|\bfounded (?:earlier|later|first|before|after)\b|\b(?:was|were)\b.*\b(?:before|after)\b.*\b(?:or|and)\b|\bboth (?:held|share|hold|have|had)\b|\bhave in common\b|\bin common\b|\bsame (?:type|kind|genre|country|city|decade|century|year)\b)/i;

export function isComparisonQuery(text: string): boolean {
  return COMPARISON_PATTERNS.test(text);
}
