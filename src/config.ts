/**
 * Every tunable the system reads from the environment, resolved once and validated
 * eagerly so that a misconfiguration fails at startup rather than mid-pipeline.
 *
 * Nothing here is specific to a collection, a document or an issuer. Acceptance
 * criterion A2 requires that runtime behaviour never key off collection or file names.
 */

/**
 * How the system obtains model responses.
 *
 * `live` calls the model API. `saved-output` replays stored responses so that the
 * system can be evaluated without a paid API key, which acceptance criterion E2
 * requires. The mode is derived from whether a key is present, never guessed, and is
 * surfaced to the interface so that saved output is always labelled as such.
 */
export type ModelMode = 'live' | 'saved-output';

export interface Config {
  /** Postgres connection string. Also used by the migration runner. */
  readonly databaseUrl: string;
  /** Absolute path to the directory holding uploaded PDFs and rendered page images. */
  readonly storageDir: string;
  /** Port for the HTTP API and the web interface. */
  readonly port: number;
  /** Resolved from the presence of a model API key. */
  readonly modelMode: ModelMode;
  /** Present only when `modelMode` is `live`. */
  readonly geminiApiKey: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const DEFAULTS = {
  databaseUrl: 'postgres://superjoin:superjoin@localhost:5432/superjoin',
  storageDir: './storage',
  port: 3000,
} as const;

/** Trims, and treats an empty or whitespace-only variable as absent. */
function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = read(env, 'PORT');
  if (raw === undefined) return DEFAULTS.port;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * Resolves configuration from an environment, defaulting to `process.env`.
 *
 * Taking the environment as a parameter keeps this testable without mutating global
 * state, which matters because the saved-output branch is exercised by the test suite.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const geminiApiKey = read(env, 'GEMINI_API_KEY');

  return {
    databaseUrl: read(env, 'DATABASE_URL') ?? DEFAULTS.databaseUrl,
    storageDir: read(env, 'STORAGE_DIR') ?? DEFAULTS.storageDir,
    port: readPort(env),
    modelMode: geminiApiKey === undefined ? 'saved-output' : 'live',
    geminiApiKey,
  };
}
