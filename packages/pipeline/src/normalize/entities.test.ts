/**
 * Entity label normalization and fact-group identity.
 *
 * The database-backed half of resolution is exercised by the pipeline integration test;
 * what is worth pinning down here is the rule that decides whether two names are even
 * allowed to merge without a model being asked.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, collections, createDatabase, type DatabaseHandle } from '@superjoin/db';

import { ModelError, type CompletionProvider, type CompletionResult } from '../model/index.ts';
import { isGenericSubject, normalizeEntityLabel, resolveEntity } from './entities.ts';
import { factGroupId } from './stage.ts';

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

async function seedCollection(): Promise<{ collectionId: string }> {
  const [row] = await database.db
    .insert(collections)
    .values({ name: `entities-${randomUUID()}` })
    .returning({ id: collections.id });
  return { collectionId: row!.id };
}

/** Records every subject put to it, so a test can count the calls rather than infer them. */
function stubClient(
  asked: string[],
  verdict: { same: boolean; reason: string },
): CompletionProvider {
  return {
    model: 'stub/adjudicator',
    async complete(request): Promise<CompletionResult> {
      asked.push(JSON.stringify(request.messages).slice(0, 80));
      return {
        text: JSON.stringify(verdict),
        servedByModel: 'stub/adjudicator',
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
      };
    },
  };
}

describe('normalizeEntityLabel', () => {
  it('treats a legal form as spelling', () => {
    // "Delhivery Limited" and "Delhivery Ltd" are one company written two ways.
    expect(normalizeEntityLabel('Delhivery Limited').normalized).toBe('delhivery');
    expect(normalizeEntityLabel('Delhivery Ltd.').normalized).toBe('delhivery');
    expect(normalizeEntityLabel('DELHIVERY PRIVATE LIMITED').normalized).toBe('delhivery');
  });

  it('records what it removed', () => {
    expect(normalizeEntityLabel('Delhivery Private Limited').strippedSuffixes).toEqual([
      'private',
      'limited',
    ]);
  });

  it('keeps a distinguishing word that is not a legal form', () => {
    // The parent-and-subsidiary case from plan 5.3. These must not normalize together;
    // the second is a candidate for adjudication, never an automatic match.
    const parent = normalizeEntityLabel('Delhivery Limited').normalized;
    const subsidiary = normalizeEntityLabel('Delhivery Express Parcel Private Limited').normalized;

    expect(parent).toBe('delhivery');
    expect(subsidiary).toBe('delhivery express parcel');
    expect(parent).not.toBe(subsidiary);
  });

  it('strips suffixes only from the end', () => {
    // "Company" is a legal form at the end and an ordinary word in the middle.
    expect(normalizeEntityLabel('Company Secretary Services Limited').normalized).toBe(
      'company secretary services',
    );
  });

  it('never reduces a name to nothing', () => {
    expect(normalizeEntityLabel('Limited').normalized).toBe('limited');
  });
});

describe('factGroupId', () => {
  it('is the same for the same group key', () => {
    // Determinism is what lets two documents processed separately land in one group
    // without a lookup that could race.
    const a = factGroupId('col', 'ent', 'revenue', '{"period":"FY2024"}');
    const b = factGroupId('col', 'ent', 'revenue', '{"period":"FY2024"}');
    expect(a).toBe(b);
  });

  it('differs when any part of the key differs', () => {
    const base = factGroupId('col', 'ent', 'revenue', '{"period":"FY2024"}');
    expect(factGroupId('col', 'ent', 'revenue', '{"period":"FY2023"}')).not.toBe(base);
    expect(factGroupId('col', 'other', 'revenue', '{"period":"FY2024"}')).not.toBe(base);
    expect(factGroupId('other', 'ent', 'revenue', '{"period":"FY2024"}')).not.toBe(base);
  });

  it('is a well-formed version 5 UUID', () => {
    expect(factGroupId('col', 'ent', 'revenue', '{}')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

/**
 * How many questions one subject may ask the adjudicator.
 *
 * The cap is a performance property with a correctness edge, so it is pinned here. Each
 * candidate is a sequential model call, and on a rate-limited free tier each can sit in
 * retry backoff for tens of seconds. Asking about three tripled that for a subject where
 * the first answer is the informative one, because candidates arrive ordered by lexical
 * closeness — the second and third are the least likely to be the same entity.
 *
 * Observed before the cap: a prospectus naming 146 distinct subjects normalized at about
 * one claim every 45 seconds, hours for a single document.
 */
describe.skipIf(!reachable)('adjudication budget', () => {
  it('asks about one candidate by default, not three', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: false, reason: 'different companies' });

    // Three lexically similar names already exist, so all three are candidates.
    for (const name of ['Acme Logistics Alpha', 'Acme Logistics Beta', 'Acme Logistics Gamma']) {
      await resolveEntity(database.db, { collectionId, subject: name });
    }

    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Acme Logistics Delta',
      client,
    });

    expect(asked).toHaveLength(1);
    expect(resolution.adjudications).toBe(1);
    // Nothing was confirmed, so the subject stays its own entity, per plan 5.3.
    expect(resolution.method).toBe('created');
  });

  it('honours a larger budget when one is given', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: false, reason: 'different companies' });

    for (const name of ['Beta Freight One', 'Beta Freight Two', 'Beta Freight Three']) {
      await resolveEntity(database.db, { collectionId, subject: name });
    }

    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Beta Freight Four',
      client,
      maxAdjudications: 3,
    });

    expect(asked.length).toBeGreaterThan(1);
    expect(resolution.adjudications).toBe(asked.length);
  });

  it('asks nothing when the budget is zero, and still resolves', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: true, reason: 'the same company' });

    await resolveEntity(database.db, { collectionId, subject: 'Gamma Cargo One' });

    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Gamma Cargo Two',
      client,
      maxAdjudications: 0,
    });

    // A zero budget is the same situation as having no model at all: the subject is not
    // merged on a guess, it is left separate and said to be separate.
    expect(asked).toHaveLength(0);
    expect(resolution.adjudications).toBe(0);
    expect(resolution.method).toBe('created');
  });

  it('spends nothing when the name matches exactly', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: true, reason: 'the same company' });

    await resolveEntity(database.db, { collectionId, subject: 'Delta Shipping Limited' });
    // Exact match after the legal suffix is stripped, which needs no model at all — this
    // is why withholding the client costs so little.
    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Delta Shipping',
      client,
    });

    expect(asked).toHaveLength(0);
    expect(resolution.adjudications).toBe(0);
    expect(resolution.method).toBe('exact');
  });
});

