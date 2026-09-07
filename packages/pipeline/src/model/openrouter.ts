/**
 * OpenRouter chat-completions client.
 *
 * One OpenAI-compatible endpoint in front of many providers, so the model is a
 * configuration value rather than a code dependency. Only the worker constructs this;
 * the API never holds the key.
 *
 * Three things this client does that a thin `fetch` wrapper would not:
 *
 *   - Treats a schema violation as a normal outcome to repair, not an exception. A free
 *     endpoint may ignore `response_format` under load, so the caller always re-validates
 *     with Zod and may retry once with the validation error fed back.
 *   - Distinguishes retryable from permanent failures at the HTTP layer, and honours
 *     `Retry-After` rather than backing off blindly, which plan 2.3 requires.
 *   - Reports token usage and the model that actually served the request, since
 *     OpenRouter may route a request to a different provider than expected and the
 *     evaluation in Phase 8 has to report what really ran.
 */

import { z } from 'zod';

/** Text or an image, as OpenRouter's multimodal content parts. */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string | readonly ContentPart[];
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  /** JSON Schema the reply must satisfy. Sent as response_format, never trusted. */
  readonly schema?: { readonly name: string; readonly schema: Record<string, unknown> };
  readonly maxTokens?: number;
  readonly temperature?: number;
  /**
   * Fixed by default. Extraction should be as reproducible as a hosted model allows,
   * and plan 8.1 asks for results that can be compared across runs.
   */
  readonly seed?: number;
}

export interface CompletionResult {
  readonly text: string;
  /** The model OpenRouter actually served, which may differ from the one requested. */
  readonly servedByModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
}

/** A model call that failed, carrying whether trying again could help. */
export class ModelError extends Error {
  override readonly name = 'ModelError';

  constructor(
    message: string,
    readonly kind: string,
    readonly retryable: boolean,
    /** Seconds the provider asked us to wait, when it said so. */
    readonly retryAfterSeconds?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface OpenRouterOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /**
   * Sent as HTTP-Referer and X-Title. OpenRouter uses these for attribution on its
   * rankings; they are optional and carry no credentials.
   */
  readonly appUrl?: string;
  readonly appTitle?: string;
}

const usageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
});

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }).optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: usageSchema.optional(),
});

/** HTTP statuses worth trying again. 408 and 409 included; 429 and 5xx are the common ones. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Encodes a rendered page as a data URL, which is how OpenRouter takes image input. */
export function imageContentPart(bytes: Uint8Array, mimeType = 'image/png'): ContentPart {
  return {
    type: 'image_url',
    image_url: { url: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}` },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenRouterClient {
  constructor(private readonly options: OpenRouterOptions) {}

  get model(): string {
    return this.options.model;
  }

  /**
   * Sends one completion, retrying transient failures with bounded exponential backoff.
   *
   * A provider's own `Retry-After` wins over the computed backoff: plan 2.3 asks for
   * rate-limit responses to be respected rather than retried on our own schedule.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let lastError: ModelError | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await this.send(request);
      } catch (error) {
        const modelError =
          error instanceof ModelError
            ? error
            : new ModelError((error as Error).message, 'unexpected_error', true);

        if (!modelError.retryable || attempt === this.options.maxRetries) throw modelError;

        lastError = modelError;
        const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
        const waitMs =
          modelError.retryAfterSeconds !== undefined
            ? modelError.retryAfterSeconds * 1000
            : backoffMs;
        await sleep(waitMs);
      }
    }

    throw lastError ?? new ModelError('retries exhausted', 'retries_exhausted', false);
  }

  private async send(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    // AbortSignal.timeout rather than a Promise race, so the socket is actually closed
    // instead of being left open behind a resolved promise.
    const signal = AbortSignal.timeout(this.options.timeoutMs);

    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0,
      seed: request.seed ?? 7,
    };

    if (request.schema !== undefined) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema },
      };
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      'content-type': 'application/json',
    };
    if (this.options.appUrl !== undefined) headers['HTTP-Referer'] = this.options.appUrl;
    if (this.options.appTitle !== undefined) headers['X-Title'] = this.options.appTitle;

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // A timeout or a dropped connection. Both are worth another attempt.
      const aborted = (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError';
      throw new ModelError(
        aborted ? `request exceeded ${this.options.timeoutMs}ms` : (error as Error).message,
        aborted ? 'provider_timeout' : 'network_error',
        true,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ModelError(
        `OpenRouter returned ${response.status}: ${detail.slice(0, 400)}`,
        response.status === 429 ? 'provider_rate_limited' : `http_${response.status}`,
        isRetryableStatus(response.status),
        parseRetryAfter(response.headers.get('retry-after')),
        response.status,
      );
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      // The envelope itself was malformed, which is different from the *content* failing
      // its schema. Retryable, because it usually means a truncated or proxied response.
      throw new ModelError(
        `unrecognised response envelope: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'malformed_response',
        true,
      );
    }

    const choice = parsed.data.choices[0];
    const text = choice?.message?.content ?? '';

    if (text.trim() === '') {
      // An empty completion is a failure to answer, not an answer. Free endpoints return
      // this under load, and passing it on would look like a document with no facts.
      throw new ModelError(
        `empty completion (finish_reason: ${choice?.finish_reason ?? 'none'})`,
        'empty_completion',
        true,
      );
    }

    return {
      text,
      servedByModel: parsed.data.model ?? this.options.model,
      promptTokens: parsed.data.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Extracts a JSON object from a completion.
 *
 * Structured output constrains shape, not obedience: a free model may still wrap its JSON
 * in prose or a fenced code block. Recovering the object here means one malformed
 * envelope does not cost a whole extraction, while the Zod parse the caller performs
 * afterwards is what actually decides whether the content is acceptable.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to recovery.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fall through.
    }
  }

  const firstBrace = trimmed.search(/[[{]/);
  const lastBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // Fall through.
    }
  }

  throw new ModelError('the completion contained no parsable JSON', 'unparsable_json', false);
}
