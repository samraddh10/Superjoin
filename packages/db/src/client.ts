/**
 * Connection handling.
 *
 * One pool per process. The API and the worker are separate processes sharing one
 * database, which is what plan section 1.3's exit condition requires.
 */

import { loadConfig } from '@superjoin/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
}

/**
 * Opens a pool and binds the schema to it.
 *
 * NUMERIC columns are left as strings by node-postgres, which is what plan 4.1 needs:
 * parsing them into JavaScript numbers would silently lose precision on exactly the
 * financial values the comparison logic depends on. decimal.js consumes the strings.
 */
export function createDatabase(connectionString?: string): DatabaseHandle {
  const url = connectionString ?? loadConfig().databaseUrl;
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function closeDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.pool.end();
}