/**
 * Telling a considered "no" apart from a provider that is not answering.
 *
 * Both leave the subject unmerged, but only one means asking again is pointless. Without
 * the distinction the stage kept paying the client's full retry ladder and its backoff for
 * every remaining subject after the quota was gone — the tail of a run that had already
 * lost the ability to adjudicate anything.
 */
describe.skipIf(!reachable)('a failing adjudicator', () => {
  it('reports the failure rather than passing it off as "different"', async () => {
    const { collectionId } = await seedCollection();

    const failing: CompletionProvider = {
        model: 'stub/failing',
      async complete(): Promise<CompletionResult> {
        throw new ModelError('quota exhausted', 'provider_rate_limited', true);
      },
    };

    await resolveEntity(database.db, { collectionId, subject: 'Epsilon Roadways One' });

    // Neither a yes nor a no. Leaving the subject unmerged would decide entity identity
    // by outage and record it as though the question had been answered.
    await expect(
      resolveEntity(database.db, {
        collectionId,
        subject: 'Epsilon Roadways Two',
        client: failing,
      }),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it('does not report a failure when the adjudicator simply says no', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: false, reason: 'a parent and its subsidiary' });

    await resolveEntity(database.db, { collectionId, subject: 'Zeta Haulage One' });
    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Zeta Haulage Two',
      client,
    });

    expect(resolution.adjudications).toBe(1);
    expect(resolution.adjudicationFailed).toBe(false);
    expect(resolution.method).toBe('created');
  });
});

/**
 * Subjects that name no particular thing.
 *
 * This is the regression for the system's first false contradiction. Extraction returned
 * `subject: "document"` for both a prospectus filing date and an earnings-deck date;
 * entity resolution merged them, so the deterministic checks reported `entityMatch: same`
 * and the classifier saw one entity holding two different dates. It called that a
 * contradiction, which was a reasonable reading of what it was given and completely wrong.
 *
 * A false contradiction is the expensive error for this system, so the guard is a rule
 * rather than a request in a prompt.
 */
describe('generic subjects', () => {
  it('recognises document self-references, whatever the casing or padding', () => {
    for (const subject of ['document', 'This Presentation', '  the company ', 'The Report.']) {
      expect(isGenericSubject(subject), subject).toBe(true);
    }
  });

  it('leaves real names alone', () => {
    for (const subject of ['Delhivery Limited', 'Sahil Barua', 'Express Parcel', 'India']) {
      expect(isGenericSubject(subject), subject).toBe(false);
    }
  });
});

describe.skipIf(!reachable)('scoping a generic subject', () => {
  it('keeps two documents saying "document" apart', async () => {
    const { collectionId } = await seedCollection();

    const first = await resolveEntity(database.db, {
      collectionId,
      subject: 'document',
      scopeKey: 'doc-one',
    });
    const second = await resolveEntity(database.db, {
      collectionId,
      subject: 'document',
      scopeKey: 'doc-two',
    });

    // Different entities, so the comparison stage sees entityMatch "different" rather than
    // "same" and never puts the two filing dates to the classifier as one thing.
    expect(second.entityId).not.toBe(first.entityId);
    // The reviewer still sees the word the document used, not the scoping key.
    expect(second.canonicalLabel).toBe('document');
  });

  it('still merges the same generic subject within one document', async () => {
    const { collectionId } = await seedCollection();

    const first = await resolveEntity(database.db, {
      collectionId,
      subject: 'this presentation',
      scopeKey: 'doc-one',
    });
    const again = await resolveEntity(database.db, {
      collectionId,
      subject: 'this presentation',
      scopeKey: 'doc-one',
    });

    expect(again.entityId).toBe(first.entityId);
    expect(again.method).toBe('exact');
  });

  it('does not scope a real name', async () => {
    const { collectionId } = await seedCollection();

    const first = await resolveEntity(database.db, { collectionId, subject: 'Delhivery Limited' });
    // No scope key, because the subject is a real entity: this is the merge that must
    // still happen across documents for corroboration to be possible at all.
    const second = await resolveEntity(database.db, { collectionId, subject: 'Delhivery' });

    expect(second.entityId).toBe(first.entityId);
  });
});
