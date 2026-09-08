/**
 * The browser's view of the API.
 *
 * Every response is parsed with the shared Zod contract before it is returned. The
 * schemas already exist and the API validates against them, so re-parsing here costs
 * little and turns a backend shape change into an error naming the field, rather than an
 * undefined halfway down a component tree.
 *
 * Same origin in both modes: Vite proxies the API prefixes in development, and the built
 * assets are served beside the API. So there is no base URL to configure and no CORS
 * policy that could be correct in one environment and permissive in the other.
 */

import {
  collectionSchema,
  documentListSchema,
  factDetailSchema,
  factListSchema,
  relationshipDetailSchema,
  relationshipListSchema,
  runStatusSchema,
  uploadResponseSchema,
  type CollectionResponse,
  type DocumentList,
  type FactDetail,
  type FactList,
  type RelationshipDetail,
  type RelationshipList,
  type RunStatus,
  type UploadResponse,
} from '@superjoin/contracts';
import { z } from 'zod';

/**
 * An error carrying the API's own reason.
 *
 * The endpoints distinguish cases the interface has to tell apart — a missing file is 410
 * and not 404, a run still in progress is 409 — so the code and the machine-readable
 * `error` field are kept rather than flattened into a message.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const errorBodySchema = z.object({ error: z.string(), message: z.string() });

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const parsed = errorBodySchema.safeParse(body);
    throw new ApiError(
      response.status,
      parsed.success ? parsed.data.error : 'unexpected_error',
      parsed.success ? parsed.data.message : `${response.status} ${response.statusText}`,
    );
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      'invalid_response',
      `the API returned a shape this build does not understand: ${parsed.error.issues[0]?.path.join('.')}`,
    );
  }
  return parsed.data;
}

/** Drops undefined entries, so an unset filter is absent rather than the string "undefined". */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export function listCollections(): Promise<CollectionResponse[]> {
  return request('/collections', z.array(collectionSchema));
}

export function createCollection(name: string): Promise<CollectionResponse> {
  return request('/collections', collectionSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

/**
 * Uploads PDFs.
 *
 * FormData rather than a JSON body, and no content-type header: the browser sets the
 * multipart boundary itself, and setting the header by hand omits it and breaks parsing.
 */
export function uploadDocuments(
  collectionId: string,
  files: readonly File[],
): Promise<UploadResponse> {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);

  return request(`/collections/${collectionId}/documents`, uploadResponseSchema, {
    method: 'POST',
    body: form,
  });
}

export function listDocuments(collectionId: string): Promise<DocumentList> {
  return request(`/collections/${collectionId}/documents`, documentListSchema);
}

export function getRun(runId: string): Promise<RunStatus> {
  return request(`/runs/${runId}`, runStatusSchema);
}

export function retryRun(runId: string): Promise<unknown> {
  return request(`/runs/${runId}/retry`, z.unknown(), { method: 'POST' });
}

export interface FactFilters {
  readonly documentId?: string | undefined;
  readonly predicate?: string | undefined;
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export function listFacts(collectionId: string, filters: FactFilters = {}): Promise<FactList> {
  return request(`/collections/${collectionId}/facts${query({ ...filters })}`, factListSchema);
}

export function getFact(factId: string): Promise<FactDetail> {
  return request(`/facts/${factId}`, factDetailSchema);
}

export interface RelationshipFilters {
  readonly label?: string | undefined;
  readonly claimId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export function listRelationships(
  collectionId: string,
  filters: RelationshipFilters = {},
): Promise<RelationshipList> {
  return request(
    `/collections/${collectionId}/relationships${query({ ...filters })}`,
    relationshipListSchema,
  );
}

export function getRelationship(relationshipId: string): Promise<RelationshipDetail> {
  return request(`/relationships/${relationshipId}`, relationshipDetailSchema);
}

/** The URL PDF.js loads. Not fetched here: the viewer streams it itself. */
export function documentFileUrl(documentId: string): string {
  return `/documents/${documentId}/file`;
}

/**
 * The inference provider toggle.
 *
 * `configured` is reported separately from `activeProvider` so the header can show a
 * provider this deployment cannot reach without offering it: a switch that produces a
 * run failing on its first model call is worse than a disabled control that says why.
 */
const settingsSchema = z.object({
  activeProvider: z.enum(['bedrock', 'groq']),
  providers: z.array(
    z.object({
      id: z.enum(['bedrock', 'groq']),
      configured: z.boolean(),
      model: z.string().nullable(),
    }),
  ),
});

export type SettingsResponse = z.infer<typeof settingsSchema>;
export type ProviderId = SettingsResponse['activeProvider'];

export function readSettings(): Promise<SettingsResponse> {
  return request('/settings', settingsSchema);
}

export function setProvider(provider: ProviderId): Promise<SettingsResponse> {
  return request('/settings', settingsSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
}
