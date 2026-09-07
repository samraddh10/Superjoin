/**
 * Rendering the measurements as Markdown.
 *
 * Written to be read by someone deciding whether to believe the system, so every rate
 * carries its denominator and every section that could not be measured says so instead
 * of printing a zero. A zero and "not measured" mean opposite things — the first is a
 * result, the second is an absence — and a report that conflated them would be worse
 * than no report.
 */

import type { Goldset } from './goldset.ts';
import type { StructureSummary } from './load.ts';
import {
  asPercent,
  LABELS,
  rate,
  type CandidateRecallResult,
  type CoverageResult,
  type EvidenceResult,
  type GroundingResult,
  type Rate,
  type RelationshipResult,
  type RunCost,
} from './metrics.ts';

export interface ReportInput {
  /**
   * Absent on a collection with no reviewed sample.
   *
   * The held-out collection of plan 8.3 has none by design, and the gold-dependent
   * sections are then omitted rather than printed as a column of "not measured" — an
   * absent measurement and an unmeasurable one are different things, and only the second
   * applies here.
   */
  readonly goldset: Goldset | null;
  readonly collectionName: string;
  readonly collectionId: string;
  readonly generatedAt: Date;
  readonly coverage: CoverageResult;
  readonly grounding: GroundingResult;
  readonly evidence: EvidenceResult;
  readonly candidates: CandidateRecallResult;
  readonly relationships: RelationshipResult;
  readonly cost: RunCost;
  readonly structure: StructureSummary;
}

function fraction(value: Rate): string {
  return `${asPercent(value)} (${value.numerator}/${value.denominator})`;
}

/** Says nothing rather than something misleading when a stage produced no output. */
function measuredOr(condition: boolean, text: string, absent: string): string {
  return condition ? text : `_${absent}_`;
}

