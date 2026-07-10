/**
 * Infrastructure Layer — secret redaction for logs and error responses.
 *
 * Covers modern provider key formats (e.g. `sk-proj-…`, `sk-svcacct-…`,
 * `sk-ant-…`) as well as GitHub / Slack / AWS tokens. `maskObject` masks each
 * string value in place rather than round-tripping through JSON.stringify /
 * JSON.parse, which could corrupt the serialized form and throw.
 */

// Standalone token shapes — the whole match is the secret.
const TOKEN_PATTERNS: readonly RegExp[] = [
  // OpenAI-style keys, including prefixed project/service-account/anthropic forms.
  // `-`/`_` in the class means `sk-proj-…` / `sk-svcacct-…` are caught in full.
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  // GitHub personal-access / app tokens.
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
];

// `<prefix><secret>` assignments — keep the prefix ($1), redact the value.
const ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  /(OPENAI_API_KEY\s*[=:]\s*)([^\s,;"']+)/gi,
  /(Bearer\s+)([A-Za-z0-9._-]{10,})/gi,
  /(api[_-]?key\s*[=:]\s*)([^\s,;"']+)/gi,
];

function maskString(value: string): string {
  let out = value;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, '[REDACTED_SECRET]');
  }
  for (const pattern of ASSIGNMENT_PATTERNS) {
    out = out.replace(pattern, '$1[REDACTED_SECRET]');
  }
  return out;
}

function maskValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskString(value);
  }
  if (Array.isArray(value)) {
    return value.map(maskValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = maskValue(val);
    }
    return out;
  }
  return value;
}

export class SecretMasker {
  public mask(value: string): string {
    return maskString(value);
  }

  public maskObject<T>(value: T): T {
    return maskValue(value) as T;
  }
}

export function redactSecrets(value: string): string {
  return maskString(value);
}
