/**
 * The contracts every model client honours, and the bits of behaviour that are the
 * pipeline's rather than any provider's.
 *
 * These lived inside the OpenRouter client while there was only one. Bedrock speaks a
 * different protocol entirely — AWS SigV4, a `Converse` action, tool definitions instead
 * of `response_format` — so the parts the pipeline actually depends on are separated
 * here from the parts that are one vendor's wire format.
 *
 * The content shape is the clearest example. It used to be OpenAI's `image_url` data URL
 * because that is what the endpoint took. Bedrock wants raw bytes in a typed image block,
 * so neither vendor's spelling belongs in a type the parsing stage builds. What both need
 * is the media type and the bytes; the client turns that into its own dialect.
 */

/** Text, or an image the model is being shown. */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  /**
   * Base64 rather than a `Uint8Array`, because both providers want a string on the wire
   * and a typed array serialises to `{"0":137,"1":80,…}` — enormous for a page image,
   * and unreadable in any log or error that carries the request.
   */
  | { readonly type: 'image'; readonly mimeType: string; readonly base64: string };

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string | readonly ContentPart[];
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  /** JSON Schema the reply must satisfy. Constrains the model, never trusted after. */
  readonly schema?: { readonly name: string; readonly schema: Record<string, unknown> };
  readonly maxTokens?: number;
  readonly temperature?: number;
  /**
   * Honoured where a provider implements it, ignored where it does not. Bedrock's
   * `Converse` has no seed field, so reproducibility rests on `temperature: 0` and the
   * recorded-response cache, which is where it rested in practice anyway.
   */
  readonly seed?: number;
}

export interface CompletionResult {
  readonly text: string;
  /** What actually served the request, which need not be what was asked for. */
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

/** Wraps a rendered page so a client can hand it to whatever image block it uses. */
export function imageContentPart(bytes: Uint8Array, mimeType = 'image/png'): ContentPart {
  return { type: 'image', mimeType, base64: Buffer.from(bytes).toString('base64') };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries transient failures with bounded exponential backoff and full jitter.
 *
 * A provider's own retry hint wins over the computed backoff: plan 2.3 asks for
 * rate-limit responses to be respected rather than retried on our own schedule.
 *
 * The jitter is not decoration. Throttled callers are synchronised by construction —
 * they were all refused at the same instant — so a deterministic backoff returns them
 * together and they collide again. Randomising the wait spreads them out.
 */
export async function withRetries<T>(
  maxRetries: number,
  send: () => Promise<T>,
): Promise<T> {
  let lastError: ModelError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const modelError =
        error instanceof ModelError
          ? error
          : new ModelError((error as Error).message, 'unexpected_error', true);

      if (!modelError.retryable || attempt === maxRetries) throw modelError;

      lastError = modelError;

      const ceiling = Math.min(30_000, 1000 * 2 ** attempt);
      const waitMs =
        modelError.retryAfterSeconds !== undefined
          ? modelError.retryAfterSeconds * 1000
          : Math.round(ceiling * (0.5 + Math.random() * 0.5));
      await sleep(waitMs);
    }
  }

  throw lastError ?? new ModelError('retries exhausted', 'retries_exhausted', false);
}

/**
 * Extracts a JSON object from a completion.
 *
 * Structured output constrains shape, not obedience: a model may still wrap its JSON in
 * prose or a fenced code block. Recovering the object here means one malformed envelope
 * does not cost a whole extraction, while the Zod parse the caller performs afterwards is
 * what actually decides whether the content is acceptable.
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
