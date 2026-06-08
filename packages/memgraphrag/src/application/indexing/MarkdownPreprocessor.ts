export function normalizeMarkdownUnicode(markdown: string): string {
  return markdown.normalize('NFKC');
}

export function normalizeMarkdownWhitespace(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripControlCharacters(markdown: string): string {
  return markdown.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function preprocessMarkdown(markdown: string): string {
  return normalizeMarkdownWhitespace(
    stripControlCharacters(normalizeMarkdownUnicode(markdown)),
  );
}
