/**
 * Shared API contracts.
 *
 * Zod schemas are the single definition of each shape: Fastify validates against them and
 * TypeScript types are inferred from them, so a route and its type cannot drift apart.
 * Plan section 4.1 reuses the same approach for the extraction contract, where the schema
 * is also sent as a Bedrock tool input schema and the reply re-parsed before it is
 * trusted.
 *
 * Nothing here imports a database client. These types cross the wire and are the only
 * part of the system the web app is allowed to depend on.
 *
 * This file is a barrel and holds no definitions of its own. `export *` is hoisted like
 * any other import, so a module re-exported from here that also imported from here would
 * be evaluated before this file's body and would read its dependency mid-initialisation.
 * Keeping every definition in a leaf module makes that mistake impossible rather than
 * merely avoided by ordering.
 */

export * from './runs.ts';
export * from './uploads.ts';
export * from './review.ts';
