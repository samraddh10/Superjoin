/**
 * The Phase 2 endpoints, driven through Fastify's own injection so the multipart parsing,
 * status codes and JSON bodies are all real.
 *
 * Uses the live database and queue, because the behaviour worth testing here — 202 rather
 * than 201, per-file results, a duplicate reported instead of reprocessed — only means
 * anything against real ingestion.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@superjoin/config';
import { processingRuns } from '@superjoin/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, type Server } from '../server.ts';

const THREE_PAGES = 'tests/fixtures/three-blank-pages.pdf';
const ENCRYPTED = 'tests/fixtures/encrypted.pdf';

const baseConfig = loadConfig();
const reachable = await (async () => {
  const { createDatabase, closeDatabase } = await import('@superjoin/db');
  const handle = createDatabase(baseConfig.databaseUrl);
  const ok = await handle.pool
    .query('select 1')
    .then(() => true)
    .catch(() => false);
  await closeDatabase(handle);
  return ok;
})();

let server: Server;
let storageDir: string;

beforeAll(async () => {
  if (!reachable) return;
  storageDir = await mkdtemp(join(tmpdir(), 'superjoin-api-'));
  server = await buildServer({ ...baseConfig, storageDir, port: 0 }, { logger: false });
  await server.app.ready();
}, 60_000);

afterAll(async () => {
  if (!reachable) return;
  await server.close();
  await rm(storageDir, { recursive: true, force: true });
});

/** Builds a multipart body by hand, so the test exercises real parsing rather than a helper. */
function multipartBody(files: { field: string; filename: string; content: Uint8Array }[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----superjoin${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];

  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          'Content-Type: application/pdf\r\n\r\n',
      ),
      Buffer.from(file.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function uniquePdf(source = THREE_PAGES): Promise<Uint8Array> {
  const original = new Uint8Array(await readFile(source));
  const marker = new TextEncoder().encode(`\n% ${randomUUID()}\n`);
  const combined = new Uint8Array(original.byteLength + marker.byteLength);
  combined.set(original, 0);
  combined.set(marker, original.byteLength);
  return combined;
}

async function newCollection(name = `api-${randomUUID()}`): Promise<string> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/collections',
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe.skipIf(!reachable)('collection endpoints', () => {
  it('creates a collection and rejects an empty name', async () => {
    const id = await newCollection();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const bad = await server.app.inject({
      method: 'POST',
      url: '/collections',
      payload: { name: '   ' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('404s an upload to a collection that does not exist', async () => {
    const body = multipartBody([
      { field: 'file', filename: 'a.pdf', content: await uniquePdf() },
    ]);
    const response = await server.app.inject({
      method: 'POST',
      url: `/collections/${randomUUID()}/documents`,
      ...body,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('collection_not_found');
  });
});

describe.skipIf(!reachable)('uploading documents', () => {
  it('accepts a PDF with 202 and returns a run id', async () => {
    const collectionId = await newCollection();
    const body = multipartBody([
      { field: 'file', filename: 'deck.pdf', content: await uniquePdf() },
    ]);

    const response = await server.app.inject({
      method: 'POST',
      url: `/collections/${collectionId}/documents`,
      ...body,
    });

    // 202, not 201: the document is queued and nothing has been processed yet.
    expect(response.statusCode).toBe(202);
    const payload = response.json();
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].status).toBe('accepted');
    expect(payload.results[0].runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.results[0].pageCount).toBe(3);
  });

  it('reports each file separately when one request mixes outcomes', async () => {
    const collectionId = await newCollection();
    const shared = await uniquePdf();

    // The same bytes twice plus an encrypted file: accepted, duplicate, rejected, in one
    // request. A single status for the batch would hide which file was which.
    const body = multipartBody([
      { field: 'a', filename: 'first.pdf', content: shared },
      { field: 'b', filename: 'again.pdf', content: shared },
      { field: 'c', filename: 'locked.pdf', content: new Uint8Array(await readFile(ENCRYPTED)) },
    ]);

    const response = await server.app.inject({
      method: 'POST',
      url: `/collections/${collectionId}/documents`,
      ...body,
    });

    expect(response.statusCode).toBe(202);
    const statuses = response.json().results.map((r: { status: string }) => r.status);
    expect(statuses).toEqual(['accepted', 'duplicate', 'rejected']);

    const rejected = response.json().results[2];
    expect(rejected.reason).toBe('encrypted');
    expect(rejected.filename).toBe('locked.pdf');
  });

  it('refuses a non-multipart upload with 415', async () => {
    const collectionId = await newCollection();
    const response = await server.app.inject({
      method: 'POST',
      url: `/collections/${collectionId}/documents`,
      payload: { not: 'a file' },
    });
    expect(response.statusCode).toBe(415);
  });
});

describe.skipIf(!reachable)('run status', () => {
  it('reports a queued run with its progress counters', async () => {
    const collectionId = await newCollection();
    const body = multipartBody([
      { field: 'file', filename: 'deck.pdf', content: await uniquePdf() },
    ]);
    const upload = await server.app.inject({
      method: 'POST',
      url: `/collections/${collectionId}/documents`,
      ...body,
    });
    const runId = upload.json().results[0].runId as string;

    const response = await server.app.inject({ method: 'GET', url: `/runs/${runId}` });
    expect(response.statusCode).toBe(200);

    const status = response.json();
    expect(status.stage).toBe('queued');
    expect(status.terminal).toBe(false);
    // Queued is not stalled: nothing has picked it up yet, which is normal.
    expect(status.stalled).toBe(false);
    expect(status.filename).toBe('deck.pdf');
    expect(status.progress.pagesTotal).toBe(3);
    expect(status.progress.pagesProcessed).toBe(0);
    expect(status.issues).toEqual([]);
  });

  it('404s an unknown run', async () => {
    const response = await server.app.inject({ method: 'GET', url: `/runs/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to retry a run that is still queued', async () => {
    const collectionId = await newCollection();
    const body = multipartBody([
      { field: 'file', filename: 'deck.pdf', content: await uniquePdf() },
    ]);
    const upload = await server.app.inject({
      method: 'POST',
      url: `/collections/${collectionId}/documents`,
      ...body,
    });
    const runId = upload.json().results[0].runId as string;

    // Re-queueing live work would put two workers on one document.
    const response = await server.app.inject({ method: 'POST', url: `/runs/${runId}/retry` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('run_in_progress');
  });
});

describe.skipIf(!reachable)('retrying only some stages', () => {
  it('accepts a stage subset and reports it back', async () => {
    const collectionId = await newCollection();
    const body = multipartBody([
      { field: 'file', filename: 'deck.pdf', content: await uniquePdf() },
    ]);
    const upload = await server.app.inject({
      method: 'POST',
      url: `/collections/${collectionId}/documents`,
      ...body,
    });
    const runId = upload.json().results[0].runId as string;

    // The run has to have stopped before a retry is allowed, whole or partial.
    await server.database.db
      .update(processingRuns)
      .set({ stage: 'completed_with_issues' })
      .where(eq(processingRuns.id, runId));

    const response = await server.app.inject({
      method: 'POST',
      url: `/runs/${runId}/retry?stages=comparing`,
    });

    expect(response.statusCode).toBe(202);
    // Extraction has already spent the model quota by the time comparison is reached, so
    // re-running everything to get relationships spends it again on claims that are
    // already stored. Naming the stage is what makes comparison the thing it is spent on.
    expect(response.json().stages).toEqual(['comparing']);
  });

  it('refuses a stages parameter that names nothing', async () => {
    const collectionId = await newCollection();
    const body = multipartBody([
      { field: 'file', filename: 'deck.pdf', content: await uniquePdf() },
    ]);
    const upload = await server.app.inject({
      method: 'POST',
      url: `/collections/${collectionId}/documents`,
      ...body,
    });
    const runId = upload.json().results[0].runId as string;

    const response = await server.app.inject({
      method: 'POST',
      url: `/runs/${runId}/retry?stages=`,
    });
    expect(response.statusCode).toBe(400);
  });
});
