/**
 * Model access.
 *
 * There is one way to obtain a completion: a live call to a configured provider. A run
 * that cannot reach one fails; nothing here has a degraded path to fall into, because a
 * replayed answer made a run that never reached a provider indistinguishable from one
 * that did. A provider that cannot answer raises rather than substituting something that
 * merely looks like an answer.
 *
 * Two providers are supported and either is sufficient. Which one answers is a runtime
 * setting rather than an environment variable, so the choice is read per call from the
 * database; see `SwitchingClient`.
 */

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

export interface CompletionProvider {
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface ModelClientConfig {
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
 * Raises when the environment reaches none. The worker demands access at startup through
 * `requireModelAccess`, so this is the second line rather than the first, and it exists
 * because returning a client that cannot call anything is how a run ends up reporting
 * results it never obtained.
 */
export function createModelClient(
  config: ModelClientConfig,
  /**
   * Passed by the worker so the active provider can be read per call. Omitted by callers
   * that only need one provider — the API, and the evaluation harness — which then get
   * whichever the environment configured.
   */
  db?: Database,
): CompletionProvider {
  const available = configuredProviders(config);

  if (available.length === 0) {
    throw new ModelError(
      'no model provider is configured: set AWS_REGION for Bedrock or GROQ_API_KEY for Groq',
      'no_provider_configured',
      false,
    );
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
  return db !== undefined
    ? new SwitchingClient({ db, providers, fallback })
    : (providers[fallback] as ProviderEntry);
}
