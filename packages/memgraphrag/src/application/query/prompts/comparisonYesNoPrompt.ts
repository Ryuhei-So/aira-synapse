/**
 * Yes/No comparison reasoning prompt.
 * DES-MG4-003 (REQ-MG4-003): Structured reasoning for Yes/No comparison queries.
 */

export function buildYesNoComparisonPrompt(
  query: string,
  entities: readonly string[],
  context: string,
): string {
  const entityList = entities.length > 0 ? entities.join(', ') : 'the entities in the question';

  return `You are answering a yes/no comparison question about: ${entityList}

Step-by-step:
1. Identify the claim or comparison being made
2. Find evidence FOR the claim in the context
3. Find evidence AGAINST the claim in the context
4. Weigh the evidence and determine yes or no

Rules:
- Use ONLY the provided context
- Answer MUST be exactly "yes" or "no" (lowercase)
- If evidence is contradictory, go with the stronger evidence
- If the context seems insufficient, give your best answer based on available information — NEVER refuse to answer
- Your last line MUST be: FINAL: yes  OR  FINAL: no

Question: ${query}

Context:
${context}

Evidence analysis and answer:`;
}
