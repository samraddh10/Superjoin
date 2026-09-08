/**
 * Server-only configuration.
 *
 * Every value the plan names in section 1.3, resolved once and validated eagerly so a
 * misconfiguration fails at startup rather than part-way through a document. The plan
 * calls these "proposed initial values, to tune after measurement", so each default is
 * stated here and nowhere else; nothing downstream may hard-code one.
 *
 * This package is imported by the API and the worker only. It reads credentials, so it
 * must never be pulled into the web bundle.
 */

export { loadDotEnvFile, type DotEnvResult } from './dotenv.ts';

export {
  loadConfig,
  requireModelAccess,
  ConfigError,
  type Config,
} from './load.ts';
