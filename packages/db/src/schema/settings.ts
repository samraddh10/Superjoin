/**
 * Runtime settings a person can change without a restart.
 *
 * There is exactly one row, pinned by a check constraint. That is deliberate: a settings
 * table that can hold two rows eventually holds two rows, and then "which provider is
 * active" has two answers and the worker and the interface can disagree about which one
 * ran.
 *
 * The provider lives here rather than in the environment because the environment is read
 * once at boot, and the toggle in the header has to take effect on the next model call in
 * a worker nobody restarted. What stays in the environment is the credentials — those are
 * secrets, and secrets do not belong in a table the API can read out.
 */

import { jsonb, pgTable, text, timestamp, uuid, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** The providers the pipeline can be pointed at. */
export const MODEL_PROVIDERS = ['bedrock', 'groq'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const appSettings = pgTable(
  'app_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Which provider serves model calls.
     *
     * Text with a check constraint rather than a Postgres enum, because adding a third
     * provider should be a one-line change here and not an `ALTER TYPE` migration that
     * cannot run inside a transaction.
     */
    activeProvider: text('active_provider').notNull().default('bedrock'),
    /**
     * Which providers the worker found credentials for, written by the worker at boot.
     *
     * Published rather than inferred by the API, because only the worker holds the keys.
     * The alternative was giving the API the credentials so it could check them, which
     * would break the service boundary the whole design rests on for the sake of greying
     * out a button.
     */
    availableProviders: jsonb('available_providers').$type<string[]>().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Pins the table to a single row. */
    singleton: text('singleton').notNull().default('singleton'),
  },
  (table) => [
    check('app_settings_provider_known', sql`${table.activeProvider} in ('bedrock', 'groq')`),
    check('app_settings_single_row', sql`${table.singleton} = 'singleton'`),
  ],
);
