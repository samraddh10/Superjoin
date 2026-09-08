/**
 * Amazon Bedrock runtime client, speaking the `Converse` action.
 *
 * `Converse` rather than `InvokeModel` because `InvokeModel` takes each model family's
 * own request body — Anthropic's `messages`, Meta's `prompt`, Amazon's `inputText` — and
 * choosing it would put the model family back into the code, which is the coupling this
 * client exists to avoid. `Converse` normalises all of them behind one shape, so the
 * model stays a configuration value.
 *
 * Two things here are Bedrock-shaped and worth knowing before reading the code:
 *
 *   - **There is no `response_format`.** Structured output is a forced tool call: the
 *     JSON Schema is declared as a tool's input schema and `toolChoice` requires the
 *     model to call it, so the arguments come back already parsed as an object. That is
 *     stronger than asking for JSON and hoping, which is what the previous endpoint did.
 *   - **There is no seed.** `CompletionRequest.seed` is accepted and ignored. Determinism
 *     rests on `temperature: 0` and the recorded-response cache, which is where it rested
 *     in practice anyway — the previous provider rejected the field outright.
 *
 * Credentials are resolved by the AWS SDK's default provider chain unless an access key
 * is supplied explicitly, so a task role, SSO profile, or environment variables all work
 * without the pipeline knowing which.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type ImageFormat,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';

import {
  ModelError,
  withRetries,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
} from './types.ts';

export interface BedrockOptions {
  /** Bedrock model id or inference profile ARN, e.g. `moonshotai.kimi-k2.5`. */
  readonly modelId: string;
  readonly region: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /**
   * A Bedrock long-term API key, which authenticates with a bearer header rather than a
   * SigV4 signature. What the console calls an "API key". Wins over the pair below.
   */
  readonly bearerToken?: string;
  /** Omitted to use the SDK's default credential chain, which is the usual case. */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
}

/** Bedrock names image formats itself rather than taking a media type. */
function imageFormat(mimeType: string): ImageFormat {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      throw new ModelError(
        `Bedrock accepts png, jpeg, gif and webp images; got ${mimeType}`,
        'unsupported_image_format',
        false,
      );
  }
}

function toContentBlocks(content: string | readonly ContentPart[]): ContentBlock[] {
  if (typeof content === 'string') return [{ text: content }];

  return content.map((part): ContentBlock => {
    if (part.type === 'text') return { text: part.text };
    return {
      image: {
        format: imageFormat(part.mimeType),
        source: { bytes: Buffer.from(part.base64, 'base64') },
      },
    };
  });
}

/**
 * Splits the conversation the way Bedrock wants it.
 *
 * System prompts are a separate top-level field, not a role inside `messages`, and
 * passing one as a message is a `ValidationException` rather than a soft failure.
 */
function splitMessages(messages: readonly ChatMessage[]): {
  system: SystemContentBlock[];
  conversation: Message[];
} {
  const system: SystemContentBlock[] = [];
  const conversation: Message[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
      if (text.trim() !== '') system.push({ text });
      continue;
    }

    conversation.push({
      role: message.role,
      content: toContentBlocks(message.content),
    });
  }

  return { system, conversation };
}

/**
 * Which Bedrock failures are worth another attempt.
 *
 * Named rather than inferred from the status code, because the distinction that matters
 * to the pipeline is not HTTP's. `ThrottlingException` and `ValidationException` are both
 * 400-family, and one clears on its own while the other never will — the extraction
 * stage's give-up rule counts them differently for exactly that reason.
 */
function classify(error: unknown): ModelError {
  const name = (error as { name?: string }).name ?? 'UnknownError';
  const message = (error as Error).message ?? String(error);
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

  switch (name) {
    case 'ThrottlingException':
    case 'TooManyRequestsException':
      return new ModelError(
        `Bedrock throttled the request: ${message}`,
        'provider_rate_limited',
        true,
        undefined,
        status,
      );

    case 'ModelTimeoutException':
    case 'TimeoutError':
    case 'AbortError':
      return new ModelError(`Bedrock request timed out: ${message}`, 'provider_timeout', true, undefined, status);

    case 'ModelNotReadyException':
    case 'ServiceUnavailableException':
    case 'InternalServerException':
      return new ModelError(`Bedrock is unavailable: ${message}`, 'provider_unavailable', true, undefined, status);

    case 'ServiceQuotaExceededException':
      return new ModelError(
        `Bedrock quota exceeded: ${message}`,
        'provider_quota_exceeded',
        false,
        undefined,
        status,
      );

    /**
     * The three that mean the request or the account is wrong, not the moment.
     *
     * `AccessDeniedException` in particular is the one a first run hits: a model must be
     * enabled per-region in the Bedrock console before any credentials can call it, and
     * retrying that eight times only delays the message that says so.
     */
    case 'AccessDeniedException':
      return new ModelError(
        `Bedrock denied access to ${name}: ${message}. Model access is granted per region in the Bedrock console.`,
        'provider_access_denied',
        false,
        undefined,
        status,
      );

    case 'ValidationException':
      return new ModelError(`Bedrock rejected the request: ${message}`, 'invalid_request', false, undefined, status);

    case 'ResourceNotFoundException':
      return new ModelError(
        `Bedrock has no such model in this region: ${message}`,
        'model_not_found',
        false,
        undefined,
        status,
      );

    default:
      return new ModelError(message, `bedrock_${name}`, true, undefined, status);
  }
}

