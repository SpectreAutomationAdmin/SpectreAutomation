// EP-TRAIN-4Y-AR §2 — rejected-proposal retention.
//
// The AP run (cmwbfy1ul000dv9lt44apd074) failed with a single
// sanitiser-rejected Qwen proposal whose raw text was LOST because
// `perGroupDiagnostics[*].sanitizerDropReasons[]` records only
// `{proposalIndex, findingCodes}`. AQ shipped the normaliser but
// could not use it against the actual AP proposal because the text
// was gone — the forensic audit exhausted every surface (DB, Fly
// logs, Modal CLI) with no recovery.
//
// This module fixes that forensic gap. When a proposal fails at
// ANY validation stage — grounding, AQ normalisation refusal,
// employee-facing text sanitiser, structural validator, dedup —
// the full structured proposal is retained in a tenant-scoped,
// admin-access-only field on the generation-run row. Future
// recoveries can inspect the actual rejected text, choose whether
// a normalisation rule extension is safe, and reason about failure
// modes without re-running the GPU.
//
// Security properties (invariants this module enforces by shape):
//
//   - Retention lives inside `TrainingQuestionAiGenerationRun
//     .shortfallReasonJson.perGroupDiagnostics[*].rejectedProposals[]`.
//     That column is already:
//       · tenant-scoped (the row carries `clubId`);
//       · encrypted at rest (Postgres at-rest encryption, same as
//         every other column);
//       · admin-access-only (no public or member endpoint reads
//         the generation-run table);
//       · never logged by the worker (zero log sites in the
//         module reference the text body).
//   - No new Prisma model. No new column. No new migration.
//   - Access is through ONE new admin-only GET route
//     (`/api/admin/ai-training/runs/[runId]/rejected-proposals`)
//     gated by the existing `requireInternalAdmin()` path.
//   - Employee-facing surfaces (`/app/member/*`, `/app/employee/*`,
//     public/un-authed APIs) are PROVEN not to import or project
//     this field — enforced by the offline isolation test in
//     tests/ep-train-4y-ar-retention.test.ts §4.3.
//   - Every retained record carries `retentionExpiresAt` =
//     rejectedAt + 30 days. `pruneExpiredRetainedProposals(now)`
//     is a pure function that drops expired entries; a scheduled
//     task can invoke it, but even absent scheduling the lifecycle
//     is bounded (records disappear when the run row is deleted).
//
// This file is OFFLINE — pure functions, no I/O, no DB, no secrets.

import type { NormalisationTransform } from "../ai-review/question-text-normaliser";

export const DEFAULT_RETENTION_DAYS = 30;

/** Validation stage at which the proposal was rejected. Ordered
 *  by the pipeline order so a diagnostic report can reconstruct
 *  how far each proposal got. */
export type RejectionStage =
  | "GROUNDING"
  | "NORMALISATION_REFUSED"
  | "SANITISER"
  | "STRUCTURAL"
  | "DEDUP";

export interface RetainedRejectedProposal {
  /** Position of this proposal within the Modal response batch. */
  readonly proposalIndex: number;
  /** Stage at which the proposal was rejected. */
  readonly rejectionStage: RejectionStage;
  /** Raw question stem as returned by Qwen, BEFORE normalisation. */
  readonly originalQuestionText: string;
  /** Stem after AQ normalisation (equal to `originalQuestionText`
   *  when the normaliser returned no transforms or refused). */
  readonly normalisedQuestionText: string;
  /** Option bodies + correctness, as returned. */
  readonly options: ReadonlyArray<{ readonly text: string; readonly isCorrect: boolean }>;
  /** Explanation body, as returned (null if omitted by Qwen). */
  readonly explanation: string | null;
  /** Source segment ids the model cited. */
  readonly sourceSegmentIds: readonly number[];
  /** Question type as declared by the structured response. */
  readonly questionType: string;
  /** Comma-separated finding / rule codes recorded at the
   *  rejection stage. Preserves the same shape already used in
   *  the existing `sanitizerDropReasons[].findingCodes`. */
  readonly findingCodes: string;
  /** For NORMALISATION_REFUSED only — why the normaliser bailed. */
  readonly normalisationRefusalReason: string | null;
  /** Transforms applied (empty for refusals or rejections at other
   *  stages). */
  readonly normalisationTransforms: readonly NormalisationTransform[];
  /** When the proposal was rejected (ISO-8601 UTC). */
  readonly rejectedAt: string;
  /** When this retained record is eligible for pruning. */
  readonly retentionExpiresAt: string;
  /** Generation-run association (defence-in-depth — the row also
   *  nests this record under the correct run, but carrying the
   *  id in the record itself helps diagnostics correlate). */
  readonly generationRunId: string;
  /** Group this proposal targeted (fa-1, cg-2, etc.). */
  readonly groupId: string;
}

export interface BuildRetainedRejectedProposalInput {
  readonly proposalIndex: number;
  readonly rejectionStage: RejectionStage;
  readonly proposal: {
    readonly questionText: string; // original
    readonly options: ReadonlyArray<{ text: string; isCorrect: boolean }>;
    readonly explanation?: string | null;
    readonly sourceSegmentIds: readonly number[];
    readonly questionType: string;
  };
  readonly normalisedQuestionText: string;
  readonly normalisationTransforms: readonly NormalisationTransform[];
  readonly normalisationRefusalReason: string | null | undefined;
  readonly findingCodes: string;
  readonly rejectedAt: Date;
  readonly generationRunId: string;
  readonly groupId: string;
  readonly retentionDays?: number;
}

/** Pure, deterministic constructor — no I/O. */
export function buildRetainedRejectedProposal(
  input: BuildRetainedRejectedProposalInput,
): RetainedRejectedProposal {
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const rejectedAt = input.rejectedAt;
  const retentionExpiresAt = new Date(rejectedAt.getTime() + retentionMs);
  return {
    proposalIndex: input.proposalIndex,
    rejectionStage: input.rejectionStage,
    originalQuestionText: input.proposal.questionText,
    normalisedQuestionText: input.normalisedQuestionText,
    options: input.proposal.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
    explanation: input.proposal.explanation ?? null,
    sourceSegmentIds: [...input.proposal.sourceSegmentIds],
    questionType: input.proposal.questionType,
    findingCodes: input.findingCodes,
    normalisationRefusalReason: input.normalisationRefusalReason ?? null,
    normalisationTransforms: [...input.normalisationTransforms],
    rejectedAt: rejectedAt.toISOString(),
    retentionExpiresAt: retentionExpiresAt.toISOString(),
    generationRunId: input.generationRunId,
    groupId: input.groupId,
  };
}

/** Prune expired retained records from a list. Pure function.
 *  Intended for scheduled cleanup OR an ad-hoc administrator
 *  diagnostic. */
export function pruneExpiredRetainedProposals(
  retained: readonly RetainedRejectedProposal[],
  now: Date,
): RetainedRejectedProposal[] {
  const nowMs = now.getTime();
  return retained.filter((r) => Date.parse(r.retentionExpiresAt) > nowMs);
}

/** Flatten an entire perGroupDiagnostics list to a single retained
 *  array (for the admin GET endpoint). Preserves group-id ordering. */
export function flattenRetainedFromDiagnostics<D extends {
  group: string;
  rejectedProposals?: readonly RetainedRejectedProposal[];
}>(diagnostics: readonly D[]): RetainedRejectedProposal[] {
  const out: RetainedRejectedProposal[] = [];
  for (const d of diagnostics) {
    for (const r of d.rejectedProposals ?? []) {
      out.push(r);
    }
  }
  return out;
}
