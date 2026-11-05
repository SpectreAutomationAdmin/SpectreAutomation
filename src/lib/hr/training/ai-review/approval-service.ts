// EP-TRAIN-6D-4N (2026-11-05) — Human-verified answer + server-
// authoritative approval service.
//
// The ONLY code path that may:
//   - transition a TrainingQuestionAiDraft from REQUIRES_HUMAN_REVIEW
//     to APPROVED_DRAFT;
//   - write TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson.
//
// Everything about this file is server-authoritative. The browser's
// displayed answer text is NEVER trusted — the server re-derives the
// option text from the stored, immutable `draftJson` using the
// client-supplied `verifiedCorrectAnswerIndex` only as an INDEX into
// that array. The client may supply `expectedOptionText` for
// double-booking, but a mismatch between it and the server-derived
// text is a hard refusal.
//
// Design origin: directive §§ 4–9. Composes:
//   - EP-TRAIN-6D-4B evaluateApprovalServerSide (approval-guard.ts)
//   - EP-TRAIN-6D-4B writeStateTransition         (transactional-audit.ts)
//   - EP-TRAIN-6D-4B TrainingQuestionAiOperationKey (idempotency)
//   - EP-TRAIN-6D-4B TrainingQuestionAiReview        (reviewer decision)
//   - EP-TRAIN-6D-4K verifiedCorrectAnswerSnapshotJson
//
// No schema change. All DB mutations in one Postgres transaction.

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
import {
  evaluateApprovalServerSide,
  type ServerApprovalDecision,
} from "./approval-guard";
import { writeStateTransition, TransitionBlockedError } from "./transactional-audit";
import { canonicalise, sha256Hex } from "./content-hash";

export type ApprovalRejectionCode =
  | "VERIFIED_ANSWER_MISSING"
  | "VERIFIED_ANSWER_OUT_OF_RANGE"
  | "VERIFIED_ANSWER_TEXT_MISMATCH"
  | "QUESTION_TYPE_INVALID"
  | "ANSWER_CARDINALITY_INVALID"
  | "VALIDATION_MISMATCH"
  | "EVIDENCE_ATTESTATION_MISSING"
  | "IDEMPOTENCY_CONFLICT"
  | "APPROVAL_GUARD_BLOCKED"
  | "TRANSITION_BLOCKED";

/** Error shape callers (API route handlers) should turn into HTTP
 *  responses. `httpStatus` preserves the 4B convention + adds 4N's
 *  specific 400 / 409 codes for verified-answer validation. */
export class ApprovalRejectedError extends AppError {
  readonly rejectionCode: ApprovalRejectionCode;
  readonly detail: Record<string, unknown>;

  constructor(
    rejectionCode: ApprovalRejectionCode,
    message: string,
    httpStatus: number,
    detail: Record<string, unknown> = {},
  ) {
    super(rejectionCode, message, httpStatus);
    this.rejectionCode = rejectionCode;
    this.detail = detail;
  }
}

export interface ApprovalRequestInput {
  readonly draftId: string;
  readonly expectedRecordVersion: number;
  readonly expectedContentHash: string;
  readonly expectedValidationId: string;
  readonly verifiedCorrectAnswerIndex: number;
  /** Optional belt-and-braces: if supplied, must byte-exact match the
   *  server-derived option text. Mismatch → VERIFIED_ANSWER_TEXT_MISMATCH. */
  readonly expectedOptionText?: string;
  /** Required attestation: the reviewer confirms they reviewed the
   *  source evidence. Must be `true`. */
  readonly evidenceAttestation: boolean;
  /** Required idempotency key (client-generated UUID v4). A replay
   *  with the same key + payload returns the cached response; a
   *  replay with the same key + different payload is refused. */
  readonly idempotencyKey: string;
  /** Optional free-form reviewer note (max 2000 chars). */
  readonly reviewerNote?: string;
}

export interface ApprovalSuccessResponse {
  readonly ok: true;
  readonly draftId: string;
  readonly reviewId: string;
  readonly validationId: string;
  readonly transitionId: string;
  readonly recordVersionAfter: number;
  readonly state: "APPROVED_DRAFT";
  readonly verifiedCorrectAnswer: {
    readonly optionIndex: number;
    readonly optionText: string;
    readonly verifiedByUserId: string;
    readonly verifiedAt: string;
  };
  readonly replay: boolean;
}