export function renderReport(input: ReportInput): string {
  const { goldset, coverage, grounding, evidence, candidates, relationships, cost, structure } =
    input;
  const lines: string[] = [];

  const extracted = cost.claimsExtracted > 0;

  lines.push('# Evaluation results');
  lines.push('');
  lines.push(
    `Generated ${input.generatedAt.toISOString()} against collection **${input.collectionName}** (\`${input.collectionId}\`).`,
  );
  lines.push('');

  if (goldset === null) {
    lines.push(
      'This collection has **no hand-reviewed sample**, so the accuracy sections are omitted rather than printed empty. That is the held-out collection of plan 8.3 by design: a gold set built for it would have had to be read first, and reading it is what makes a set no longer held out.',
    );
    lines.push('');
    lines.push(
      'What can still be measured without ground truth is measured: what parsing produced, how far each run got, and what failed. Those are reported below.',
    );
    lines.push('');
  } else {
    lines.push(
      `Scored on \`evaluation/goldset.json\` version ${goldset.version}, which holds **${goldset.claims.length} claims and ${goldset.pairs.length} pairs** across ${goldset.documents.length} documents. It is development data: it was read before the system was built.`,
    );
    lines.push('');
  }

  // Only meaningful where accuracy sections follow; a no-goldset report has none.
  if (!extracted && goldset !== null) {
    lines.push('> **No claims were extracted in this run, so every accuracy figure below is');
    lines.push('> unmeasured rather than zero.** The counts and the failure breakdown are real');
    lines.push('> and are reported; the rates are not, and are marked as such. What stopped the');
    lines.push('> run is in "Processing and failures" at the end.');
    lines.push('');
  }

  if (goldset !== null) {
    lines.push('## 1. Extraction coverage on the reviewed sample');
    lines.push('');
    lines.push(
      'Recall over the hand-reviewed sample, not over the collection. Fifty claims from three documents is a sample, and this figure does not describe what fraction of everything in the PDFs was found.',
    );
    lines.push('');
    lines.push(`- Gold claims located: **${fraction(coverage.recall)}**`);
    lines.push(
      `- Of those, carrying the gold period and scope: ${measuredOr(coverage.matched.length > 0, fraction(coverage.contextAgreement), 'no claims matched, so context agreement is not measured')}`,
    );
    lines.push('');
    lines.push('| Evidence kind | Located |');
    lines.push('|---|---|');
    for (const [kind, value] of coverage.byEvidenceKind) {
      lines.push(`| ${kind} | ${fraction(value)} |`);
    }
    lines.push('');
    if (coverage.missed.length > 0 && coverage.missed.length <= 60) {
      lines.push(
        `Not located: ${coverage.missed.map((outcome) => outcome.gold.id).join(', ')}`,
      );
      lines.push('');
    }

    lines.push('## 2. Grounding precision on accepted claims');
    lines.push('');
    lines.push(`Scope: ${grounding.scope}.`);
    lines.push('');
    lines.push(
      `- Accepted claims matching a gold claim: ${measuredOr(grounding.precision.denominator > 0, fraction(grounding.precision), 'no accepted claims fall on a page the gold set covers, so precision is not measured')}`,
    );
    lines.push(
      `- Matched but with a different period or scope: ${grounding.wrongContext.length}${grounding.wrongContext.length > 0 ? ` (${grounding.wrongContext.join(', ')})` : ''}`,
    );
    lines.push('');
    lines.push(
      'A claim on a gold page that matches no gold claim is counted against precision. That is deliberately harsh: the page was reviewed by hand, so a figure the reviewer did not record is more likely wrong than merely unrecorded — but it is not certain, and the count should be read with that in mind.',
    );
    lines.push('');

    lines.push('## 3. Evidence references and semantic support');
    lines.push('');
    lines.push(
      'Reported separately, per plan 4.3 and 8.1, because they fail independently: a quote can be genuinely present in the document and still fail to support the claim citing it.',
    );
    lines.push('');
    const anyEvidence = evidence.referenceValidity.denominator > 0;
    lines.push(
      `- Quote independently located in the cited block: ${measuredOr(anyEvidence, fraction(evidence.referenceValidity), 'no evidence rows exist, so reference validity is not measured')}`,
    );
    lines.push(
      `- Recorded by the pipeline as verified in native text: ${measuredOr(anyEvidence, fraction(evidence.recordedVerified), 'not measured')}`,
    );
    lines.push(
      `- Recorded as supporting the claim (entailment): ${measuredOr(anyEvidence, fraction(evidence.semanticSupport), 'not measured')}`,
    );
    lines.push(
      `- Supported only by a page image, so not independently verified: ${measuredOr(anyEvidence, fraction(evidence.visualOnly), 'not measured')}`,
    );
    lines.push(
      `- Rows where this scorer and the pipeline disagree about whether the quote is present: ${evidence.disagreements.length}`,
    );
    lines.push('');
    lines.push(
      'The first line is re-checked here rather than read back from the database. A scorer that trusted the stored verification flag would be reporting the pipeline\'s opinion of itself.',
    );
    lines.push('');

    lines.push('## 4. Candidate recall on known pairs');
    lines.push('');
    lines.push(
      `- Gold pairs whose two claims were both extracted: **${candidates.reachable} of ${goldset.pairs.length}**`,
    );
    lines.push(
      `- Of those, surfaced as a candidate: ${measuredOr(candidates.reachable > 0, fraction(candidates.recall), 'no pair had both claims extracted, so retrieval could not be measured')}`,
    );
    if (candidates.missed.length > 0) lines.push(`- Reachable but not surfaced: ${candidates.missed.join(', ')}`);
    lines.push('');
    lines.push(
      'Conditioned on both claims existing: a pair cannot be retrieved when one side was never extracted, and charging retrieval for an extraction miss would confuse the two stages plan 8.1 asks to be evaluated apart. Note also that this is measured from stored relationships, so it cannot separate a pair retrieval never surfaced from one the classifier declined to store; it is a lower bound on retrieval.',
    );
    lines.push('');

    lines.push('## 5. Relationship labels');
    lines.push('');
    if (relationships.scored === 0) {
      lines.push(
        '_No gold pair could be scored: the pairs need both claims extracted and a stored relationship between them. The confusion matrix is not reported rather than reported as empty._',
      );
      lines.push('');
    } else {
      lines.push(`Scored on **${relationships.scored} of ${goldset.pairs.length}** gold pairs.`);
      lines.push('');
      lines.push(`| Expected \\ Predicted | ${LABELS.join(' | ')} |`);
      lines.push(`|---|${LABELS.map(() => '---').join('|')}|`);
      for (const expected of LABELS) {
        const row = relationships.matrix.get(expected)!;
        lines.push(`| **${expected}** | ${LABELS.map((l) => row.get(l) ?? 0).join(' | ')} |`);
      }
      lines.push('');
      lines.push(`- Exact label agreement: ${fraction(relationships.agreement)}`);
      lines.push(
        `- **False contradictions** (asserted a conflict where the gold label is not one): ${relationships.falseContradictions.length}${relationships.falseContradictions.length > 0 ? ` — ${relationships.falseContradictions.join(', ')}` : ''}`,
      );
      lines.push(
        `- Missed conflicts (gold says conflict, system did not): ${relationships.missedContradictions.length}${relationships.missedContradictions.length > 0 ? ` — ${relationships.missedContradictions.join(', ')}` : ''}`,
      );
      lines.push(`- Abstained as insufficient_context: ${fraction(relationships.abstentions)}`);
      lines.push('');
      lines.push(
        'False contradictions are counted separately because they are the expensive error here: telling a reviewer two documents disagree when they do not is worse than abstaining, and an aggregate accuracy would price the two the same.',
      );
      lines.push('');
    }
    if (relationships.notProduced.length > 0) {
      lines.push(
        `Not scored, because a claim or the relationship itself was not produced: ${relationships.notProduced.join(', ')}`,
      );
      lines.push('');
    }
  }

  lines.push('## 6. Processing and failures');
  lines.push('');
  lines.push('| Measure | Value |');
  lines.push('|---|---|');
  lines.push(`| Documents | ${cost.documents} |`);
  lines.push(`| Pages processed | ${cost.pagesProcessed} / ${cost.pagesTotal} |`);
  lines.push(`| Chunks processed | ${cost.chunksProcessed} / ${cost.chunksTotal} |`);
  lines.push(`| Claims extracted | ${cost.claimsExtracted} |`);
  lines.push(`| Claims accepted | ${cost.claimsAccepted} |`);
  lines.push(`| Relationships created | ${cost.relationshipsCreated} |`);
  lines.push(`| Input tokens | ${cost.inputTokens} |`);
  lines.push(`| Output tokens | ${cost.outputTokens} |`);
  lines.push(
    `| Wall clock | ${cost.wallClockMs === null ? 'not recorded' : `${(cost.wallClockMs / 1000).toFixed(1)}s`} |`,
  );
  lines.push('');

  lines.push('Run stages reached:');
  lines.push('');
  for (const [stage, count] of [...cost.stages].sort()) {
    lines.push(`- ${stage}: ${count}`);
  }
  lines.push('');

  if (cost.issuesByKind.size === 0) {
    lines.push('No processing issues were recorded.');
  } else {
    lines.push('| Failure kind | Occurrences |');
    lines.push('|---|---|');
    for (const [kind, count] of [...cost.issuesByKind].sort((a, b) => b[1] - a[1])) {
      lines.push(`| \`${kind}\` | ${count} |`);
    }
  }
  lines.push('');

  lines.push('## 7. Parsing and structure');
  lines.push('');
  lines.push(
    'Measured without ground truth, so it is available on a held-out collection too. This is the part of the pipeline that runs before the model, and on an unfamiliar collection it is the part a generalization claim can actually rest on.',
  );
  lines.push('');
  lines.push('| Measure | Value |');
  lines.push('|---|---|');
  lines.push(`| Source blocks | ${structure.blocks} |`);
  lines.push(
    `| Pages that produced blocks | ${structure.pagesWithBlocks} / ${structure.pagesTotal} |`,
  );
  lines.push(
    `| Blocks with a bounding box | ${fraction(rate(structure.withBoundingBox, structure.blocks))} |`,
  );
  lines.push(
    `| Blocks with a printed page label | ${fraction(rate(structure.withPrintedLabel, structure.blocks))} |`,
  );
  lines.push(`| Blocks from a model transcription | ${structure.modelTranscribed} |`);
  lines.push('');
  lines.push('| Block type | Count |');
  lines.push('|---|---|');
  for (const [type, count] of [...structure.byType].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${type} | ${count} |`);
  }
  lines.push('');
  lines.push(
    'A page producing no blocks is not necessarily a failure: a cover or a divider legitimately has no extractable text. The count is reported rather than judged, because deciding which is which needs the page in front of you.',
  );
  lines.push('');

  lines.push('## Cost');
  lines.push('');
  if (cost.inputTokens === 0 && cost.outputTokens === 0) {
    lines.push(
      'No tokens were billed: the model returned no successful completion in this run. The configured model is a `:free` route, so the monetary cost of this run is zero either way, and a per-token cost estimate would be an estimate of nothing.',
    );
  } else {
    lines.push(
      `${cost.inputTokens} input and ${cost.outputTokens} output tokens. The configured model is a \`:free\` route, so the monetary cost is zero; the token counts are what would carry over to a paid route and are reported for that reason.`,
    );
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}
