/**
 * Entity label normalization and fact-group identity.
 *
 * The database-backed half of resolution is exercised by the pipeline integration test;
 * what is worth pinning down here is the rule that decides whether two names are even
 * allowed to merge without a model being asked.
 */

import { describe, expect, it } from 'vitest';

import { normalizeEntityLabel } from './entities.ts';
import { factGroupId } from './stage.ts';

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