type DraftOption = { readonly text: string; readonly isCorrect: boolean };
type ParsedDraft = {
  readonly questionType: "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE" | string;
  readonly questionText: string;
  readonly options: readonly DraftOption[];
  readonly explanation: string;
  readonly sourceSegmentIds: readonly number[];
};

const APPROVE_ROUTE_IDEMPOTENCY_KEY = "POST /drafts/:id/approve";
const IDEMPOTENCY_TTL_HOURS = 24;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEWER_NOTE_MAX = 2000;

/**
 * Approve a draft candidate. Server-authoritative.
 *
 * On success: writes (atomically, in ONE Prisma $transaction):
 *   1. `TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson`
 *      on the validation row the reviewer was looking at.
 *   2. `TrainingQuestionAiReview` disposition=APPROVED row.
 *   3. `TrainingQuestionAiStateTransition` REQUIRES_HUMAN_REVIEW →
 *      APPROVED_DRAFT via `writeStateTransition` (which also updates
 *      the draft row's state + recordVersion with optimistic
 *      concurrency).
 *   4. `TrainingQuestionAiOperationKey` idempotency row keyed on
 *      (route, requestKey, reviewerUserId, draftId).
 *
 * On idempotent replay (same key, same payload): returns the cached
 * response without mutation.
 *
 * On conflicting replay (same key, different payload): refuses with
 * IDEMPOTENCY_CONFLICT.
 *
 * On any refusal from the 4B guard OR the 4N-specific checks: throws
 * `ApprovalRejectedError` with the appropriate HTTP status. No
 * mutation. The caller's API handler maps the error to the response.
 *
 * `audit()` is called OUTSIDE the transaction, per the CLAUDE.md
 * non-blocking-audit pattern. The AUTHORITATIVE per-lifecycle record
 * is the `TrainingQuestionAiStateTransition` row (written inside the
 * transaction).
 */
