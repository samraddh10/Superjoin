/**
 * Loading `.env` into the process environment.
 *
 * Node does not read `.env` on its own, so without this the file the README tells a
 * reviewer to create has no effect and the key it holds is never seen. The worker then
 * refuses to start, which is the intended outcome for a missing key but a confusing one
 * when the key is sitting in a file three lines away.
 *
 * Called explicitly from the API and worker entry points rather than as a side effect of
 * `loadConfig`, so tests that pass an environment object keep getting exactly what they
 * passed. Uses Node's built-in loader; no dependency is needed for this.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DotEnvResult {
  readonly loaded: boolean;
  readonly path: string;
  readonly reason: string | null;
}

/**
 * Loads `.env` from the working directory, or from an explicit path.
 *
 * Absence is not an error. Under Docker Compose the environment is supplied by the
 * orchestrator and no `.env` is present in the image, which is the normal case rather
 * than a misconfiguration.
 *
 * Existing variables win. A value already set in the real environment is deliberate,
 * and a stale file should not override what an operator or Compose has just supplied.
 */
export function loadDotEnvFile(path = '.env'): DotEnvResult {
  const absolute = resolve(path);

  if (!existsSync(absolute)) {
    return { loaded: false, path: absolute, reason: 'no .env file present' };
  }

  const before = new Set(Object.keys(process.env));

  try {
    process.loadEnvFile(absolute);
  } catch (error) {
    return { loaded: false, path: absolute, reason: (error as Error).message };
  }

  // Node's loader overwrites; restoring the pre-existing values keeps the real
  // environment authoritative over the file.
  for (const key of before) {
    const original = originalValues.get(key);
    if (original !== undefined) process.env[key] = original;
  }

  return { loaded: true, path: absolute, reason: null };
}

/** Snapshot taken at import, before any `.env` has had a chance to overwrite it. */
const originalValues = new Map<string, string>(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
