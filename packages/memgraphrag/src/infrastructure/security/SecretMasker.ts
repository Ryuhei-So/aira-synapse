function maskString(value: string): string {
  return value
    .replace(/sk-[a-z0-9]{6,}/gi, '[REDACTED_SECRET]')
    .replace(/(OPENAI_API_KEY\s*[=:]\s*)([^\s,;]+)/gi, '$1[REDACTED_SECRET]')
    .replace(/(Bearer\s+)([A-Za-z0-9._-]{10,})/gi, '$1[REDACTED_SECRET]')
    .replace(/(api[_-]?key\s*[=:]\s*)([^\s,;]+)/gi, '$1[REDACTED_SECRET]');
}

export class SecretMasker {
  public mask(value: string): string {
    return maskString(value);
  }

  public maskObject<T>(value: T): T {
    return JSON.parse(maskString(JSON.stringify(value))) as T;
  }
}

export function redactSecrets(value: string): string {
  return maskString(value);
}