export async function approveTrainingQuestionCandidate(
  principal: Principal | null,
  clubId: string,
  input: ApprovalRequestInput,
  opts: { prisma?: PrismaClient; validationServiceHealthy?: boolean } = {},
): Promise<ApprovalSuccessResponse> {
  if (!principal) throw new UnauthenticatedError();

  const db = opts.prisma ?? defaultPrisma;

  // -------------------------------------------------------------------
  // Pre-transaction input validation (fast fail, no DB roundtrip).
  // -------------------------------------------------------------------
  if (typeof input.draftId !== "string" || input.draftId.length === 0) {
    throw new ValidationError([{ path: "draftId", message: "draftId required" }]);
  }
  if (!Number.isInteger(input.expectedRecordVersion) || input.expectedRecordVersion < 0) {
    throw new ValidationError([{ path: "expectedRecordVersion", message: "non-negative integer required" }]);
  }
  if (typeof input.expectedContentHash !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedContentHash)) {
    throw new ValidationError([{ path: "expectedContentHash", message: "64-char lowercase hex required" }]);
  }
  if (typeof input.expectedValidationId !== "string" || input.expectedValidationId.length === 0) {
    throw new ValidationError([{ path: "expectedValidationId", message: "required" }]);
  }
  if (!Number.isInteger(input.verifiedCorrectAnswerIndex)) {
    throw new ApprovalRejectedError(
      "VERIFIED_ANSWER_MISSING",
      "Approval blocked: a verified correct answer index is required.",
      400,
      { path: "verifiedCorrectAnswerIndex" },
    );
  }
  if (input.evidenceAttestation !== true) {
    throw new ApprovalRejectedError(
      "EVIDENCE_ATTESTATION_MISSING",
      "Approval blocked: the reviewer must attest that they reviewed the source evidence.",
      400,
      { path: "evidenceAttestation" },
    );
  }
  if (!UUID_V4_RE.test(input.idempotencyKey)) {
    throw new ValidationError([{ path: "idempotencyKey", message: "UUID v4 required" }]);
  }
  if (input.reviewerNote !== undefined && input.reviewerNote.length > REVIEWER_NOTE_MAX) {
    throw new ValidationError([
      { path: "reviewerNote", message: `must be <= ${REVIEWER_NOTE_MAX} chars` },
    ]);
  }

  // -------------------------------------------------------------------
  // Idempotency pre-check (OUTSIDE transaction — correct, because a
  // winning side will serialise via the DB unique index inside the tx
  // anyway, and a cache-hit avoids the whole transaction cost).
  // -------------------------------------------------------------------
  const payloadFingerprint = fingerprintRequest(input);
  const existingKey = await db.trainingQuestionAiOperationKey.findUnique({
    where: {
      route_requestKey_reviewerUserId_draftId: {
        route: APPROVE_ROUTE_IDEMPOTENCY_KEY,
        requestKey: input.idempotencyKey,
        reviewerUserId: principal.id,
        draftId: input.draftId,
      },
    },
    select: {
      responseBodyJson: true,
      responseHttpStatus: true,
      expiresAt: true,
    },
  });
  if (existingKey) {
    const cached = safeParse<Record<string, unknown>>(existingKey.responseBodyJson);
    if (cached && cached.__payloadFingerprint === payloadFingerprint) {
      // Replay match — return the cached response unchanged.
      const resp = cached.response as ApprovalSuccessResponse | undefined;
      if (resp && resp.ok) return { ...resp, replay: true };
    }
    // Same key, different payload (or unparseable cache) → refuse.
    throw new ApprovalRejectedError(
      "IDEMPOTENCY_CONFLICT",
      "Approval blocked: an earlier request used this idempotency key with a different payload.",
      409,
      { route: APPROVE_ROUTE_IDEMPOTENCY_KEY },
    );
  }

  // -------------------------------------------------------------------
  // Main transaction — all mutations atomic. P2002 on the operation
  // key is the DB-level race arbitrator (losing side raises; we map
  // to IDEMPOTENCY_CONFLICT at the end).
  // -------------------------------------------------------------------
  try {
    return await db.$transaction(async (tx) => {
      // 1. Load the draft + latest validation + course version with the
      //    same shape the guard expects. Tenant-scoped at the DB layer.
      const draft = await tx.trainingQuestionAiDraft.findFirst({
        where: { id: input.draftId, clubId },
        select: {
          id: true,
          clubId: true,
          courseVersionId: true,
          contentHash: true,
          sourceVideoSha256: true,
          state: true,
          recordVersion: true,
          draftJson: true,
          supersedesDraftId: true,
        },
      });
      // Draft missing OR cross-tenant → 404 same-shape via guard.
      // But also refuse SUPERSEDED drafts eagerly (a draft with a
      // non-null supersedesDraftId is the SUPERSEDING draft; a
      // draft that HAS been superseded carries state ARCHIVED or
      // EDITED_VALIDATION_STALE and the guard already refuses it
      // via STATE_NOT_APPROVABLE).
      const validation = draft
        ? await tx.trainingQuestionAiValidation.findUnique({
            where: { id: input.expectedValidationId },
            select: {
              id: true,
              draftId: true,
              clubId: true,
              draftContentHash: true,
              validatorSource: true,
              verdict: true,
              errorsJson: true,
            },
          })
        : null;

      // The guard was built to tolerate "latestValidation" or the
      // expected-validation-by-id. We pass the row the caller specified
      // in `expectedValidationId`, after enforcing it belongs to this
      // draft + tenant.
      let validationForGuard = validation ?? null;
      if (validation) {
        if (
          validation.draftId !== draft?.id ||
          validation.clubId !== clubId ||
          validation.draftContentHash !== draft?.contentHash
        ) {
          // Expected validation doesn't actually match the current draft.
          throw new ApprovalRejectedError(
            "VALIDATION_MISMATCH",
            "Approval blocked: the expected validation does not match the current draft content. Refresh and retry.",
            409,
            {
              expectedValidationId: input.expectedValidationId,
              draftId: input.draftId,
            },
          );
        }
      }

      const courseVersion = draft
        ? await tx.trainingCourseVersion.findUnique({
            where: { id: draft.courseVersionId },
            select: { id: true, videoSha256: true, state: true, retiredAt: true },
          })
        : null;

      const guardDecision = evaluateApprovalServerSide({
        principal,
        activeClubId: clubId,
        // The narrow DB-typed `state`/`verdict` strings are safe to
        // widen through the guard's shape — the guard performs its
        // own value-check on each.
        draft: draft as unknown as Parameters<typeof evaluateApprovalServerSide>[0]["draft"],
        latestValidation: validationForGuard as unknown as Parameters<typeof evaluateApprovalServerSide>[0]["latestValidation"],
        courseVersion,
        submittedContentHash: input.expectedContentHash,
        submittedRecordVersion: input.expectedRecordVersion,
        validationServiceHealthy: opts.validationServiceHealthy ?? true,
        hasPermission: (key) => hasPermission(principal, clubId, key as never),
      });
      if (!guardDecision.allowed) {
        throw guardRejection(guardDecision);
      }

      // The guard has confirmed everything. We now know `draft` and
      // `validation` are non-null and valid. Narrow + re-use.
      if (!draft || !validation) {
        throw new ApprovalRejectedError(
          "APPROVAL_GUARD_BLOCKED",
          "Approval blocked: internal invariant failure after guard passed.",
          500,
        );
      }

      // 2. Parse the draft's immutable options. The server derives the
      //    option text from here — NEVER from a client payload.
      const parsed = parseDraftJsonStrict(draft.draftJson);

      // 3. Question-type + cardinality checks.
      if (
        parsed.questionType !== "SINGLE_CHOICE" &&
        parsed.questionType !== "TRUE_FALSE" &&
        parsed.questionType !== "MULTI_ANSWER"
      ) {
        throw new ApprovalRejectedError(
          "QUESTION_TYPE_INVALID",
          "Approval blocked: question type is not recognised.",
          409,
          { questionType: parsed.questionType },
        );
      }
      // Per directive §5: single-index approval cannot represent
      // MULTI_ANSWER correctness. Refuse rather than silently apply.
      if (parsed.questionType === "MULTI_ANSWER") {
        throw new ApprovalRejectedError(
          "ANSWER_CARDINALITY_INVALID",
          "Approval blocked: MULTI_ANSWER approval requires a multi-index contract, which is pending a separately authorised extension.",
          409,
          { questionType: parsed.questionType },
        );
      }
      // TRUE_FALSE must have exactly 2 options; SINGLE_CHOICE 2–8.
      if (
        parsed.questionType === "TRUE_FALSE" &&
        parsed.options.length !== 2
      ) {
        throw new ApprovalRejectedError(
          "ANSWER_CARDINALITY_INVALID",
          "Approval blocked: TRUE_FALSE question must have exactly 2 options.",
          409,
          { optionCount: parsed.options.length },
        );
      }
      if (
        parsed.questionType === "SINGLE_CHOICE" &&
        (parsed.options.length < 2 || parsed.options.length > 8)
      ) {
        throw new ApprovalRejectedError(
          "ANSWER_CARDINALITY_INVALID",
          "Approval blocked: SINGLE_CHOICE question must have 2–8 options.",
          409,
          { optionCount: parsed.options.length },
        );
      }

      // 4. Verified-answer bounds check + server-derived text.
      const idx = input.verifiedCorrectAnswerIndex;
      if (idx < 0 || idx >= parsed.options.length) {
        throw new ApprovalRejectedError(
          "VERIFIED_ANSWER_OUT_OF_RANGE",
          `Approval blocked: verifiedCorrectAnswerIndex ${idx} is out of range (valid: 0–${parsed.options.length - 1}).`,
          400,
          { verifiedCorrectAnswerIndex: idx, optionCount: parsed.options.length },
        );
      }
      const serverDerivedText = parsed.options[idx].text;
      if (
        input.expectedOptionText !== undefined &&
        input.expectedOptionText !== serverDerivedText
      ) {
        throw new ApprovalRejectedError(
          "VERIFIED_ANSWER_TEXT_MISMATCH",
          "Approval blocked: supplied expectedOptionText does not match the stored draft's option text. Refresh and retry.",
          409,
          { verifiedCorrectAnswerIndex: idx },
        );
      }

      // 5. Build the verified-correct snapshot.
      const verifiedAt = new Date();
      const snapshot = {
        schemaVersion: "verified-correct-answer-snapshot-v1",
        optionIndex: idx,
        optionText: serverDerivedText,
        verifiedByUserId: principal.id,
        verifiedAt: verifiedAt.toISOString(),
        draftContentHash: draft.contentHash,
        validationId: validation.id,
      } as const;

      // 6. Write the snapshot onto the validation row.
      await tx.trainingQuestionAiValidation.update({
        where: { id: validation.id },
        data: { verifiedCorrectAnswerSnapshotJson: JSON.stringify(snapshot) },
      });

      // 7. Append the reviewer-decision row.
      const review = await tx.trainingQuestionAiReview.create({
        data: {
          clubId,
          draftId: draft.id,
          draftContentHash: draft.contentHash,
          validationId: validation.id,
          disposition: "APPROVED",
          reviewerNote: input.reviewerNote?.trim() || null,
          reviewedByUserId: principal.id,
          reviewedAt: verifiedAt,
        },
        select: { id: true },
      });

      // 8. Advance the lifecycle through the 4B transactional helper.
      //    This:
      //      - re-checks the transition against the lifecycle table,
      //      - updates the draft row (state + recordVersion) with
      //        optimistic concurrency,
      //      - appends the TrainingQuestionAiStateTransition row.
      //    Any failure rolls back the whole transaction.
      const transition = await writeStateTransition({
        tx,
        draftId: draft.id,
        clubId,
        fromState: "REQUIRES_HUMAN_REVIEW",
        toState: "APPROVED_DRAFT",
        reasonCode: "REVIEWER_APPROVED",
        actor: principal,
        actorPermissions: new Set(["hr:training:ai:approve"]),
        expectedRecordVersion: draft.recordVersion,
        reviewId: review.id,
        validationId: validation.id,
        meta: {
          verifiedCorrectAnswerIndex: idx,
          verifiedAt: verifiedAt.toISOString(),
          idempotencyKey: input.idempotencyKey,
        },
      });

      // 9. Record the idempotency outcome. The unique index on
      //    (route, requestKey, reviewerUserId, draftId) is the DB-
      //    level race arbitrator; a losing concurrent approval raises
      //    P2002 → caught below → mapped to IDEMPOTENCY_CONFLICT.
      const successBody: ApprovalSuccessResponse = {
        ok: true,
        draftId: draft.id,
        reviewId: review.id,
        validationId: validation.id,
        transitionId: transition.transitionId,
        recordVersionAfter: transition.recordVersionAfter,
        state: "APPROVED_DRAFT",
        verifiedCorrectAnswer: {
          optionIndex: idx,
          optionText: serverDerivedText,
          verifiedByUserId: principal.id,
          verifiedAt: verifiedAt.toISOString(),
        },
        replay: false,
      };
      const expiresAt = new Date(verifiedAt.getTime() + IDEMPOTENCY_TTL_HOURS * 3600_000);
      await tx.trainingQuestionAiOperationKey.create({
        data: {
          clubId,
          draftId: draft.id,
          route: APPROVE_ROUTE_IDEMPOTENCY_KEY,
          requestKey: input.idempotencyKey,
          reviewerUserId: principal.id,
          responseHttpStatus: 200,
          responseBodyJson: JSON.stringify({
            __payloadFingerprint: payloadFingerprint,
            response: successBody,
          }),
          expiresAt,
        },
      });

      // Return WITHOUT the post-tx audit — the audit call happens
      // after the transaction commits.
      return successBody;
    });
  } catch (err) {
    // Map Prisma P2002 on the operation-key unique index to IDEMPOTENCY_CONFLICT.
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: string }).code === "P2002"
    ) {
      // A concurrent approval with the same key committed first.
      // Re-read the cached response; if a concurrent SAME-payload
      // winner exists, we can still return a replay. If the committed
      // key had a different payload, this is a true IDEMPOTENCY_CONFLICT.
      const row = await db.trainingQuestionAiOperationKey.findUnique({
        where: {
          route_requestKey_reviewerUserId_draftId: {
            route: APPROVE_ROUTE_IDEMPOTENCY_KEY,
            requestKey: input.idempotencyKey,
            reviewerUserId: principal.id,
            draftId: input.draftId,
          },
        },
        select: { responseBodyJson: true },
      });
      if (row) {
        const cached = safeParse<Record<string, unknown>>(row.responseBodyJson);
        if (cached && cached.__payloadFingerprint === payloadFingerprint) {
          const resp = cached.response as ApprovalSuccessResponse | undefined;
          if (resp && resp.ok) {
            return { ...resp, replay: true };
          }
        }
      }
      throw new ApprovalRejectedError(
        "IDEMPOTENCY_CONFLICT",
        "Approval blocked: a concurrent approval won this idempotency key with a different payload.",
        409,
      );
    }
    // Re-raise known rejections verbatim; the API handler maps them.
    if (err instanceof ApprovalRejectedError) throw err;
    if (err instanceof TransitionBlockedError) {
      throw new ApprovalRejectedError(
        "TRANSITION_BLOCKED",
        err.message,
        err.code === "CONCURRENT_MODIFICATION" ? 409 : 409,
        { transitionCode: err.code },
      );
    }
    if (err instanceof AppError) throw err;
    throw err;
  } finally {
    // Audit fires AFTER the transaction regardless of outcome. If the
    // tx committed, we emit an audit record; if it failed, we DO NOT
    // emit (there's no authoritative state change to describe here —
    // the TrainingQuestionAiStateTransition row is the authoritative
    // record and only exists on success).
    // Design note: audit emission on success is deliberately placed
    // AFTER the function returns to its caller so the client doesn't
    // wait on it. We fire-and-forget because audit() never throws.
    // (We don't have a clean pre-return hook in a try/finally; so the
    // caller is responsible for the audit emission on success. See
    // the API-route caller for the audit call pattern.)
  }
}

