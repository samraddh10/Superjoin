import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  StorageError,
  checkStorageHealth,
  contentHash,
  documentStorageKey,
  objectExists,
  pageImageStorageKey,
  readObject,
  resolvePath,
  writeObject,
} from './storage.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'superjoin-storage-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const HASH = 'a'.repeat(64);

describe('storage keys', () => {
  it('derives a sharded key from a content hash', () => {
    expect(documentStorageKey(HASH)).toBe(`documents/aa/${HASH}.pdf`);
  });

  it('refuses anything that is not a SHA-256 digest', () => {
    // The key is the document's identity. Accepting a loose string here would let two
    // different documents share a path.
    expect(() => documentStorageKey('not-a-hash')).toThrow(StorageError);
    expect(() => documentStorageKey(HASH.toUpperCase())).toThrow(StorageError);
  });

  it('pads page numbers so page images sort in page order', () => {
    expect(pageImageStorageKey(HASH, 5)).toBe(`pages/aa/${HASH}/0005.png`);
    expect(pageImageStorageKey(HASH, 43)).toBe(`pages/aa/${HASH}/0043.png`);
  });

  it('rejects a negative or fractional page index', () => {
    expect(() => pageImageStorageKey(HASH, -1)).toThrow(StorageError);
    expect(() => pageImageStorageKey(HASH, 1.5)).toThrow(StorageError);
  });

  it('gives the same hash for the same bytes', () => {
    const bytes = new TextEncoder().encode('%PDF-1.7');
    expect(contentHash(bytes)).toBe(contentHash(new TextEncoder().encode('%PDF-1.7')));
    expect(contentHash(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('path resolution', () => {
  it('refuses a key that escapes the storage root', () => {
    // Uploads are untrusted input, and this is the boundary where a traversal would
    // take effect.
    for (const key of ['../outside.pdf', 'documents/../../outside.pdf', '/etc/passwd']) {
      expect(() => resolvePath(root, key), key).toThrow(StorageError);
    }
  });

  it('refuses the root itself as a key', () => {
    expect(() => resolvePath(root, '.')).toThrow(StorageError);
  });

  it('accepts a key inside the root', () => {
    expect(resolvePath(root, 'documents/aa/x.pdf')).toContain('documents');
  });
});

describe('reading and writing', () => {
  it('round-trips bytes through a key', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 fake');
    const key = documentStorageKey(contentHash(bytes));

    await writeObject(root, key, bytes);
    expect(await objectExists(root, key)).toBe(true);
    expect(new TextDecoder().decode(await readObject(root, key))).toBe('%PDF-1.7 fake');
  });

  it('leaves no temporary file behind after a successful write', async () => {
    const bytes = new TextEncoder().encode('durable');
    const key = documentStorageKey(contentHash(bytes));
    const target = await writeObject(root, key, bytes);

    // The write goes to a temporary neighbour and is renamed, so a crash cannot leave a
    // truncated PDF at a key the database already treats as complete.
    expect(await objectExists(root, `${key}.${process.pid}.tmp`)).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('durable');
  });

  it('reports a missing object rather than throwing on the existence check', async () => {
    expect(await objectExists(root, documentStorageKey('b'.repeat(64)))).toBe(false);
  });

  it('throws with the key named when reading something absent', async () => {
    const key = documentStorageKey('c'.repeat(64));
    await expect(readObject(root, key)).rejects.toThrow(StorageError);
  });
});

describe('health', () => {
  it('confirms the volume is writable by writing to it', async () => {
    // A directory that exists is not a directory this process can write to; the probe
    // performs the access rather than assuming it.
    const health = await checkStorageHealth(root);
    expect(health.writable).toBe(true);
    expect(health.detail).toBe(null);
  });

  it('reports why an unusable root is unusable', async () => {
    // A path whose parent is a file cannot become a directory.
    const bytes = new TextEncoder().encode('blocker');
    const key = documentStorageKey(contentHash(bytes));
    const filePath = await writeObject(root, key, bytes);

    const health = await checkStorageHealth(join(filePath, 'nested'));
    expect(health.writable).toBe(false);
    expect(health.detail).toBeTruthy();
  });
});
