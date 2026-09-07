/**
 * Relationship classification.
 *
 * The tests that matter are about what the classifier is not allowed to get away with: a
 * corroboration between two readings of one passage, a citation to evidence that was
 * never offered, and any form of confidence score.
 */

import { describe, expect, it } from 'vitest';

import type { CompletionProvider, CompletionRequest, CompletionResult } from '../model/index.ts';
import { buildClassificationMessages, classifyPair, type EvidenceHandle } from './classify.ts';
import { runDeterministicChecks, type ComparableClaim } from './checks.ts';

const claim = (overrides: Partial<ComparableClaim> = {}): ComparableClaim => ({
  id: 'claim-a',
  documentId: 'doc-1',
  entityId: 'entity-1',
  subject: 'Delhivery Limited',
  predicate: 'revenue_from_services',
  originalStatement: 'Revenue from services was 8,142 Cr in FY24.',
  rawValue: '8,142 Cr',
  numericValue: '8142',
  currency: 'INR',
  scale: 'crore',
  unit: null,
  periodLabel: 'FY2024',
  periodType: 'fiscal_year',
  periodStart: null,
  periodEnd: null,
  scope: 'consolidated',
  assertionStatus: 'reported',
  qualifiers: [],
  status: 'accepted',
  sourceBlockIds: ['block-1'],
  ...overrides,
});

const other = (overrides: Partial<ComparableClaim> = {}): ComparableClaim =>
  claim({
    id: 'claim-b',
    documentId: 'doc-2',
    numericValue: '81415',
    rawValue: '81,415',
    scale: 'million',
    sourceBlockIds: ['block-2'],
    ...overrides,
  });

const handles: EvidenceHandle[] = [
  {
    handle: 'E1',
    evidenceId: 'evidence-1',
    claimId: 'claim-a',
    physicalPage: 5,
    quote: 'Revenue from services was 8,142 Cr in FY24.',
    context: 'Financial highlights. Revenue from services was 8,142 Cr in FY24.',
    verification: 'verified_native_text',
  },
  {
    handle: 'E2',
    evidenceId: 'evidence-2',
    claimId: 'claim-b',
    physicalPage: 3,
    quote: 'Revenue from services 81,415',
    context: 'All figures in INR million. Revenue from services 81,415',
    verification: 'verified_native_text',
  },
];

class ScriptedClient implements CompletionProvider {
  readonly mode = 'live' as const;
  readonly model = 'test/model';
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly replies: readonly string[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1];
    if (reply === undefined) throw new Error('the client was called more times than scripted');

    return {
      text: reply,
      servedByModel: 'test/model-served',
      promptTokens: 400,
      completionTokens: 80,
      latencyMs: 20,
    };
  }
}

const reply = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    label: 'corroborates',
    rationale: 'Both documents state the same FY24 figure once the crore value is converted.',
    evidence_ids: ['E1', 'E2'],
    differing_context: [],
    uncertainty_reasons: [],
    ...overrides,
  });

describe('buildClassificationMessages', () => {
  const messages = buildClassificationMessages(
    claim(),
    other(),
    runDeterministicChecks(claim(), other()),
    handles,
  );
  const rendered = messages.map((message) => String(message.content)).join('\n');

  it('shows both claims with their values as written', () => {
    expect(rendered).toContain('8,142 Cr');
    expect(rendered).toContain('81,415');
  });

  it('labels the checks as inputs rather than as an answer', () => {
    // A verdict in the prompt is a verdict the model copies.
    expect(rendered).toContain('inputs, not conclusions');
  });

  it('gives the passage around each quote, not only the quote', () => {
    expect(rendered).toContain('All figures in INR million');
  });

  it('offers the six labels and nothing else', () => {
    for (const label of [
      'corroborates',
      'contradicts',
      'likely_contradiction',
      'reconciled_by_context',
      'insufficient_context',
      'unrelated',
    ]) {
      expect(rendered).toContain(label);
    }
  });

  it('forbids a confidence score', () => {
    // Plan 6.4: a model-generated score must not be presented as a calibrated
    // probability, and the surest way is never to ask for one.
    expect(rendered).toContain('Do not state a confidence');
  });

  it('tells the model the passages are data, not instruction', () => {
    expect(rendered).toContain('not instruction');
  });

  it('requires a reconciliation to be visible in a passage', () => {
    expect(rendered).toContain('visible in a passage');
  });
});