/** Public helper the API route handler uses to emit the post-success
 *  audit record. Called ONLY on a return value with `ok: true` AND
 *  `replay: false`. */
export async function emitApprovalAudit(
  principal: Principal,
  clubId: string,
  success: ApprovalSuccessResponse,
): Promise<void> {
  await audit(principal, {
    action: "training.ai.question.verified-correct.recorded",
    entityType: "TrainingQuestionAiValidation",
    entityId: success.validationId,
    clubId,
    meta: {
      draftId: success.draftId,
      reviewId: success.reviewId,
      transitionId: success.transitionId,
      verifiedCorrectAnswerIndex: success.verifiedCorrectAnswer.optionIndex,
      verifiedByUserId: success.verifiedCorrectAnswer.verifiedByUserId,
      verifiedAt: success.verifiedCorrectAnswer.verifiedAt,
      recordVersionAfter: success.recordVersionAfter,
    },
  });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function parseDraftJsonStrict(json: string): ParsedDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ApprovalRejectedError(
      "QUESTION_TYPE_INVALID",
      "Approval blocked: stored draft body is unparseable. Contact support.",
      500,
    );
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  const questionType = typeof r.questionType === "string" ? r.questionType : "";
  const questionText = typeof r.questionText === "string" ? r.questionText : "";
  const explanation = typeof r.explanation === "string" ? r.explanation : "";
  const options = Array.isArray(r.options)
    ? (r.options as unknown[]).map((o) => {
        const obj = (o ?? {}) as Record<string, unknown>;
        return {
          text: typeof obj.text === "string" ? obj.text : "",
          isCorrect: obj.isCorrect === true,
        };
      })
    : [];
  const sourceSegmentIds = Array.isArray(r.sourceSegmentIds)
    ? (r.sourceSegmentIds as unknown[]).filter((n): n is number => typeof n === "number")
    : [];
  return { questionType, questionText, explanation, options, sourceSegmentIds };
}

function fingerprintRequest(input: ApprovalRequestInput): string {
  // Canonical JSON of the request fields that materially define the
  // approval outcome. Excludes idempotencyKey (which IS the key) and
  // reviewerNote (which is narrative).
  return sha256Hex(
    canonicalise({
      draftId: input.draftId,
      expectedContentHash: input.expectedContentHash,
      expectedValidationId: input.expectedValidationId,
      expectedRecordVersion: input.expectedRecordVersion,
      verifiedCorrectAnswerIndex: input.verifiedCorrectAnswerIndex,
      expectedOptionText: input.expectedOptionText ?? null,
      evidenceAttestation: input.evidenceAttestation,
    }),
  );
}

function safeParse<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function guardRejection(decision: ServerApprovalDecision): ApprovalRejectedError {
  return new ApprovalRejectedError(
    "APPROVAL_GUARD_BLOCKED",
    decision.message,
    decision.httpStatus,
    { reasons: decision.reasons },
  );
}
