/**
 * The predicate registry.
 *
 * This exists because of a measured failure, and the tests are written against it: left to
 * itself, extraction produced 1,053 distinct predicates from 1,991 claims — `revenue`,
 * `revenue_amount`, `total_revenues` and `total_revenue_from_customers` all recorded
 * separately — and only two (entity, predicate) combinations appeared in more than one
 * document. Cross-document retrieval had nothing to match on, so corroboration could not
 * be reached at all.
 *
 * What the registry must do, therefore, is keep one measure to one name while still
 * letting a genuinely new kind of fact in, since plan 1.2 requires that to be data rather
 * than a migration.
 */

import { randomUUID } from 'node:crypto';

import {
  closeDatabase,
  collections,
  createDatabase,
  predicateRegistry,
  type DatabaseHandle,
} from '@superjoin/db';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { canonicalFor, loadRegistry, registerPredicates, renderRegistry } from './registry.ts';

const connectionString =
  process.env['DATABASE_URL'] ?? 'postgres://superjoin:superjoin@localhost:55432/superjoin';

const database: DatabaseHandle = createDatabase(connectionString);
const reachable = await database.pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

if (!reachable) await closeDatabase(database);
afterAll(async () => {
  if (reachable) await closeDatabase(database);
});

async function seedCollection(): Promise<string> {
  const [row] = await database.db
    .insert(collections)
    .values({ name: `registry-${randomUUID()}` })
    .returning({ id: collections.id });
  return row!.id;
}

describe('rendering the vocabulary for a prompt', () => {
  it('says nothing when the collection has no vocabulary yet', () => {
    // The first document in a collection has nothing to reuse and is the one that
    // establishes the names; an empty list must not become an empty instruction.
    expect(renderRegistry([])).toBe('');
  });

  it('carries the description and unit, which are what let a name be judged', () => {
    const rendered = renderRegistry([
      {
        canonicalName: 'revenue_from_operations',
        description: 'income from the core business',
        aliases: [],
        unitHint: 'INR crore',
      },
    ]);
    expect(rendered).toContain('revenue_from_operations');
    expect(rendered).toContain('income from the core business');
    expect(rendered).toContain('INR crore');
  });

  it('is bounded, because it is prepended to every extraction call', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      canonicalName: `predicate_${i}`,
      description: null,
      aliases: [],
      unitHint: null,
    }));
    expect(renderRegistry(many, 60).split('\n')).toHaveLength(60);
  });
});

describe('resolving a name against the registry', () => {
  const entries = [
    {
      canonicalName: 'revenue_from_operations',
      description: null,
      aliases: ['total_revenues'],
      unitHint: null,
    },
  ];

  it('finds a canonical name', () => {
    expect(canonicalFor('revenue_from_operations', entries)).toBe('revenue_from_operations');
  });

  it('follows an alias', () => {
    expect(canonicalFor('total_revenues', entries)).toBe('revenue_from_operations');
  });

  it('does not resolve a name that merely looks similar', () => {
    // Merging `revenue` into `revenue_from_operations` because they share a word is the
    // conflation plan 5.3 forbids. Retrieval widens across related names on its own; it
    // does not need the stored claim rewritten to do it.
    expect(canonicalFor('revenue', entries)).toBeNull();
    expect(canonicalFor('total_income', entries)).toBeNull();
  });
});

describe.skipIf(!reachable)('growing the vocabulary', () => {
  it('adds a name the collection has not seen', async () => {
    const collectionId = await seedCollection();
    const result = await registerPredicates(database.db, collectionId, [
      { name: 'revenue_from_operations', unit: 'INR' },
    ]);

    // Stored normalized, which folds the plural: revenue_from_operations -> ..._operation.
    expect(result.added).toEqual(['revenue_from_operation']);
    const entries = await loadRegistry(database.db, collectionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.unitHint).toBe('INR');
  });

  it('does not merge a variant on its own, because the merge could be wrong', async () => {
    const collectionId = await seedCollection();
    await registerPredicates(database.db, collectionId, [{ name: 'revenue' }]);

    // Head-term aliasing was tried here and removed. `revenue` and `revenue_growth` share
    // a head and are a level and a rate, so automatic folding would manufacture agreement
    // between two different measures — worse than the sprawl it was meant to cure.
    const result = await registerPredicates(database.db, collectionId, [
      { name: 'revenue_growth' },
    ]);

    expect(result.added).toEqual(['revenue_growth']);
    expect(await loadRegistry(database.db, collectionId)).toHaveLength(2);
  });

  it('follows an alias a reviewer has recorded', async () => {
    const collectionId = await seedCollection();
    await registerPredicates(database.db, collectionId, [{ name: 'revenue' }]);

    // Aliases are for a judgement someone made, not one the system guessed.
    await database.db
      .update(predicateRegistry)
      .set({ aliases: ['total_revenues'] })
      .where(eq(predicateRegistry.collectionId, collectionId));

    const entries = await loadRegistry(database.db, collectionId);
    expect(canonicalFor('total_revenues', entries)).toBe('revenue');

    // And a name already covered by an alias is not added again.
    const result = await registerPredicates(database.db, collectionId, [
      { name: 'total_revenues' },
    ]);
    expect(result.added).toEqual([]);
  });

  it('still admits a genuinely new kind of fact', async () => {
    const collectionId = await seedCollection();
    await registerPredicates(database.db, collectionId, [{ name: 'revenue' }]);

    // Plan 1.2 requires a new fact type to be data rather than a migration, so the
    // registry must not become a closed schema by the back door.
    const result = await registerPredicates(database.db, collectionId, [
      { name: 'board_role' },
      { name: 'registered_office_address' },
    ]);

    expect(result.added.sort()).toEqual(['board_role', 'registered_office_address']);
    expect(await loadRegistry(database.db, collectionId)).toHaveLength(3);
  });

  it('is idempotent, so re-extracting a document does not grow it', async () => {
    const collectionId = await seedCollection();
    const names = [{ name: 'revenue' }, { name: 'ebitda' }];

    await registerPredicates(database.db, collectionId, names);
    const second = await registerPredicates(database.db, collectionId, names);

    expect(second.added).toEqual([]);
    expect(second.aliased).toEqual([]);
    expect(await loadRegistry(database.db, collectionId)).toHaveLength(2);
  });

  it('keeps two collections vocabularies apart', async () => {
    const a = await seedCollection();
    const b = await seedCollection();

    await registerPredicates(database.db, a, [{ name: 'revenue' }]);
    // A collection is the comparison boundary, so two unrelated datasets must not teach
    // each other vocabulary.
    expect(await loadRegistry(database.db, b)).toHaveLength(0);
  });
});
