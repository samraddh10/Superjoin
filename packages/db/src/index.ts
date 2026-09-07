/**
 * Database access for the API and the worker.
 *
 * Server-only: this package opens connections with credentials from the environment and
 * must never be pulled into the web bundle.
 */

export * from './schema/index.ts';
export {
  createDatabase,
  closeDatabase,
  type Database,
  type DatabaseHandle,
} from './client.ts';
