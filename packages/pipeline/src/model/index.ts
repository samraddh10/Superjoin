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

import type { Database, ModelProvider } from '@superjoin/db';

import { BedrockClient } from './bedrock.ts';
import { GroqClient } from './groq.ts';
import { SwitchingClient, type ProviderEntry } from './switching.ts';
import { ModelError, type CompletionRequest, type CompletionResult } from './types.ts';

export { BedrockClient, type BedrockOptions } from './bedrock.ts';
export { GroqClient, type GroqOptions } from './groq.ts';
export { SwitchingClient, type SwitchingClientOptions, type ProviderEntry } from './switching.ts';

export {
  ModelError,
  extractJson,
  imageContentPart,
  withRetries,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
} from './types.ts';

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
    // The interface rather than a concrete client: what this class adds is recording,
    // and it has no reason to know which provider answered.
    private readonly inner: { readonly model: string; complete(request: CompletionRequest): Promise<CompletionResult> },
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
        `no saved output for this request (${fingerprint.slice(0, 12)}). Set AWS_REGION to run live against Bedrock, or process a document that has recorded output.`,
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
  readonly awsRegion: string | undefined;
  readonly awsBearerToken: string | undefined;
  readonly awsAccessKeyId: string | undefined;
  readonly awsSecretAccessKey: string | undefined;
  readonly awsSessionToken: string | undefined;
  readonly bedrockModelId: string;
  readonly groqApiKey: string | undefined;
  readonly groqBaseUrl: string;
  readonly groqModel: string;
  readonly llmTimeoutMs: number;
  readonly providerMaxRetries: number;
}

/**
 * Which providers the environment can actually reach.
 *
 * Reported so the interface can show a toggle that reflects reality — offering a switch
 * to a provider with no credentials would produce a run that fails on its first call.
 */
export function configuredProviders(config: ModelClientConfig): ModelProvider[] {
  const available: ModelProvider[] = [];
  if (config.awsRegion !== undefined) available.push('bedrock');
  if (config.groqApiKey !== undefined) available.push('groq');
  return available;
}

/**
 * Builds the provider the configuration calls for.
 *
 * The mode is derived from whether a key is present, never set independently, so the two
 * cannot disagree about whether this run reached the network.
 */
export function createModelClient(
  config: ModelClientConfig,
  cacheDir: string,
  /**
   * Passed by the worker so the active provider can be read per call. Omitted by callers
   * that only need one provider — the API, and the evaluation harness — which then get
   * whichever the environment configured.
   */
  db?: Database,
): CompletionProvider {
  const available = configuredProviders(config);

  if (config.modelMode === 'saved-output' || available.length === 0) {
    return new SavedOutputClient(config.bedrockModelId, cacheDir);
  }

  const providers: Partial<Record<ModelProvider, ProviderEntry>> = {};

  if (config.awsRegion !== undefined) {
    providers.bedrock = new BedrockClient({
      modelId: config.bedrockModelId,
      region: config.awsRegion,
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.providerMaxRetries,
      // Passed through only when set; otherwise the SDK's default chain resolves a
      // profile, environment credentials, or an instance role on its own.
      ...(config.awsBearerToken !== undefined ? { bearerToken: config.awsBearerToken } : {}),
      ...(config.awsAccessKeyId !== undefined ? { accessKeyId: config.awsAccessKeyId } : {}),
      ...(config.awsSecretAccessKey !== undefined ? { secretAccessKey: config.awsSecretAccessKey } : {}),
      ...(config.awsSessionToken !== undefined ? { sessionToken: config.awsSessionToken } : {}),
    });
  }

  if (config.groqApiKey !== undefined) {
    providers.groq = new GroqClient({
      apiKey: config.groqApiKey,
      baseUrl: config.groqBaseUrl,
      model: config.groqModel,
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.providerMaxRetries,
    });
  }

  const fallback = available[0] as ModelProvider;

  /**
   * Only the worker gets the switch.
   *
   * Without a database handle there is nowhere to read the toggle from, so the single
   * configured provider is used directly rather than pretending a switch exists.
   */
  const inner: ProviderEntry =
    db !== undefined
      ? new SwitchingClient({ db, providers, fallback })
      : (providers[fallback] as ProviderEntry);

  return new RecordingClient(inner, cacheDir);
}
