/**
 * Groq chat-completions client.
 *
 * OpenAI-compatible, so this is a thinner client than the Bedrock one: a JSON Schema goes
 * out as `response_format` and the answer comes back as text that the caller parses. What
 * it does not get is Bedrock's forced tool call, where the model cannot answer in prose at
 * all — so `extractJson` earns its place here, recovering an object from a reply that
 * arrived wrapped in a fence or an apology.
 *
 * Three behaviours that a bare `fetch` would not have, kept identical to the Bedrock
 * client so the pipeline's failure handling does not have to care which one answered:
 *
 *   - Retryable and permanent failures are distinguished at the HTTP layer, and
 *     `Retry-After` is honoured over the computed backoff.
 *   - An empty completion is a failure to answer, not an answer.
 *   - Token usage and the model that actually served the request are reported, because
 *     the evaluation has to say what really ran.
 */

import { z } from 'zod';

import {
  ModelError,
  withRetries,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
} from './types.ts';

export interface GroqOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
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
        message: z
          .object({
            content: z.string().nullable().optional(),
            /**
             * Where a reasoning model puts its thinking.
             *
             * Read only to explain a failure, never used as the answer: it is the
             * model's scratchpad, not the structured output the caller asked for.
             */
            reasoning: z.string().nullable().optional(),
          })
          .optional(),
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

/**
 * Rewrites content parts into the OpenAI wire shape.
 *
 * The pipeline's `ContentPart` carries a media type and base64 because Bedrock wants
 * typed image blocks; OpenAI-compatible endpoints want a data URL. Neither spelling is
 * the pipeline's, so the translation happens at the edge in each client.
 */
function toWireContent(content: string | readonly ContentPart[]): unknown {
  if (typeof content === 'string') return content;

  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.base64}` } },
  );
}

function toWireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: toWireContent(message.content),
  }));
}

export class GroqClient {
  constructor(private readonly options: GroqOptions) {}

  get model(): string {
    return this.options.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return withRetries(this.options.maxRetries, () => this.send(request));
  }

  private async send(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    // AbortSignal.timeout rather than a Promise race, so the socket is actually closed
    // instead of being left open behind a resolved promise.
    const signal = AbortSignal.timeout(this.options.timeoutMs);

    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: toWireMessages(request.messages),
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0,
    };

    // Sent only when the caller asked for one: "OpenAI-compatible" is a family of
    // dialects, and the strict members reject fields they do not implement outright.
    if (request.seed !== undefined) body['seed'] = request.seed;

    if (request.schema !== undefined) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema },
      };
    }

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // A timeout or a dropped connection. Both are worth another attempt.
      const aborted =
        (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError';
      throw new ModelError(
        aborted ? `request exceeded ${this.options.timeoutMs}ms` : (error as Error).message,
        aborted ? 'provider_timeout' : 'network_error',
        true,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ModelError(
        `Groq returned ${response.status}: ${detail.slice(0, 400)}`,
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
      /**
       * An empty answer from a reasoning model that ran out of budget.
       *
       * `gpt-oss-120b` spends tokens thinking in a separate `reasoning` field and returns
       * empty `content` when `max_tokens` is consumed before it starts answering. That is
       * not a transient fault: the same request with the same ceiling will do it again,
       * so retrying eight times only spends minutes proving it. Treating it as retryable
       * is what froze a run at one chunk of three hundred with the worker idle.
       *
       * Reported as its own kind rather than as a generic empty completion, because the
       * remedy is a larger `max_tokens` or a non-reasoning model, and a message that says
       * "empty completion" sends someone looking for a network problem instead.
       */
      const truncated = choice?.finish_reason === 'length';
      const thought = choice?.message?.reasoning ?? '';

      if (truncated) {
        throw new ModelError(
          `the model spent its ${request.maxTokens ?? 4096}-token budget on reasoning and returned no answer` +
            (thought === '' ? '' : ` (${thought.length} characters of it)`),
          'reasoning_budget_exhausted',
          false,
        );
      }

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