describe('classifyPair', () => {
  it('resolves evidence handles back to stored evidence rows', async () => {
    const client = new ScriptedClient([reply()]);
    const checks = runDeterministicChecks(claim(), other());

    const result = await classifyPair(claim(), other(), checks, handles, { client });

    expect(result.label).toBe('corroborates');
    expect(result.supportingEvidenceIds).toEqual(['evidence-1', 'evidence-2']);
  });

  it('drops a handle that was never offered', async () => {
    // A citation the prompt did not contain resolves to nothing rather than being
    // stored as an identifier that points at no row.
    const client = new ScriptedClient([reply({ evidence_ids: ['E1', 'E9'] })]);
    const result = await classifyPair(claim(), other(), runDeterministicChecks(claim(), other()), handles, {
      client,
    });

    expect(result.supportingEvidenceIds).toEqual(['evidence-1']);
  });

  it('downgrades a corroboration between two readings of one passage', async () => {
    // The prompt says so and the model still agrees with itself sometimes, so the rule
    // is applied where it cannot be argued out of.
    const shared = other({ sourceBlockIds: ['block-1'] });
    const client = new ScriptedClient([reply()]);

    const result = await classifyPair(
      claim(),
      shared,
      runDeterministicChecks(claim(), shared),
      handles,
      { client },
    );

    expect(result.label).toBe('insufficient_context');
    expect(result.uncertaintyReasons.some((reason) => reason.includes('read twice'))).toBe(true);
  });

  it('keeps a corroboration inside one document but says what it is', async () => {
    const sameDocument = other({ documentId: 'doc-1' });
    const client = new ScriptedClient([reply()]);

    const result = await classifyPair(
      claim(),
      sameDocument,
      runDeterministicChecks(claim(), sameDocument),
      handles,
      { client },
    );

    expect(result.label).toBe('corroborates');
    expect(result.uncertaintyReasons.some((reason) => reason.includes('internal consistency'))).toBe(
      true,
    );
  });

  it('records that a conclusion rests on a claim held for review', async () => {
    const provisional = other({ status: 'needs_review' });
    const client = new ScriptedClient([reply({ label: 'reconciled_by_context' })]);

    const result = await classifyPair(
      claim(),
      provisional,
      runDeterministicChecks(claim(), provisional),
      handles,
      { client },
    );

    expect(result.uncertaintyReasons.some((reason) => reason.includes('held for review'))).toBe(true);
  });

  it('rejects a label that is not one of the six', async () => {
    const client = new ScriptedClient([reply({ label: 'probably_fine' })]);

    await expect(
      classifyPair(claim(), other(), runDeterministicChecks(claim(), other()), handles, { client }),
    ).rejects.toMatchObject({ kind: 'schema_violation' });
  });

  it('rejects a reply that is not JSON at all', async () => {
    const client = new ScriptedClient(['These two claims look consistent to me.']);

    await expect(
      classifyPair(claim(), other(), runDeterministicChecks(claim(), other()), handles, { client }),
    ).rejects.toMatchObject({ kind: 'schema_violation' });
  });

  it('keeps the uncertainty reasons the model gave', async () => {
    const client = new ScriptedClient([
      reply({
        label: 'likely_contradiction',
        uncertainty_reasons: ['neither document states whether the figure is restated'],
      }),
    ]);

    const result = await classifyPair(claim(), other(), runDeterministicChecks(claim(), other()), handles, {
      client,
    });

    expect(result.label).toBe('likely_contradiction');
    expect(result.uncertaintyReasons[0]).toContain('restated');
  });
});
