/**
 * The provider switch, resolved per call rather than per process.
 *
 * The toggle lives in the interface header, but inference happens in the worker, and the
 * worker builds its client once at boot. Reading the setting inside `complete` is what
 * lets a person change providers mid-collection without a restart: the next model call
 * picks up the change, and the documents already extracted keep the provider they were
 * extracted with, which `processing_runs.model_name` records per run.
 *
 * The setting is read through a short-lived cache. A database round trip before every
 * model call would be wasted work against a value that changes perhaps twice a day, and
 * a stale window of a couple of seconds is invisible next to a completion that takes one
 * to forty. What it must not do is cache forever, which would be a restart by another
 * name.
 *
 * A provider that has no credentials configured is not offered. Failing here with a clear
 * message beats sending a request that returns an opaque authentication error, and it
 * means the interface can grey out a toggle the environment cannot honour.
 */

import { appSettings, type Database, type ModelProvider } from '@superjoin/db';

import { ModelError, type CompletionRequest, type CompletionResult } from './types.ts';

/** How long a resolved provider is reused before the setting is read again. */
const CACHE_TTL_MS = 3_000;

export interface ProviderEntry {
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface SwitchingClientOptions {
  readonly db: Database;
  /** Only the providers the environment actually has credentials for. */
  readonly providers: Partial<Record<ModelProvider, ProviderEntry>>;
  /** Used when the settings row names a provider that is not configured. */
  readonly fallback: ModelProvider;
}

export class SwitchingClient {
  private cachedProvider: ModelProvider | undefined;
  private cachedAt = 0;

  constructor(private readonly options: SwitchingClientOptions) {}

  /**
   * The model of whichever provider is active right now.
   *
   * Reported from the last resolved provider rather than read fresh, because this is used
   * for logging and for the run's `model_name`, and neither is worth a query.
   */
  get model(): string {
    const active = this.cachedProvider ?? this.options.fallback;
    return this.options.providers[active]?.model ?? `${active} (not configured)`;
  }

  async activeProvider(): Promise<ModelProvider> {
    const now = Date.now();
    if (this.cachedProvider !== undefined && now - this.cachedAt < CACHE_TTL_MS) {
      return this.cachedProvider;
    }

    let selected: ModelProvider = this.options.fallback;
    try {
      const [row] = await this.options.db.select().from(appSettings).limit(1);
      if (row !== undefined) selected = row.activeProvider as ModelProvider;
    } catch {
      // A settings read that fails must not take the run down with it. The fallback is
      // the provider the environment was configured with, which is the safe answer.
    }

    if (this.options.providers[selected] === undefined) selected = this.options.fallback;

    this.cachedProvider = selected;
    this.cachedAt = now;
    return selected;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const provider = await this.activeProvider();
    const client = this.options.providers[provider];

    if (client === undefined) {
      throw new ModelError(
        `no credentials configured for ${provider}; set them in .env and restart the worker`,
        'provider_not_configured',
        false,
      );
    }

    return client.complete(request);
  }
}
