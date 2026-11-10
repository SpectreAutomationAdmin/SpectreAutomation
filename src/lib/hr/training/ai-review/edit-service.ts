// EP-TRAIN-4Y-AB §4 (2026-11-10) — manager inline-edit service for
// AI training drafts.
//
// Goal: allow a CLUB_ADMIN manager to inline-edit a REQUIRES_HUMAN_REVIEW
// AI draft (question text / options / correct answer / explanation)
// from the Manager Review surface, WITHOUT bypassing:
//
//   - tenant isolation (clubId filter on every query)
//   - the lifecycle state machine (uses writeStateTransition, which
//     revalidates `requires[]` inside the transaction via
//     evaluateTransition — cannot be short-circuited)
//   - the sanitiser (EMPLOYEE_FACING_TEXT_LEAKAGE patterns remain
//     refused; a manager edit that reintroduces a leakage is rejected
//     before any mutation)
//   - separation of duties — editing moves the draft to
//     EDITED_VALIDATION_STALE, NEVER APPROVED_DRAFT. A subsequent
//     reviewer-approval path (hr:training:ai:approve — explicitly not
//     granted to CLUB_ADMIN) is still required.
//   - optimistic concurrency — the caller's expectedContentHash +
//     expectedRecordVersion must match current DB state.
//   - audit — a TrainingQuestionAiStateTransition row records
//     fromState / toState / reasonCode / actor / recordVersion
//     deltas, and a supplementary audit() entry records the inline
//     before/after content for operator inspection.
//
// On success:
//   - A NEW TrainingQuestionAiDraft row is created with:
//       state = EDITED_VALIDATION_STALE
//       supersedesDraftId = oldDraftId
//       draftJson = manager-edited canonical body
//       contentHash = sha256(canonical body)
//       all source-material bindings (sourceVideoSha256,
//       resolvedTranscriptBuildId, groundingProjectionSha256,
//       groundingProjectionId, pilotAuthorizationId,
//       pilotAuthorizationFingerprint) are CARRIED FROM THE PARENT
//       — the edit does not invent provenance; it inherits it.
//   - The OLD draft transitions
//       REQUIRES_HUMAN_REVIEW → ARCHIVED (reason SUPERSEDED_BY_EDIT)
//     via writeStateTransition (the lifecycle table requires
//     `hr:training:ai:edit` for this transition — the service refuses
//     if the caller lacks it).
//   - The caller MUST invoke the revalidation endpoint next; this
//     service does NOT auto-revalidate (that's the reviewer's turn).
//
// Returns the new draft id + its new contentHash so the client can
// poll the freshly-revalidated state.

import { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { hasPermission, type Principal } from "@/lib/rbac";
import {
  AppError,
  UnauthenticatedError,
  ValidationError,
} from "@/lib/errors";
import { writeStateTransition, TransitionBlockedError } from "./transactional-audit";
import { canonicalise, sha256Hex } from "./content-hash";
import {
  checkEmployeeFacingText,
  codesForAudit,
} from "./question-text-sanitizer";
// EP-TRAIN-4Y-AE §4 (2026-11-10) — structure validator composes with
// the AA text sanitiser. Where the sanitiser caught internal
// terminology, this one catches structural defects (option bodies in
// the stem, missing correct designation, duplicate options, …).
import { checkQuestionStructure } from "./question-structure-validator";

export type EditRejectionCode =
  | "EDIT_FORBIDDEN"
  | "EDIT_DRAFT_NOT_FOUND"
  | "EDIT_STATE_NOT_EDITABLE"
  | "EDIT_CONTENT_HASH_MISMATCH"
  | "EDIT_RECORD_VERSION_MISMATCH"
  | "EDIT_QUESTION_TYPE_INVALID"
  | "EDIT_OPTION_COUNT_INVALID"
  | "EDIT_CORRECT_INDEX_OUT_OF_RANGE"
  | "EDIT_TEXT_LEAKAGE"
  // EP-TRAIN-4Y-AE §4 — structure-level defect (option bodies in
  // stem, embedded answer key, duplicate options, missing correct).
  | "EDIT_STRUCTURE_INVALID"
  | "EDIT_LIFECYCLE_BLOCKED"
  | "EDIT_EMPTY_QUESTION_TEXT"
  | "EDIT_DUPLICATE_OF_PARENT";

export class EditRejectedError extends AppError {
  readonly rejectionCode: EditRejectionCode;
  readonly detail: Record<string, unknown>;

  constructor(
    rejectionCode: EditRejectionCode,
    message: string,
    httpStatus: number,
    detail: Record<string, unknown> = {},
  ) {
    super(rejectionCode, message, httpStatus);
    this.rejectionCode = rejectionCode;
    this.detail = detail;
  }
}

export interface EditDraftInput {
  readonly draftId: string;
  readonly questionText: string;
  readonly options: ReadonlyArray<{ readonly text: string; readonly isCorrect: boolean }>;
  readonly explanation: string;
  readonly expectedContentHash: string;
  readonly expectedRecordVersion: number;
  readonly reviewerNote?: string;
}

export interface EditDraftResult {
  readonly ok: true;
  readonly newDraftId: string;
  readonly newContentHash: string;
  readonly newState: "EDITED_VALIDATION_STALE";
  readonly supersedesDraftId: string;
}

const QUESTION_TEXT_MIN = 10;
const QUESTION_TEXT_MAX = 1200;
const OPTION_TEXT_MAX = 400;
const EXPLANATION_MAX = 1200;
const REVIEWER_NOTE_MAX = 500;

export async function editAiDraft(
  principal: Principal | null,
  clubId: string,
  input: EditDraftInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<EditDraftResult> {
  if (!principal) throw new UnauthenticatedError();
  const db = opts.prisma ?? defaultPrisma;

  // Permission gate — same key the lifecycle transition requires.
  if (!hasPermission(principal, clubId, "hr:training:ai:edit")) {
    throw new EditRejectedError(
      "EDIT_FORBIDDEN",
      "Edit blocked: caller lacks hr:training:ai:edit on the active club.",
      403,
    );
  }

  // Pre-tx input validation.
  if (typeof input.draftId !== "string" || input.draftId.length === 0) {
    throw new ValidationError([{ path: "draftId", message: "required" }]);
  }
  if (typeof input.questionText !== "string") {
    throw new ValidationError([{ path: "questionText", message: "string required" }]);
  }
  const trimmedQ = input.questionText.trim();
  if (trimmedQ.length < QUESTION_TEXT_MIN) {
    throw new EditRejectedError(
      "EDIT_EMPTY_QUESTION_TEXT",
      `Edit blocked: question text must be at least ${QUESTION_TEXT_MIN} characters.`,
      400,
      { minLength: QUESTION_TEXT_MIN, actualLength: trimmedQ.length },
    );
  }
  if (trimmedQ.length > QUESTION_TEXT_MAX) {
    throw new ValidationError([
      { path: "questionText", message: `must be <= ${QUESTION_TEXT_MAX} chars` },
    ]);
  }
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 8) {
    throw new EditRejectedError(
      "EDIT_OPTION_COUNT_INVALID",
      "Edit blocked: a question must have between 2 and 8 options.",
      400,
      { actualOptionCount: Array.isArray(input.options) ? input.options.length : 0 },
    );
  }
  const trimmedOptions = input.options.map((o, i) => {
    if (typeof o?.text !== "string") {
      throw new ValidationError([{ path: `options[${i}].text`, message: "string required" }]);
    }
    const t = o.text.trim();
    if (t.length === 0) {
      throw new ValidationError([
        { path: `options[${i}].text`, message: "cannot be empty" },
      ]);
    }
    if (t.length > OPTION_TEXT_MAX) {
      throw new ValidationError([
        { path: `options[${i}].text`, message: `must be <= ${OPTION_TEXT_MAX} chars` },
      ]);
    }
    return { text: t, isCorrect: !!o.isCorrect };
  });
  const correctCount = trimmedOptions.reduce((n, o) => n + (o.isCorrect ? 1 : 0), 0);
  if (correctCount !== 1) {
    throw new EditRejectedError(
      "EDIT_CORRECT_INDEX_OUT_OF_RANGE",
      "Edit blocked: exactly one option must be marked correct.",
      400,
      { correctCount },
    );
  }
  const trimmedExplanation = (input.explanation ?? "").toString().trim().slice(0, EXPLANATION_MAX);
  if (input.reviewerNote !== undefined && input.reviewerNote.length > REVIEWER_NOTE_MAX) {
    throw new ValidationError([
      { path: "reviewerNote", message: `must be <= ${REVIEWER_NOTE_MAX} chars` },
    ]);
  }

  // Sanitiser — a manager edit that reintroduces internal pipeline
  // phrasing is refused before the transaction opens. Composes with
  // the 4Y-AA approval-service sanitiser so leakage can neither land
  // in a new draft nor slip past approval.
  const sanitiseResult = checkEmployeeFacingText({
    questionText: trimmedQ,
    options: trimmedOptions,
    explanation: trimmedExplanation || null,
  });
  if (!sanitiseResult.ok) {
    throw new EditRejectedError(
      "EDIT_TEXT_LEAKAGE",
      "Edit blocked: the edited text still contains internal pipeline terminology. Remove the flagged phrases and try again.",
      409,
      {
        findingCodes: codesForAudit(sanitiseResult),
        findings: sanitiseResult.findings,
      },
    );
  }

  // EP-TRAIN-4Y-AE §4 — structure validator. A clean-text edit that
  // reintroduces embedded options in the stem, a duplicate option, a
  // missing correct designation, or an answer-key leak is refused
  // here BEFORE a new draft row is created.
  const structureResult = checkQuestionStructure({
    questionText: trimmedQ,
    options: trimmedOptions,
    explanation: trimmedExplanation || null,
  });
  if (!structureResult.ok) {
    throw new EditRejectedError(
      "EDIT_STRUCTURE_INVALID",
      "Edit blocked: the question's structure is invalid. The stem must contain only the question; answer options and correct-answer metadata must live in their own fields.",
      409,
      {
        findingCodes: structureResult.findings.map((f) => f.code),
        findings: structureResult.findings,
      },
    );
  }

  // Transaction. The lifecycle-enforcing writeStateTransition is
  // called with the actor's permissions set, so lifecycle requires[]
  // are re-checked inside the tx; a direct Prisma transition that
  // bypasses it is NOT performed.
  const actorPermissions = new Set<string>([
    "hr:training:ai:edit",
    ...(hasPermission(principal, clubId, "hr:training:ai:revalidate")
      ? ["hr:training:ai:revalidate"]
      : []),
    ...(hasPermission(principal, clubId, "hr:training:ai:read")
      ? ["hr:training:ai:read"]
      : []),
  ]);

  let result: EditDraftResult;
  try {
    result = await db.$transaction(async (tx) => {
      // 1. Load the parent draft tenant-scoped.
      const parent = await tx.trainingQuestionAiDraft.findFirst({
        where: { id: input.draftId, clubId },
        select: {
          id: true,
          clubId: true,
          courseId: true,
          courseVersionId: true,
          state: true,
          contentHash: true,
          recordVersion: true,
          draftJson: true,
          sourceVideoSha256: true,
          resolvedTranscriptBuildId: true,
          groundingProjectionSha256: true,
          groundingProjectionId: true,
          pilotAuthorizationId: true,
          pilotAuthorizationFingerprint: true,
          generationRunId: true,
        },
      });
      if (!parent) {
        throw new EditRejectedError(
          "EDIT_DRAFT_NOT_FOUND",
          "Edit blocked: draft not found.",
          404,
        );
      }
      // Only REQUIRES_HUMAN_REVIEW / GENERATED / VALIDATION_PENDING /
      // VALIDATION_FAILED / EDITED_VALIDATION_STALE are editable per
      // the lifecycle table. We refuse APPROVED_DRAFT + REJECTED +
      // ARCHIVED explicitly here (the lifecycle table would refuse
      // too, but a clear 409 at this layer gives a better error).
      const editableFrom = new Set([
        "GENERATED",
        "VALIDATION_PENDING",
        "REQUIRES_HUMAN_REVIEW",
        "EDITED_VALIDATION_STALE",
        "VALIDATION_FAILED",
      ]);
      if (!editableFrom.has(parent.state)) {
        throw new EditRejectedError(
          "EDIT_STATE_NOT_EDITABLE",
          `Edit blocked: a draft in state ${parent.state} cannot be edited.`,
          409,
          { state: parent.state },
        );
      }
      if (parent.contentHash !== input.expectedContentHash) {
        throw new EditRejectedError(
          "EDIT_CONTENT_HASH_MISMATCH",
          "Edit blocked: the draft changed since you opened the editor. Refresh and retry.",
          409,
          {
            currentContentHash: parent.contentHash,
            submittedContentHash: input.expectedContentHash,
          },
        );
      }
      if (parent.recordVersion !== input.expectedRecordVersion) {
        throw new EditRejectedError(
          "EDIT_RECORD_VERSION_MISMATCH",
          "Edit blocked: the draft changed since you opened the editor. Refresh and retry.",
          409,
          {
            currentRecordVersion: parent.recordVersion,
            submittedRecordVersion: input.expectedRecordVersion,
          },
        );
      }

      // 2. Preserve the original canonical body's `questionType` +
      //    `sourceSegmentIds` — the manager cannot change either from
      //    the inline editor. This matches the directive's "Preserve
      //    the existing question type and validation rules" + "Preserve
      //    source-segment IDs in provenance".
      let parentBody: {
        questionType?: unknown;
        sourceSegmentIds?: unknown;
      } = {};
      try {
        parentBody = JSON.parse(parent.draftJson || "{}");
      } catch {
        parentBody = {};
      }
      const questionType =
        typeof parentBody.questionType === "string"
          ? parentBody.questionType
          : "SINGLE_CHOICE";
      if (
        questionType !== "SINGLE_CHOICE" &&
        questionType !== "TRUE_FALSE" &&
        questionType !== "MULTI_ANSWER"
      ) {
        throw new EditRejectedError(
          "EDIT_QUESTION_TYPE_INVALID",
          "Edit blocked: parent draft has an unrecognised question type.",
          409,
          { questionType },
        );
      }
      if (
        questionType === "TRUE_FALSE" &&
        trimmedOptions.length !== 2
      ) {
        throw new EditRejectedError(
          "EDIT_OPTION_COUNT_INVALID",
          "Edit blocked: TRUE_FALSE questions must have exactly 2 options.",
          409,
          { actualOptionCount: trimmedOptions.length },
        );
      }
      const sourceSegmentIds = Array.isArray(parentBody.sourceSegmentIds)
        ? (parentBody.sourceSegmentIds as unknown[]).filter(
            (n): n is number => typeof n === "number",
          )
        : [];

      const canonicalBody = {
        questionType,
        questionText: trimmedQ,
        options: trimmedOptions,
        explanation: trimmedExplanation,
        sourceSegmentIds: [...sourceSegmentIds],
      };
      const newContentHash = sha256Hex(canonicalise(canonicalBody));
      if (newContentHash === parent.contentHash) {
        throw new EditRejectedError(
          "EDIT_DUPLICATE_OF_PARENT",
          "Edit blocked: no substantive change versus the current draft.",
          409,
          { contentHash: newContentHash },
        );
      }

      // 3. Create the new superseding draft row in
      //    EDITED_VALIDATION_STALE. Same (clubId, courseVersionId,
      //    contentHash) unique collision would raise P2002; we map
      //    that to a 409 as a semantic duplicate.
      let newDraftId: string;
      try {
        const created = await tx.trainingQuestionAiDraft.create({
          data: {
            clubId: parent.clubId,
            courseId: parent.courseId,
            courseVersionId: parent.courseVersionId,
            generationRunId: parent.generationRunId,
            draftJson: JSON.stringify(canonicalBody),
            contentHash: newContentHash,
            sourceVideoSha256: parent.sourceVideoSha256,
            resolvedTranscriptBuildId: parent.resolvedTranscriptBuildId,
            groundingProjectionSha256: parent.groundingProjectionSha256,
            ...(parent.groundingProjectionId
              ? { groundingProjectionId: parent.groundingProjectionId }
              : {}),
            pilotAuthorizationId: parent.pilotAuthorizationId,
            pilotAuthorizationFingerprint: parent.pilotAuthorizationFingerprint,
            // Lifecycle: new row lands in EDITED_VALIDATION_STALE.
            // The 4Y-AB directive forbids auto-approval; this state
            // requires a subsequent REVALIDATE + REVIEW cycle.
            state: "EDITED_VALIDATION_STALE",
            stateChangedByUserId: principal.id,
            recordVersion: 0,
            generatedAt: new Date(),
            generatedByUserId: principal.id,
            supersedesDraftId: parent.id,
          },
          select: { id: true },
        });
        newDraftId = created.id;
      } catch (err) {
        if ((err as { code?: string })?.code === "P2002") {
          throw new EditRejectedError(
            "EDIT_DUPLICATE_OF_PARENT",
            "Edit blocked: another draft with the same body already exists for this version.",
            409,
            { newContentHash },
          );
        }
        throw err;
      }

      // 4. Archive the parent via writeStateTransition — the
      //    lifecycle table's requires[] = ["hr:training:ai:edit"] is
      //    re-checked inside this tx.
      await writeStateTransition({
        tx,
        draftId: parent.id,
        clubId: parent.clubId,
        fromState: parent.state as never,
        toState: "ARCHIVED",
        reasonCode: "SUPERSEDED_BY_EDIT",
        reasonDetail: `Superseded by inline edit ${newDraftId}`,
        actor: principal,
        actorPermissions,
        expectedRecordVersion: parent.recordVersion,
        meta: {
          source: "ep-train-4y-ab.manager-inline-edit",
          newDraftId,
          newContentHash,
          reviewerNote: input.reviewerNote ?? null,
        },
      });

      return {
        ok: true as const,
        newDraftId,
        newContentHash,
        newState: "EDITED_VALIDATION_STALE" as const,
        supersedesDraftId: parent.id,
      };
    });
  } catch (err) {
    if (err instanceof TransitionBlockedError) {
      throw new EditRejectedError(
        "EDIT_LIFECYCLE_BLOCKED",
        `Edit blocked: lifecycle rejected the archive step (${err.code}).`,
        409,
        { lifecycleCode: err.code, detail: err.detail },
      );
    }
    throw err;
  }

  // Supplementary audit outside the transaction (per audit() contract
  // in CLAUDE.md — audit() never throws; it must not block the
  // mutation it summarises).
  await audit(principal, {
    action: "hr.training.ai-draft.inline-edit",
    entityType: "TrainingQuestionAiDraft",
    entityId: result.newDraftId,
    clubId,
    before: { draftId: input.draftId, contentHash: input.expectedContentHash },
    after: { draftId: result.newDraftId, contentHash: result.newContentHash },
    meta: {
      supersedesDraftId: result.supersedesDraftId,
      newState: result.newState,
    },
  });

  return result;
}
