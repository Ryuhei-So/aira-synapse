/**
 * Infrastructure Layer — OpenAI-compatible text generation provider.
 * DES-MG-033: Fetch-based adapter with retry and secret redaction.
 */

import type {
  ILLMProvider,
  ProviderHealth,
  TextGenerationRequest,
  TextGenerationResponse,
} from '../../domain/provider/llmProvider.js';

interface OpenAILLMProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

type ChatMessageContent = string | ReadonlyArray<{
  readonly type?: string;
  readonly text?: string;
}>;

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: ChatMessageContent;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 25;

function toContentText(content: ChatMessageContent | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

export class OpenAILLMProvider implements ILLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  public constructor(options: OpenAILLMProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  public async generate(
    request: TextGenerationRequest,
  ): Promise<TextGenerationResponse> {
    const payload = {
      model: this.model,
      messages: [
        ...(request.systemPrompt
          ? [{ role: 'system' as const, content: request.systemPrompt }]
          : []),
        { role: 'user' as const, content: request.prompt },
      ],
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      response_format:
        request.responseFormat === 'json'
          ? { type: 'json_object' as const }
          : undefined,
    };

    const response = await this.retryWithBackoff(async () => {
      const apiResponse = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      });

      if (!apiResponse.ok) {
        const body = await apiResponse.text();
        throw this.createHttpError(apiResponse.status, body);
      }

      return (await apiResponse.json()) as ChatCompletionResponse;
    });

    return {
      text: toContentText(response.choices?.[0]?.message?.content),
      model: this.model,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  public async healthCheck(): Promise<ProviderHealth> {
    if (!this.apiKey.trim()) {
      return { healthy: false, message: 'OpenAI API key is not configured' };
    }

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        const body = await response.text();
        throw this.createHttpError(response.status, body);
      }

      return { healthy: true, message: `OpenAI model ${this.model} reachable` };
    } catch (error) {
      return {
        healthy: false,
        message: this.sanitizeError(error),
      };
    }
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < MAX_RETRIES) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        attempt += 1;

        if (!this.isTransientError(error) || attempt >= MAX_RETRIES) {
          throw new Error(this.sanitizeError(error));
        }

        await this.sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }

    throw new Error(this.sanitizeError(lastError));
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private createHttpError(status: number, body: string): Error {
    return new Error(`OpenAI request failed with status ${status}: ${body}`);
  }

  private isTransientError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return Array.from(TRANSIENT_STATUS_CODES).some((status) =>
      message.includes(`status ${status}`),
    );
  }

  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.split(this.apiKey).join('***');
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
