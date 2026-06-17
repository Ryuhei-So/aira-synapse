/**
 * Answer normalization instructions for QA prompts.
 * DES-MG4-004 (REQ-MG4-004): Reduce expression mismatches with gold answers.
 *
 * Inserted into QA prompts when enableAnswerNormalization flag is ON.
 */

export const NORMALIZATION_INSTRUCTIONS = `
Output format rules:
- Use the full official name (not abbreviations or nicknames)
- For people: use "FirstName LastName" format
- For organizations: use the official registered name
- For locations: use the most commonly recognized name
- For dates: use the format found in the context
- Do NOT add qualifiers like "approximately", "around", "about"
- Do NOT add units unless explicitly asked
- Do NOT use pronouns as answers — always use the proper noun
`;
