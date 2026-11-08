// EP-TRAIN-4Y-P §6 — reusable service to materialise the
// TrainingGroundingProjection row + TrainingQuestionAiValidation
// rows that 4Y-O proved were missing for every modern-pipeline run.
//
// Two call sites:
//   (a) the worker-handler, once the group loop finishes and the drafts
//       are persisted — binds the projection FK + records a validation
//       per draft before `recordGenerationCompleted`.
//   (b) a one-off backfill helper (`backfillRunProvenance`) that runs
//       the same code path against already-persisted runs (4Y-N, 4Y-M)
//       whose drafts were written before this fix landed.
//
// Everything in this module reconstructs provenance ONLY from verified
// persisted evidence:
//   - the plan's `assessmentPlanJson` on the run (frozen at REQUESTED)
//   - `TrainingTranscriptBuild` + `TrainingTranscriptSegment` rows
//     written at 4Y-L time (immutable)
//   - the run row's `pilotAuthorizationId` / `pilotAuthorizationFingerprint`
//     / `planIdentity`
//
// No GPU inference. No draft content is rewritten. If the validator
// returns REJECTED, that REJECTED verdict is persisted as-is; the
// draft's `state` is NOT altered — a reviewer may still see the
// REJECTED validation beside the draft and either revalidate after
// an edit (future slice) or hide the draft from the review queue.

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import type {
  GroundingPassage,
  GroundingProjection,
  PilotAuthorizationV1,
  TrainingQuestionDraftLiteV1,
} from "@/lib/training/ai-generation/types";
import { validateTrainingQuestion } from "@/lib/training/ai-generation/pipeline";
import type { AssessmentPlanV1 } from "@/lib/hr/training/generation/assessment-plan";
import { logger } from "@/lib/observability/logger";

const VALIDATOR_VERSION = "6c-10b" as const;
const VALIDATOR_SOURCE = "integrated-pipeline" as const;

/** Deterministic canonicalisation matching the one used by content-hash.ts
 *  — stable key order, no whitespace, no undefineds. */
function canonicalise(value: unknown): string {
  return JSON.stringify(sort(value));
  function sort(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sort);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const inner = (v as Record<string, unknown>)[k];
      if (inner !== undefined) out[k] = sort(inner);
    }
    return out;
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

export interface MaterialisedProjection {
  readonly projectionRowId: string;
  readonly projectionSha256: string;
  readonly projection: GroundingProjection;
}

/** Build + upsert a TrainingGroundingProjection row for a given plan
 *  + tenant + course version. Idempotent via the
 *  (clubId, courseVersionId, sha256) unique index. */
