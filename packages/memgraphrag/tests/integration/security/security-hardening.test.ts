import { describe, expect, it } from 'vitest';
import { SecretMasker } from '../../../src/infrastructure/security/SecretMasker.js';
import { safeErrorSerializer } from '../../../src/interface/mcp/safeErrorSerializer.js';
import { jsonErrorResult } from '../../../src/interface/mcp/handlerUtils.js';

describe('TASK-MG-052: security hardening', () => {
  it('masks secrets in log messages', () => {
    const masker = new SecretMasker();
    const masked = masker.mask('OPENAI_API_KEY=sk-very-secret-value and Bearer tokenvalue123456');

    expect(masked).not.toContain('sk-very-secret-value');
    expect(masked).not.toContain('tokenvalue123456');
    expect(masked).toContain('[REDACTED_SECRET]');
  });

  it('redacts file paths and stack traces from serialized errors', () => {
    const error = new Error('OPENAI_API_KEY=sk-abc failed at /home/nahisaho/project/file.ts');
    error.stack = 'Error: OPENAI_API_KEY=sk-abc failed at /home/nahisaho/project/file.ts\n    at fn (/home/nahisaho/project/file.ts:10:2)';

    const serialized = safeErrorSerializer(error);

    expect(serialized.message).not.toContain('sk-abc');
    expect(serialized.message).not.toContain('/home/nahisaho');
    expect(serialized.message).not.toContain('\n    at');
  });

  it('uses safe serialization for MCP error responses', () => {
    const result = jsonErrorResult(new Error('OPENAI_API_KEY=sk-abc at /home/nahisaho/secret.ts'));
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(text).toContain('[REDACTED_SECRET]');
    expect(text).toContain('[REDACTED_PATH]');
  });
});
