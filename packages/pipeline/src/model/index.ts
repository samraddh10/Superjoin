/**
 * Model access, in whichever mode the environment allows.
 *
 * Plan section 11.1 asks for enough sample output that the system can be evaluated
 * without an API key, clearly distinguished from live processing. That is served here
 * rather than by a flag threaded through every call site: callers ask for a completion
 * and are told, in the result, which mode answered.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ModelError,
  OpenRouterClient,
  type CompletionRequest,
  type CompletionResult,
} from './openrouter.ts';

export {
  ModelError,
  OpenRouterClient,
  extractJson,
  imageContentPart,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
} from './openrouter.ts';

export type ModelMode = 'live' | 'saved-output';

export interface CompletionProvider {
  readonly mode: ModelMode;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * A stable key for one request.
 *
 * Hashing the full request, including the image parts, means a replay is only served for
 * a genuinely identical call. A looser key would quietly answer a new question with an
 * old answer, which is exactly the kind of falsely successful output the plan warns
 * against elsewhere.
 */
export function requestFingerprint(model: string, request: CompletionRequest): string {
  const canonical = JSON.stringify({
    model,
    messages: request.messages,
    schema: request.schema?.name ?? null,
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
    seed: request.seed ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** A live client that also writes every response into the replay store. */
export class RecordingClient implements CompletionProvider {
  readonly mode: ModelMode = 'live';

  constructor(
    private readonly inner: OpenRouterClient,
    private readonly cacheDir: string,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const result = await this.inner.complete(request);
    const path = cachePath(this.cacheDir, requestFingerprint(this.inner.model, request));

    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(result, null, 2), 'utf8');
    } catch {
      // Recording is a convenience for the no-key path. Failing to record must not fail
      // a completion the caller already has.
    }

    return result;
  }
}

/**
 * Replays recorded responses. Never reaches the network.
 *
 * A miss is an error rather than a silent empty answer: a run that quietly produced
 * nothing because a recording was absent would look like a document with no facts.
 */
export class SavedOutputClient implements CompletionProvider {
  readonly mode: ModelMode = 'saved-output';

  constructor(
    readonly model: string,
    private readonly cacheDir: string,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const fingerprint = requestFingerprint(this.model, request);

    let raw: string;
    try {
      raw = await readFile(cachePath(this.cacheDir, fingerprint), 'utf8');
    } catch {
      throw new ModelError(
        `no saved output for this request (${fingerprint.slice(0, 12)}). Set OPENROUTER_API_KEY to run live, or process a document that has recorded output.`,
        'saved_output_missing',
        false,
      );
    }

    return JSON.parse(raw) as CompletionResult;
  }
}

function cachePath(cacheDir: string, fingerprint: string): string {
  return join(cacheDir, fingerprint.slice(0, 2), `${fingerprint}.json`);
}

export interface ModelClientConfig {
  readonly modelMode: ModelMode;
  readonly openRouterApiKey: string | undefined;
  readonly openRouterBaseUrl: string;
  readonly llmModel: string;
  readonly llmTimeoutMs: number;
  readonly providerMaxRetries: number;
}

/**
 * Builds the provider the configuration calls for.
 *
 * The mode is derived from whether a key is present, never set independently, so the two
 * cannot disagree about whether this run reached the network.
 */
export function createModelClient(config: ModelClientConfig, cacheDir: string): CompletionProvider {
  if (config.modelMode === 'saved-output' || config.openRouterApiKey === undefined) {
    return new SavedOutputClient(config.llmModel, cacheDir);
  }

  return new RecordingClient(
    new OpenRouterClient({
      apiKey: config.openRouterApiKey,
      baseUrl: config.openRouterBaseUrl,
      model: config.llmModel,
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.providerMaxRetries,
      appUrl: 'https://github.com/samraddh10/Superjoin',
      appTitle: 'Superjoin fact knowledge layer',
    }),
    cacheDir,
  );
}
