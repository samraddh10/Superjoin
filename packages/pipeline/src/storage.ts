/**
 * Original PDFs and derived parsing artifacts on the shared volume.
 *
 * The API writes uploads here and the worker reads them back; plan section 1.3's exit
 * condition is that both processes reach the same files. Kept in the pipeline package
 * because it is the code both already share, rather than as a package of its own.
 *
 * Storage keys are derived from content hashes, per plan 2.1, so the same bytes always
 * land at the same path and a retried upload overwrites itself rather than accumulating.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export class StorageError extends Error {
  override readonly name = 'StorageError';
}

/** SHA-256 of the bytes, hex. The identity plan 2.1 uses for duplicate detection. */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Path for a document's original bytes.
 *
 * Sharded on the first two hex characters so one directory does not accumulate every
 * document in the system, which matters on the volume long before it matters in Postgres.
 */
export function documentStorageKey(hash: string, extension = '.pdf'): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new StorageError(`expected a hex SHA-256 digest, got ${JSON.stringify(hash)}`);
  }
  return `documents/${hash.slice(0, 2)}/${hash}${extension}`;
}

/** Path for a rendered page image, used by the visual route in plan 3.1. */
export function pageImageStorageKey(hash: string, physicalPage: number, extension = '.png'): string {
  if (!Number.isInteger(physicalPage) || physicalPage < 0) {
    throw new StorageError(`physicalPage must be a non-negative integer, got ${physicalPage}`);
  }
  return `pages/${hash.slice(0, 2)}/${hash}/${String(physicalPage).padStart(4, '0')}${extension}`;
}

/**
 * Resolves a key against the storage root, refusing anything that escapes it.
 *
 * Keys are derived internally today, but uploads are untrusted input and this is the
 * boundary where a traversal would take effect. Checking here means no caller has to
 * remember to.
 */
export function resolvePath(root: string, key: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, key);
  const rel = relative(absoluteRoot, target);

  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
    throw new StorageError(`storage key escapes the storage root: ${JSON.stringify(key)}`);
  }
  return target;
}

export async function ensureStorage(root: string): Promise<void> {
  await mkdir(resolve(root), { recursive: true });
}

/**
 * Writes bytes to a key.
 *
 * Written to a temporary neighbour and renamed, so a crash mid-write cannot leave a
 * truncated PDF at a key the database already believes is complete. Plan 2.1 warns
 * against exactly that: a failure between writing the file and enqueueing work must not
 * leave a falsely successful document.
 */
export async function writeObject(root: string, key: string, bytes: Uint8Array): Promise<string> {
  const target = resolvePath(root, key);
  await mkdir(dirname(target), { recursive: true });

  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw new StorageError(`could not write ${key}: ${(cause as Error).message}`, { cause });
  }
  return target;
}

export async function readObject(root: string, key: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(resolvePath(root, key)));
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw new StorageError(`could not read ${key}: ${(cause as Error).message}`, { cause });
  }
}

export async function objectExists(root: string, key: string): Promise<boolean> {
  try {
    const info = await stat(resolvePath(root, key));
    return info.isFile();
  } catch {
    return false;
  }
}

export interface StorageHealth {
  readonly root: string;
  readonly writable: boolean;
  readonly detail: string | null;
}

/**
 * Confirms the volume is actually usable, by writing and removing a probe file.
 *
 * A directory that exists is not a directory this process can write to: the container
 * may have mounted it read-only or under a different user. Plan 1.3's exit condition is
 * about reaching the files, so the check performs the access rather than assuming it.
 */
export async function checkStorageHealth(root: string): Promise<StorageHealth> {
  const absoluteRoot = resolve(root);
  const probe = join(absoluteRoot, `.health-${process.pid}`);

  try {
    await mkdir(absoluteRoot, { recursive: true });
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    return { root: absoluteRoot, writable: true, detail: null };
  } catch (cause) {
    return { root: absoluteRoot, writable: false, detail: (cause as Error).message };
  }
}
