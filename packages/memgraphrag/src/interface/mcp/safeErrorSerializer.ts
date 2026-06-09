import type { ToolError } from './errors.js';
import { toToolError } from './errors.js';
import { SecretMasker } from '../../infrastructure/security/SecretMasker.js';

const PATH_PATTERN = /(?:\/home|\/Users|[A-Za-z]:\\)[^\s:\n]+/g;
const STACK_LINE_PATTERN = /\n\s+at\s.+/g;

function redactMessage(message: string): string {
  const masker = new SecretMasker();
  return masker.mask(message)
    .replace(PATH_PATTERN, '[REDACTED_PATH]')
    .replace(STACK_LINE_PATTERN, '')
    .trim();
}

export function safeErrorSerializer(error: unknown): ToolError {
  const toolError = toToolError(error);
  return {
    ...toolError,
    message: redactMessage(toolError.message),
    details: toolError.details ? {
      ...toolError.details,
    } : undefined,
  };
}
