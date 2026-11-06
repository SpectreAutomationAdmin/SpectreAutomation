// EP-TRAIN-6D-4T (2026-11-06) — Approved AI draft → TrainingQuestion
// promotion service.
//
// The ONLY code path that may:
//   - copy an approved TrainingQuestionAiDraft's content into a
//     publishable TrainingQuestion + TrainingAnswerOption rows;
//   - write a TrainingQuestionAiDraftPromotion row linking the two.
//
// The browser's displayed destination is NEVER trusted — the server
// re-loads the draft + validation + verified-answer via the 4N reader
// + 4M evidence reader, re-verifies every binding, then writes.
//
// Founder-authorised on 2026-11-06 with eight conditions. See
// docs/training/ai-generation/PHASE-D-4T-PROMOTION-DESIGN.md.

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { hasPermission, type Principal } from "@/lib/rbac";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/lib/errors";
import { canonicalise, sha256Hex } from "./content-hash";
import { resolveVerifiedAnswer } from "./verified-answer-reader";
import { resolveCandidateEvidence } from "./evidence-reader";

export type PromoteRejectionCode =
  | "DRAFT_NOT_FOUND"                        // 404 — cross-tenant or missing
  | "DRAFT_NOT_APPROVED"                     // 409 — state not APPROVED_DRAFT
  | "CONTENT_HASH_MISMATCH"                  // 409 — stale
  | "VALIDATION_MISMATCH"                    // 409 — stale
  | "VERIFIED_ANSWER_MISSING"                // 409 — 4N reader didn't resolve verified
  | "VERIFIED_ANSWER_INTEGRITY_FAIL"         // 409
  | "EVIDENCE_HISTORICAL_UNAVAILABLE"        // 409
  | "EVIDENCE_INTEGRITY_FAILURE"             // 409
  | "QUESTION_TYPE_UNSUPPORTED"              // 409 — MULTI_ANSWER refused
  | "CHECKPOINT_NOT_FOUND"                   // 404
  | "CHECKPOINT_CROSS_COURSE"                // 409
  | "COURSE_VERSION_NOT_DRAFT"               // 409 — target is PUBLISHED / RETIRED
  | "ALREADY_PROMOTED_SAME_DESTINATION"      // 200 replay (not thrown; sentinel)
  | "ALREADY_PROMOTED_DIFFERENT_DESTINATION";// 409 — refuses silent dest change

export class PromoteRejectedError extends AppError {
  readonly rejectionCode: PromoteRejectionCode;
  readonly detail: Record<string, unknown>;

  constructor(
    rejectionCode: PromoteRejectionCode,
    message: string,
    httpStatus: number,
    detail: Record<string, unknown> = {},
  ) {
    super(rejectionCode, message, httpStatus);
    this.rejectionCode = rejectionCode;
    this.detail = detail;
  }
}

export type PromotionDestination =
  | { readonly kind: "CHECKPOINT"; readonly checkpointId: string }
  | { readonly kind: "FINAL_ASSESSMENT" };

export interface PromoteApprovedDraftInput {
  readonly draftId: string;
  readonly destination: PromotionDestination;
  readonly expectedDraftContentHash: string;
  readonly expectedValidationId: string;
}

export interface PromoteApprovedDraftResult {
  readonly ok: true;
  readonly questionId: string;
  readonly destinationKind: "CHECKPOINT" | "FINAL_ASSESSMENT";
  readonly checkpointId: string | null;
  readonly promotionId: string;
  readonly replay: boolean;
}

const SUPPORTED_QUESTION_TYPES = new Set(["SINGLE_CHOICE", "TRUE_FALSE"]);

type ParsedDraft = {
  readonly questionType: string;
  readonly questionText: string;
  readonly options: readonly { readonly text: string; readonly isCorrect: boolean }[];
  readonly explanation: string;
  readonly sourceSegmentIds: readonly number[];
};

