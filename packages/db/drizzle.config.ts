import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit reads this to generate and apply SQL migrations.
 *
 * Migrations are generated, reviewed and committed as SQL, per the plan's migration row:
 * they are not applied by pushing the schema at a live database. `drizzle-kit push` stays
 * available for throwaway local iteration only.
 *
 * pg-boss owns its own schema in this same database and upgrades it itself, so it is
 * deliberately outside these migrations.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://superjoin:superjoin@localhost:55432/superjoin',
  },
  // Surfaces what a migration will do before it is committed.
  verbose: true,
  strict: true,
});
