/**
 * The inference provider toggle.
 *
 * Read and written here rather than held in the environment, because the worker reads it
 * per model call and a person changes it from the header while a collection is part-way
 * processed. What the API must never do is hand out the credentials themselves: it
 * reports which providers are *configured*, never their keys, and it has no model access
 * of its own.
 *
 * A provider the environment cannot reach is reported but not selectable. Letting someone
 * switch to a provider with no key would produce a run that fails on its first call, with
 * the cause three layers away from the click that caused it.
 */

import { MODEL_PROVIDERS, appSettings, type ModelProvider } from '@superjoin/db';
import type { IngestionContext } from '@superjoin/pipeline';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export interface SettingsRouteDependencies {
  readonly ingestion: IngestionContext;
  /**
   * Model names per provider, for display.
   *
   * Names, never keys. These are the same non-secret strings the worker logs, and the
   * API is given them only so the toggle can say which model a provider would use.
   */
  readonly models: Partial<Record<ModelProvider, string>>;
}

function isProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsRouteDependencies,
): Promise<void> {
  const { db } = deps.ingestion.database;

  /**
   * Reads the single settings row, creating it if the migration's seed is missing.
   *
   * Self-healing rather than erroring, because a settings table with no row is a state
   * the interface cannot render and a person cannot fix from the interface.
   *
   * `available` is what the worker published at boot. An empty list means no worker has
   * started yet rather than that nothing is configured, so the interface shows the
   * toggle disabled rather than claiming the deployment has no model access.
   */
  async function readSettings(): Promise<{
    active: ModelProvider;
    available: readonly ModelProvider[];
  }> {
    const [row] = await db.select().from(appSettings).limit(1);

    if (row === undefined) {
      await db.insert(appSettings).values({}).onConflictDoNothing();
      return { active: 'bedrock', available: [] };
    }

    return {
      active: row.activeProvider as ModelProvider,
      available: (row.availableProviders ?? []).filter(isProvider),
    };
  }

  function render(active: ModelProvider, available: readonly ModelProvider[]) {
    return {
      activeProvider: active,
      providers: MODEL_PROVIDERS.map((id) => ({
        id,
        configured: available.includes(id),
        model: deps.models[id] ?? null,
      })),
    };
  }

  app.get('/settings', async () => {
    const { active, available } = await readSettings();
    return render(active, available);
  });

  app.patch('/settings', async (request, reply) => {
    const body = request.body as { provider?: unknown };

    if (!isProvider(body.provider)) {
      reply.code(400);
      return {
        error: 'invalid_provider',
        message: `provider must be one of ${MODEL_PROVIDERS.join(', ')}`,
      };
    }

    const { available } = await readSettings();

    if (!available.includes(body.provider)) {
      // 409 rather than 400: the request is well-formed, the deployment just cannot
      // honour it. The difference matters to the interface, which greys the option out.
      reply.code(409);
      return {
        error: 'provider_not_configured',
        message: `${body.provider} has no credentials configured on this deployment`,
      };
    }

    const [existing] = await db.select({ id: appSettings.id }).from(appSettings).limit(1);

    if (existing === undefined) {
      await db.insert(appSettings).values({ activeProvider: body.provider });
    } else {
      await db
        .update(appSettings)
        .set({ activeProvider: body.provider, updatedAt: new Date() })
        .where(eq(appSettings.id, existing.id));
    }

    return render(body.provider, available);
  });
}