function safeParseDraft(json: string): ParsedDraft | null {
  try {
    const r = JSON.parse(json) as Partial<ParsedDraft>;
    if (typeof r.questionType !== "string") return null;
    if (typeof r.questionText !== "string") return null;
    if (!Array.isArray(r.options)) return null;
    for (const o of r.options as unknown[]) {
      if (typeof o !== "object" || o === null) return null;
      const opt = o as Record<string, unknown>;
      if (typeof opt.text !== "string" || typeof opt.isCorrect !== "boolean") return null;
    }
    return {
      questionType: r.questionType,
      questionText: r.questionText,
      options: r.options as ParsedDraft["options"],
      explanation: typeof r.explanation === "string" ? r.explanation : "",
      sourceSegmentIds: Array.isArray(r.sourceSegmentIds)
        ? (r.sourceSegmentIds as unknown[]).filter((n) => typeof n === "number") as number[]
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Canonical hash of the promoted TrainingQuestion + options AT PROMOTION
 * TIME. The 4T publish gate later recomputes this against the current
 * question content and refuses publication on divergence (founder
 * condition 5 on 2026-11-06).
 *
 * Shape is independent of DB row ids so a round-trip through the DB is
 * stable. Keys sorted deterministically by canonicalise().
 */
export function promotedQuestionContentHash(input: {
  readonly prompt: string;
  readonly questionType: string;
  readonly checkpointId: string | null;
  readonly options: readonly { readonly text: string; readonly isCorrect: boolean }[];
}): string {
  const canonicalOptions = [...input.options].map((o) => ({
    text: o.text,
    isCorrect: o.isCorrect,
  }));
  return sha256Hex(
    canonicalise({
      schemaVersion: "training-question-promotion-v1",
      prompt: input.prompt,
      questionType: input.questionType,
      checkpointId: input.checkpointId,
      options: canonicalOptions,
    }),
  );
}

/**
 * Promote an APPROVED_DRAFT draft into a publishable TrainingQuestion.
 * Atomic + idempotent + audit-attached.
 *
 * On success: writes (atomically, in ONE $transaction):
 *   1. `TrainingQuestion` with the draft's canonical content + the
 *      human-verified answer (NOT the model-selected).
 *   2. `TrainingAnswerOption` rows (one per draft option, displayOrder
 *      preserved).
 *   3. `TrainingQuestionAiDraftPromotion` sidecar row with immutable
 *      approval bindings + divergence-detection hash.
 *
 * On idempotent replay (same draft + same destination): returns the
 * cached result without mutation.
 *
 * On conflicting replay (same draft + different destination): refuses
 * with ALREADY_PROMOTED_DIFFERENT_DESTINATION (409).
 *
 * Refuses: directive §5 eligibility matrix, enumerated above as
 * `PromoteRejectionCode`.
 *
 * `audit()` is called OUTSIDE the transaction, per CLAUDE.md non-
 * blocking pattern. The authoritative per-promotion record is the
 * sidecar row (written inside the transaction).
 */
export async function promoteApprovedDraft(
  principal: Principal | null,
  clubId: string,
  input: PromoteApprovedDraftInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<PromoteApprovedDraftResult> {
  if (!principal) throw new UnauthenticatedError();
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    throw new ForbiddenError("hr:training:write required");
  }

  const db = opts.prisma ?? defaultPrisma;

  // ------- 1. Load draft + verify tenant + APPROVED_DRAFT state. -------
  const draft = await db.trainingQuestionAiDraft.findFirst({
    where: { id: input.draftId, clubId },
    select: {
      id: true, clubId: true, courseVersionId: true,
      state: true, contentHash: true, recordVersion: true,
      draftJson: true, groundingProjectionId: true,
    },
  });
  if (!draft) {
    // Cross-tenant or missing → same-shape 404.
    throw new PromoteRejectedError("DRAFT_NOT_FOUND", "Draft not found.", 404);
  }
  if (draft.state !== "APPROVED_DRAFT") {
    throw new PromoteRejectedError(
      "DRAFT_NOT_APPROVED",
      `Only APPROVED_DRAFT candidates can be promoted. Current state: ${draft.state}.`,
      409,
      { currentState: draft.state },
    );
  }
  if (draft.contentHash !== input.expectedDraftContentHash) {
    throw new PromoteRejectedError(
      "CONTENT_HASH_MISMATCH",
      "The approved draft has changed since you loaded this view. Refresh and try again.",
      409,
    );
  }

  // ------- 2. Re-run 4M evidence reader (defence in depth). -------
  const evidence = await resolveCandidateEvidence(principal, clubId, draft.id, { prisma: db });
  if (!evidence) {
    throw new PromoteRejectedError("DRAFT_NOT_FOUND", "Draft not found.", 404);
  }
  if (evidence.kind === "historical-unavailable") {
    throw new PromoteRejectedError(
      "EVIDENCE_HISTORICAL_UNAVAILABLE",
      "Historical pilot drafts cannot be promoted.",
      409,
    );
  }
  if (evidence.kind === "evidence-integrity-failure") {
    throw new PromoteRejectedError(
      "EVIDENCE_INTEGRITY_FAILURE",
      "Evidence integrity cannot be confirmed; promotion refused.",
      409,
      { code: evidence.code },
    );
  }
  // At this point evidence.kind === "authentic".

  // ------- 3. Re-run 4N verified-answer reader (defence in depth). -------
  const verified = await resolveVerifiedAnswer(principal, clubId, draft.id, { prisma: db });
  if (!verified) {
    throw new PromoteRejectedError("DRAFT_NOT_FOUND", "Draft not found.", 404);
  }
  if (verified.kind === "unverified") {
    throw new PromoteRejectedError(
      "VERIFIED_ANSWER_MISSING",
      "No verified-correct answer snapshot exists on this draft. Approve the draft first.",
      409,
    );
  }
  if (verified.kind === "integrity-warning") {
    throw new PromoteRejectedError(
      "VERIFIED_ANSWER_INTEGRITY_FAIL",
      "Verified-answer snapshot integrity check failed; promotion refused.",
      409,
      { code: verified.code },
    );
  }
  // At this point verified.kind === "verified".
  if (verified.validationId !== input.expectedValidationId) {
    throw new PromoteRejectedError(
      "VALIDATION_MISMATCH",
      "The validation id you supplied does not match the current approval.",
      409,
    );
  }

  // ------- 4. Parse + guard question type / cardinality. -------
  const parsed = safeParseDraft(draft.draftJson);
  if (!parsed) {
    throw new PromoteRejectedError(
      "VERIFIED_ANSWER_INTEGRITY_FAIL",
      "The draft body is malformed; promotion refused.",
      409,
    );
  }
  if (!SUPPORTED_QUESTION_TYPES.has(parsed.questionType)) {
    throw new PromoteRejectedError(
      "QUESTION_TYPE_UNSUPPORTED",
      `Question type ${parsed.questionType} is not supported for promotion in this slice.`,
      409,
      { questionType: parsed.questionType },
    );
  }
  if (
    verified.optionIndex < 0 ||
    verified.optionIndex >= parsed.options.length
  ) {
    throw new PromoteRejectedError(
      "VERIFIED_ANSWER_INTEGRITY_FAIL",
      "Verified option index is out of range.",
      409,
    );
  }
  if (parsed.options.length < 2) {
    throw new PromoteRejectedError(
      "VERIFIED_ANSWER_INTEGRITY_FAIL",
      "Fewer than two options on the draft — refusing.",
      409,
    );
  }

  // ------- 5. Resolve destination + verify ownership. -------
  const version = await db.trainingCourseVersion.findUnique({
    where: { id: draft.courseVersionId },
    select: {
      id: true, state: true,
      course: { select: { id: true, clubId: true } },
    },
  });
  if (!version || version.course.clubId !== clubId) {
    throw new PromoteRejectedError("DRAFT_NOT_FOUND", "Draft not found.", 404);
  }
  if (version.state !== "DRAFT") {
    throw new PromoteRejectedError(
      "COURSE_VERSION_NOT_DRAFT",
      `Cannot promote onto a ${version.state} course version. Open a new draft first.`,
      409,
      { versionState: version.state },
    );
  }

  let destinationCheckpointId: string | null = null;
  if (input.destination.kind === "CHECKPOINT") {
    const cp = await db.trainingCheckpoint.findUnique({
      where: { id: input.destination.checkpointId },
      select: { id: true, courseVersionId: true },
    });
    if (!cp) {
      throw new PromoteRejectedError(
        "CHECKPOINT_NOT_FOUND",
        "Checkpoint not found.",
        404,
      );
    }
    if (cp.courseVersionId !== draft.courseVersionId) {
      throw new PromoteRejectedError(
        "CHECKPOINT_CROSS_COURSE",
        "Checkpoint does not belong to the draft's course version.",
        409,
      );
    }
    destinationCheckpointId = cp.id;
  }

  // ------- 6. Idempotency pre-check (outside the tx). -------
  const existing = await db.trainingQuestionAiDraftPromotion.findUnique({
    where: { draftId: draft.id },
    select: {
      id: true,
      questionId: true,
      destination: true,
      checkpointId: true,
    },
  });
  if (existing) {
    const sameDestination =
      existing.destination === input.destination.kind &&
      existing.checkpointId === destinationCheckpointId;
    if (sameDestination) {
      return {
        ok: true,
        questionId: existing.questionId,
        destinationKind: existing.destination as "CHECKPOINT" | "FINAL_ASSESSMENT",
        checkpointId: existing.checkpointId,
        promotionId: existing.id,
        replay: true,
      };
    }
    throw new PromoteRejectedError(
      "ALREADY_PROMOTED_DIFFERENT_DESTINATION",
      "This draft has already been promoted to a different destination. Revert the earlier promotion first.",
      409,
      {
        existingQuestionId: existing.questionId,
        existingDestination: existing.destination,
        existingCheckpointId: existing.checkpointId,
      },
    );
  }

  // ------- 7. Build canonical option rows with HUMAN-VERIFIED answer. -------
  const answerOptions = parsed.options.map((o, i) => ({
    text: o.text,
    isCorrect: i === verified.optionIndex,
    displayOrder: i,
  }));

  // ------- 8. Compute displayOrder for the new question. -------
  const maxOrder = await db.trainingQuestion.aggregate({
    where: {
      courseVersionId: draft.courseVersionId,
      checkpointId: destinationCheckpointId,
    },
    _max: { displayOrder: true },
  });
  const nextOrder = (maxOrder._max.displayOrder ?? -1) + 1;

  // ------- 9. Atomic transaction — Question + Options + sidecar. -------
  let result: PromoteApprovedDraftResult;
  try {
    result = await db.$transaction(async (tx) => {
      const q = await tx.trainingQuestion.create({
        data: {
          courseVersionId: draft.courseVersionId,
          prompt: parsed.questionText,
          displayOrder: nextOrder,
          active: true,
          questionType: parsed.questionType,
          checkpointId: destinationCheckpointId,
        },
      });
      for (const [i, o] of answerOptions.entries()) {
        await tx.trainingAnswerOption.create({
          data: {
            questionId: q.id,
            text: o.text,
            isCorrect: o.isCorrect,
            displayOrder: i,
          },
        });
      }

      // Divergence-detection hash: SAME canonical shape the publish
      // gate will recompute later.
      const hash = promotedQuestionContentHash({
        prompt: parsed.questionText,
        questionType: parsed.questionType,
        checkpointId: destinationCheckpointId,
        options: answerOptions,
      });

      const promotion = await tx.trainingQuestionAiDraftPromotion.create({
        data: {
          clubId,
          draftId: draft.id,
          questionId: q.id,
          destination: input.destination.kind,
          checkpointId: destinationCheckpointId,
          approvedDraftContentHash: draft.contentHash,
          approvedValidationId: verified.validationId,
          verifiedAnswerOptionIndex: verified.optionIndex,
          verifiedAnswerSnapshotHash: sha256Hex(
            canonicalise({
              schemaVersion: "verified-correct-answer-snapshot-v1",
              optionIndex: verified.optionIndex,
              optionText: verified.optionText,
              validationId: verified.validationId,
              draftContentHash: draft.contentHash,
            }),
          ),
          approvedReviewId: verified.reviewId,
          approvedByUserId: verified.verifiedByUserId,
          promotedQuestionContentHash: hash,
          promotedByUserId: principal.id,
        },
      });

      return {
        ok: true as const,
        questionId: q.id,
        destinationKind: input.destination.kind,
        checkpointId: destinationCheckpointId,
        promotionId: promotion.id,
        replay: false,
      };
    });
  } catch (err) {
    // Race: a concurrent transaction won the unique index on draftId.
    // Convert to the normal idempotency-conflict path: re-query +
    // compare destinations.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const retry = await db.trainingQuestionAiDraftPromotion.findUnique({
        where: { draftId: draft.id },
        select: {
          id: true,
          questionId: true,
          destination: true,
          checkpointId: true,
        },
      });
      if (retry) {
        const same =
          retry.destination === input.destination.kind &&
          retry.checkpointId === destinationCheckpointId;
        if (same) {
          return {
            ok: true,
            questionId: retry.questionId,
            destinationKind: retry.destination as
              | "CHECKPOINT"
              | "FINAL_ASSESSMENT",
            checkpointId: retry.checkpointId,
            promotionId: retry.id,
            replay: true,
          };
        }
        throw new PromoteRejectedError(
          "ALREADY_PROMOTED_DIFFERENT_DESTINATION",
          "This draft has already been promoted to a different destination.",
          409,
        );
      }
    }
    throw err;
  }

  // ------- 10. Post-commit audit (non-blocking). -------
  void audit(principal, {
    action: "hr.training.ai-draft.promote",
    entityType: "TrainingQuestion",
    entityId: result.questionId,
    clubId,
    after: {
      draftId: draft.id,
      promotionId: result.promotionId,
      destinationKind: result.destinationKind,
      checkpointId: result.checkpointId,
      verifiedOptionIndex: verified.optionIndex,
      approvedByUserId: verified.verifiedByUserId,
      approvedDraftContentHash: draft.contentHash,
      approvedValidationId: verified.validationId,
    },
  });

  return result;
}
