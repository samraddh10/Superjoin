/**
 * Model access.
 *
 * There is one way to obtain a completion: a live call to OpenRouter with a working key.
 * Configuration rejects a missing or empty key before any of this is reached, so nothing
 * here has a degraded path to fall into — a caller that holds a provider holds one that
 * reaches the network, and a provider that cannot answer raises rather than substituting
 * something that merely looks like an answer.
 */

import {
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

export interface CompletionProvider {
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface ModelClientConfig {
  readonly openRouterApiKey: string;
  readonly openRouterBaseUrl: string;
  readonly llmModel: string;
  readonly llmTimeoutMs: number;
  readonly providerMaxRetries: number;
}

/** Builds the live provider. The key is guaranteed present by configuration. */
export function createModelClient(config: ModelClientConfig): CompletionProvider {
  return new OpenRouterClient({
    apiKey: config.openRouterApiKey,
    baseUrl: config.openRouterBaseUrl,
    model: config.llmModel,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.providerMaxRetries,
    appUrl: 'https://github.com/samraddh10/Superjoin',
    appTitle: 'Superjoin fact knowledge layer',
  });
}