/**
 * Reads the answer out of a `Converse` reply.
 *
 * A forced tool call returns its arguments as an already-parsed object, which is handed
 * back stringified so callers keep running `extractJson` and Zod over one shape whether
 * the schema was used or not. A model that answers in plain text despite `toolChoice` is
 * not treated as a failure here — the caller's Zod parse is what decides.
 */
function readReply(output: ConverseCommandOutput, wantedTool: string | undefined): string {
  const blocks = output.output?.message?.content ?? [];

  if (wantedTool !== undefined) {
    for (const block of blocks) {
      if (block.toolUse?.name === wantedTool && block.toolUse.input !== undefined) {
        return JSON.stringify(block.toolUse.input);
      }
    }
  }

  return blocks
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

export class BedrockClient {
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly options: BedrockOptions) {
    this.client = new BedrockRuntimeClient({
      region: options.region,
      // Retries are the pipeline's, in `withRetries`, so that a throttle is recorded as a
      // processing issue with the backoff the plan asks for rather than being smoothed
      // over silently inside the SDK.
      maxAttempts: 1,
      /**
       * Three ways in, in the order of how explicit they are.
       *
       * A bearer token is its own auth scheme rather than a credential the signer can
       * use, so it has to be selected as well as supplied — the SDK otherwise prefers
       * SigV4 and signs with credentials that are not there. Falling through both leaves
       * the default chain to find a profile, environment credentials or an instance role.
       */
      ...(options.bearerToken !== undefined
        ? {
            token: { token: options.bearerToken },
            authSchemePreference: ['httpBearerAuth'],
          }
        : options.accessKeyId !== undefined && options.secretAccessKey !== undefined
          ? {
              credentials: {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
                ...(options.sessionToken !== undefined ? { sessionToken: options.sessionToken } : {}),
              },
            }
          : {}),
    });
  }

  get model(): string {
    return this.options.modelId;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return withRetries(this.options.maxRetries, () => this.send(request));
  }

  private async send(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const { system, conversation } = splitMessages(request.messages);

    if (conversation.length === 0) {
      throw new ModelError('a Converse request needs at least one non-system message', 'invalid_request', false);
    }

    const command = new ConverseCommand({
      modelId: this.options.modelId,
      messages: conversation,
      ...(system.length > 0 ? { system } : {}),
      inferenceConfig: {
        maxTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0,
      },
      ...(request.schema !== undefined
        ? {
            toolConfig: {
              tools: [
                {
                  toolSpec: {
                    name: request.schema.name,
                    description: `Return the result as ${request.schema.name}.`,
                    // Smithy types the tool schema as a document, which is a recursive
                    // JSON value rather than an object. A JSON Schema satisfies that at
                    // runtime; the cast is the type system's gap, not a shape mismatch.
                    inputSchema: { json: request.schema.schema as DocumentType },
                  },
                },
              ],
              // Required, not auto: the caller asked for a shape, so a prose answer is
              // not an acceptable alternative to calling the tool.
              toolChoice: { tool: { name: request.schema.name } },
            },
          }
        : {}),
    });

    let output: ConverseCommandOutput;
    try {
      output = await this.client.send(command, {
        // Closes the socket rather than leaving it open behind a resolved promise.
        abortSignal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw classify(error);
    }

    const text = readReply(output, request.schema?.name);

    if (text.trim() === '') {
      // An empty completion is a failure to answer, not an answer. Passing it on would
      // look like a document with no facts.
      throw new ModelError(
        `empty completion (stopReason: ${output.stopReason ?? 'none'})`,
        'empty_completion',
        true,
      );
    }

    return {
      text,
      servedByModel: this.options.modelId,
      promptTokens: output.usage?.inputTokens ?? 0,
      completionTokens: output.usage?.outputTokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