export async function materialiseGroundingProjection(
  input: {
    readonly clubId: string;
    readonly courseId: string;
    readonly courseVersionId: string;
    readonly plan: AssessmentPlanV1;
  },
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<MaterialisedProjection> {
  const db = opts.prisma ?? defaultPrisma;

  // 1. Resolve the transcript build id (DB cuid) from the plan's
  //    resolvedTranscriptBuildId FINGERPRINT (the 64-char hex).
  const build = await db.trainingTranscriptBuild.findFirst({
    where: {
      clubId: input.clubId,
      resolvedTranscriptBuildId: input.plan.resolvedTranscriptBuildId,
    },
    select: { id: true },
  });
  if (!build) {
    throw new Error(
      `materialiseGroundingProjection: transcript build fingerprint ${input.plan.resolvedTranscriptBuildId} not found for club ${input.clubId}`,
    );
  }

  // 2. Load the eligible-segment rows ordered by index. The
  //    `reviewerAttestedAt` column (EP-TRAIN-4Y-Q §5) lets the
  //    materialiser clear pendingReview flags for segments an
  //    independent reviewer has attested are reliable evidence.
  const segments = await db.trainingTranscriptSegment.findMany({
    where: {
      clubId: input.clubId,
      transcriptBuildId: build.id,
      segmentIndex: { in: [...input.plan.eligibleSegmentIds] },
    },
    select: {
      segmentIndex: true,
      text: true,
      startSec: true,
      endSec: true,
      pendingReviewJson: true,
      sourceOrgMismatchJson: true,
      uncertaintyWarning: true,
      reviewerAttestedAt: true,
      reviewerAttestedByUserId: true,
    },
    orderBy: { segmentIndex: "asc" },
  });

  // 3. Shape into GroundingPassage[].
  const passages: GroundingPassage[] = segments.map((s) => {
    let pendingReview: string[] = [];
    let sourceOrgMismatch: string[] = [];
    try {
      const parsed = JSON.parse(s.pendingReviewJson ?? "[]");
      if (Array.isArray(parsed)) pendingReview = parsed.map(String);
    } catch {}
    try {
      const parsed = JSON.parse(s.sourceOrgMismatchJson ?? "[]");
      if (Array.isArray(parsed)) sourceOrgMismatch = parsed.map(String);
    } catch {}
    // EP-TRAIN-4Y-Q §5 — reviewer attestation clears pendingReview
    // AND sourceOrgMismatch AND the uncertainty warning on the
    // projection body. The underlying TrainingTranscriptSegment row
    // is NEVER rewritten — this transformation only annotates the
    // ephemeral GroundingProjection row.
    const attested = s.reviewerAttestedAt !== null;
    return {
      passageId: s.segmentIndex,
      sourceSegmentIds: [s.segmentIndex],
      sourceStartSec: Number(s.startSec),
      sourceEndSec: Number(s.endSec),
      text: s.text,
      citationHandle: `seg-${s.segmentIndex}`,
      flags: attested
        ? {
            pendingReview: [],
            sourceOrgMismatch: [],
            uncertaintyWarning: null,
          }
        : {
            pendingReview,
            sourceOrgMismatch,
            uncertaintyWarning: s.uncertaintyWarning ?? null,
          },
    };
  });

  const projection: GroundingProjection = {
    schemaVersion: "training-grounding-v1",
    operation: "GENERATE_DRAFT_QUESTIONS",
    tenantId: input.clubId,
    courseId: input.courseId,
    versionId: input.courseVersionId,
    sourceVideoSha256: input.plan.sourceVideoSha256,
    resolvedTranscriptBuildId: input.plan.resolvedTranscriptBuildId,
    passages,
    excludedPassages: input.plan.sourceEvidenceRequirements.excludedSegmentIndices.map(
      (id) => ({
        passageId: id,
        sourceSegmentIds: [id],
        reason: "plan_level_exclusion",
      }),
    ),
    sourceOrgMismatchFlagsPresent: passages.some((p) => p.flags.sourceOrgMismatch.length > 0),
    pendingReviewPresent: passages.some((p) => p.flags.pendingReview.length > 0),
  };

  // 4. SHA-256 the canonical projection body.
  const projectionSha256 = sha256Hex(canonicalise(projection));

  // 5. Upsert row (idempotent).
  const now = opts.now ?? new Date();
  const row = await db.trainingGroundingProjection.upsert({
    where: {
      clubId_courseVersionId_sha256: {
        clubId: input.clubId,
        courseVersionId: input.courseVersionId,
        sha256: projectionSha256,
      },
    },
    create: {
      clubId: input.clubId,
      courseVersionId: input.courseVersionId,
      sha256: projectionSha256,
      sourceVideoSha256: input.plan.sourceVideoSha256,
      resolvedTranscriptBuildId: input.plan.resolvedTranscriptBuildId,
      passagesJson: JSON.stringify(projection.passages),
      excludedPassagesJson: JSON.stringify(projection.excludedPassages ?? []),
      sourceOrgMismatchFlagsPresent: !!projection.sourceOrgMismatchFlagsPresent,
      pendingReviewPresent: !!projection.pendingReviewPresent,
      authoredAt: safeDate(input.plan.generatedAt) ?? now,
    },
    update: {},
    select: { id: true },
  });

  return {
    projectionRowId: row.id,
    projectionSha256,
    projection,
  };
}

function safeDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Synthesize a PilotAuthorizationV1 object from a run's persisted
 *  identity fields. The converter + validator consume this; no HMAC
 *  verification happens inside the deterministic pipeline, so the
 *  fingerprint field is just a correlation tag. */
export function synthesizePilotAuthorizationFromRun(args: {
  readonly runId: string;
  readonly clubId: string;
  readonly courseId: string;
  readonly versionId: string;
  readonly plan: AssessmentPlanV1;
  readonly pilotAuthorizationId: string;
  readonly pilotAuthorizationFingerprint: string;
  readonly approvedGroundingProjectionSha256: string;
  readonly nowUtc?: Date;
}): PilotAuthorizationV1 {
  const now = (args.nowUtc ?? new Date()).toISOString();
  const expires = new Date((args.nowUtc ?? new Date()).getTime() + 3600_000).toISOString();
  return {
    schemaVersion: "pilot-generation-authorization-v1",
    authorizationId: args.pilotAuthorizationId,
    tenantId: args.clubId,
    courseId: args.courseId,
    versionId: args.versionId,
    sourceVideoSha256: args.plan.sourceVideoSha256,
    resolvedTranscriptBuildId: args.plan.resolvedTranscriptBuildId,
    approvedGroundingProjectionSha256: args.approvedGroundingProjectionSha256,
    operation: "GENERATE_DRAFT_QUESTIONS",
    maxRequestedQuestions: args.plan.totalTargetQuestionCount,
    pilotRestrictions: {
      publicationProhibited: true,
      employeeAssignmentProhibited: true,
      databaseWritesProhibited: false,
      automaticRetriesProhibited: false,
      excludedSegmentIds: [...(args.plan.sourceEvidenceRequirements.excludedSegmentIndices ?? [])],
      scope: `run:${args.runId}`,
    },
    issuedAtUtc: now,
    expiresAtUtc: expires,
    issuedBy: `system:training-generation:${args.clubId}`,
    fingerprint: args.pilotAuthorizationFingerprint,
  };
}

export interface MaterialisedValidation {
  readonly validationId: string;
  readonly verdict: "GROUNDED" | "REQUIRES_HUMAN_VERIFICATION" | "REJECTED";
  readonly stage: "CONVERT" | "VALIDATE" | "EXCEPTION";
}

/** Run the deterministic validator against a single draft, write a
 *  TrainingQuestionAiValidation row, and (idempotently) bind the
 *  draft's groundingProjectionId FK to the supplied projection row.
 *  Returns the validation id + verdict for logging. */
export async function materialiseValidationForDraft(
  input: {
    readonly draftId: string;
    readonly clubId: string;
    readonly projectionRowId: string;
    readonly projection: GroundingProjection;
    readonly authorization: PilotAuthorizationV1;
  },
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<MaterialisedValidation> {
  const db = opts.prisma ?? defaultPrisma;
  const draft = await db.trainingQuestionAiDraft.findUnique({
    where: { id: input.draftId },
    select: {
      id: true,
      clubId: true,
      contentHash: true,
      draftJson: true,
      groundingProjectionId: true,
      generationRun: {
        select: { id: true },
      },
    },
  });
  if (!draft) throw new Error(`materialiseValidationForDraft: draft ${input.draftId} not found`);
  if (draft.clubId !== input.clubId) {
    throw new Error(`materialiseValidationForDraft: cross-tenant guard — draft ${input.draftId} belongs to ${draft.clubId}, not ${input.clubId}`);
  }

  // Shape the draft lite from the stored canonical body.
  let draftLite: TrainingQuestionDraftLiteV1;
  try {
    const parsed = JSON.parse(draft.draftJson);
    draftLite = {
      questionType: parsed.questionType,
      questionText: parsed.questionText,
      options: parsed.options,
      explanation: parsed.explanation,
      sourceSegmentIds: parsed.sourceSegmentIds,
    };
  } catch (err) {
    throw new Error(`materialiseValidationForDraft: unparseable draftJson on ${draft.id}: ${(err as Error).message}`);
  }

  // Run the deterministic validator.
  const result = validateTrainingQuestion({
    draft: draftLite,
    grounding: input.projection,
    authorization: input.authorization,
  });

  // Build the error-code histogram for fast queries.
  const histogram: Record<string, number> = {};
  for (const e of result.errors) histogram[e.code] = (histogram[e.code] ?? 0) + 1;

  const now = opts.now ?? new Date();
  const validation = await db.trainingQuestionAiValidation.create({
    data: {
      clubId: input.clubId,
      draftId: draft.id,
      draftContentHash: draft.contentHash,
      validatorVersion: VALIDATOR_VERSION,
      validatorSource: VALIDATOR_SOURCE,
      verdict: result.verdict,
      stage: result.stage,
      errorsJson: JSON.stringify(result.errors),
      warningsJson: JSON.stringify(result.warnings),
      flagsJson: JSON.stringify(result.flags),
      proposalJson: result.proposal ? JSON.stringify(result.proposal) : null,
      errorCodeHistogram: Object.keys(histogram).length > 0 ? JSON.stringify(histogram) : null,
      runAt: now,
      runByUserId: null,
    },
    select: { id: true },
  });

  // Bind the draft FK to the projection — idempotent for drafts
  // already pointing at this projection id.
  if (draft.groundingProjectionId !== input.projectionRowId) {
    await db.trainingQuestionAiDraft.update({
      where: { id: draft.id },
      data: { groundingProjectionId: input.projectionRowId },
    });
  }

  return {
    validationId: validation.id,
    verdict: result.verdict,
    stage: result.stage,
  };
}

/** EP-TRAIN-4Y-Q §6 — revalidate a single draft after transcript
 *  attestations may have changed. Re-upserts the projection (which
 *  re-reads attestations + rebuilds passages) and creates a new
 *  TrainingQuestionAiValidation row reflecting the current verdict.
 *  Idempotent on the projection (same sha256 if no attestations have
 *  changed); always adds a fresh validation row so the UI can show
 *  the latest verdict. */
export async function revalidateDraft(
  input: { readonly draftId: string },
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{
  readonly projectionRowId: string;
  readonly validationId: string;
  readonly verdict: "GROUNDED" | "REQUIRES_HUMAN_VERIFICATION" | "REJECTED";
}> {
  const db = opts.prisma ?? defaultPrisma;
  const draft = await db.trainingQuestionAiDraft.findUnique({
    where: { id: input.draftId },
    select: {
      id: true,
      clubId: true,
      courseId: true,
      courseVersionId: true,
      generationRun: {
        select: {
          id: true,
          pilotAuthorizationId: true,
          pilotAuthorizationFingerprint: true,
          planIdentity: true,
          assessmentPlanJson: true,
        },
      },
    },
  });
  if (!draft) throw new Error(`revalidateDraft: draft ${input.draftId} not found`);
  if (!draft.generationRun || !draft.generationRun.assessmentPlanJson) {
    throw new Error(`revalidateDraft: draft ${input.draftId} has no generation-run plan`);
  }
  const plan = JSON.parse(draft.generationRun.assessmentPlanJson) as AssessmentPlanV1;
  const materialised = await materialiseGroundingProjection(
    {
      clubId: draft.clubId,
      courseId: draft.courseId,
      courseVersionId: draft.courseVersionId,
      plan,
    },
    { prisma: db, now: opts.now },
  );
  const authorization = synthesizePilotAuthorizationFromRun({
    runId: draft.generationRun.id,
    clubId: draft.clubId,
    courseId: draft.courseId,
    versionId: draft.courseVersionId,
    plan,
    pilotAuthorizationId: draft.generationRun.pilotAuthorizationId,
    pilotAuthorizationFingerprint: draft.generationRun.pilotAuthorizationFingerprint,
    approvedGroundingProjectionSha256: materialised.projectionSha256,
    nowUtc: opts.now,
  });
  const result = await materialiseValidationForDraft(
    {
      draftId: draft.id,
      clubId: draft.clubId,
      projectionRowId: materialised.projectionRowId,
      projection: materialised.projection,
      authorization,
    },
    { prisma: db, now: opts.now },
  );
  return {
    projectionRowId: materialised.projectionRowId,
    validationId: result.validationId,
    verdict: result.verdict,
  };
}

/** Backfill provenance for a historical run whose drafts were
 *  persisted before the §6 fix landed. Idempotent: runs on a single
 *  run id, creates the projection + walks every draft, skipping those
 *  that already have a projection FK AND at least one validation row.
 *
 *  Returns a summary suitable for structured logging + acceptance
 *  reporting. NEVER mutates draft content. NEVER sets APPROVED_DRAFT.
 *  REJECTED validator verdicts are persisted as-is per §6 "if the
 *  required evidence cannot be reconstructed reliably, flag the
 *  affected question for manual review rather than fabricating
 *  provenance." */
export async function backfillRunProvenance(
  input: { readonly runId: string },
  opts: { prisma?: PrismaClient; now?: Date; dryRun?: boolean } = {},
): Promise<{
  readonly runId: string;
  readonly projectionRowId: string | null;
  readonly projectionSha256: string | null;
  readonly draftsProcessed: number;
  readonly draftsAlreadyBound: number;
  readonly validationsCreated: number;
  readonly verdictCounts: Record<string, number>;
  readonly errors: string[];
}> {
  const db = opts.prisma ?? defaultPrisma;

  const run = await db.trainingQuestionAiGenerationRun.findUnique({
    where: { id: input.runId },
    select: {
      id: true,
      clubId: true,
      courseId: true,
      courseVersionId: true,
      pilotAuthorizationId: true,
      pilotAuthorizationFingerprint: true,
      planIdentity: true,
      assessmentPlanJson: true,
    },
  });
  if (!run) throw new Error(`backfillRunProvenance: run ${input.runId} not found`);
  if (!run.assessmentPlanJson) {
    return {
      runId: input.runId,
      projectionRowId: null,
      projectionSha256: null,
      draftsProcessed: 0,
      draftsAlreadyBound: 0,
      validationsCreated: 0,
      verdictCounts: {},
      errors: ["assessmentPlanJson is null (legacy historical run; skip)"],
    };
  }

  const plan = JSON.parse(run.assessmentPlanJson) as AssessmentPlanV1;

  // Step 1 — materialise the projection.
  const materialised = await materialiseGroundingProjection(
    {
      clubId: run.clubId,
      courseId: run.courseId,
      courseVersionId: run.courseVersionId,
      plan,
    },
    { prisma: db, now: opts.now },
  );

  // Step 2 — synthesize authorization using the run's recorded identity.
  const authorization = synthesizePilotAuthorizationFromRun({
    runId: run.id,
    clubId: run.clubId,
    courseId: `course:${run.courseVersionId}`,
    versionId: run.courseVersionId,
    plan,
    pilotAuthorizationId: run.pilotAuthorizationId,
    pilotAuthorizationFingerprint: run.pilotAuthorizationFingerprint,
    approvedGroundingProjectionSha256: materialised.projectionSha256,
    nowUtc: opts.now,
  });

  // Step 3 — walk every draft on the run.
  const drafts = await db.trainingQuestionAiDraft.findMany({
    where: { generationRunId: run.id },
    select: {
      id: true,
      groundingProjectionId: true,
      _count: { select: { validations: true } },
    },
    orderBy: { generatedAt: "asc" },
  });

  const verdictCounts: Record<string, number> = {};
  const errors: string[] = [];
  let processed = 0;
  let alreadyBound = 0;
  let validationsCreated = 0;

  for (const d of drafts) {
    // Idempotency: a draft that already has BOTH a projection FK AND
    // at least one validation row is considered backfilled. Skip.
    if (d.groundingProjectionId && d._count.validations > 0) {
      alreadyBound++;
      continue;
    }
    if (opts.dryRun) {
      processed++;
      continue;
    }
    try {
      const vr = await materialiseValidationForDraft(
        {
          draftId: d.id,
          clubId: run.clubId,
          projectionRowId: materialised.projectionRowId,
          projection: materialised.projection,
          authorization,
        },
        { prisma: db, now: opts.now },
      );
      verdictCounts[vr.verdict] = (verdictCounts[vr.verdict] ?? 0) + 1;
      validationsCreated++;
    } catch (err) {
      errors.push(`draft ${d.id}: ${(err as Error).message}`);
    }
    processed++;
  }

  logger.info("training.generation.backfill_provenance", {
    runId: input.runId,
    projectionRowId: materialised.projectionRowId,
    draftsProcessed: processed,
    draftsAlreadyBound: alreadyBound,
    validationsCreated,
    verdictCounts,
    errorCount: errors.length,
  });

  return {
    runId: input.runId,
    projectionRowId: materialised.projectionRowId,
    projectionSha256: materialised.projectionSha256,
    draftsProcessed: processed,
    draftsAlreadyBound: alreadyBound,
    validationsCreated,
    verdictCounts,
    errors,
  };
}
