// EP-TRAIN-6D-4N (2026-11-05) — Verified-answer resolver for the UI.
//
// Resolves the "is the model-selected answer authoritatively verified
// correct?" question for a single AI-review candidate. Composes:
//   - the draft's lifecycle state,
//   - the latest APPROVED reviewer decision (TrainingQuestionAiReview),
//   - the `verifiedCorrectAnswerSnapshotJson` on the validation row
//     the review drove,
//   - the integrity checks that the snapshot's internal bindings
//     (draftContentHash, validationId, optionIndex / optionText)
//     agree with the AUTHORITATIVE draft + validation state TODAY.
//
// Per directive §10: "A verified snapshot alone is insufficient. The
// reader must check the authoritative approval decision, lifecycle
// eligibility, hash binding, and snapshot integrity. If any check
// fails, render the answer as unverified and surface an integrity
// warning."
//
// This service is READ-ONLY. No mutation. Tenant-scoped at every
// lookup. Returns a structural branch:
//   - { kind: "verified" } — all five checks pass; UI may render
//     emerald "Verified correct · {reviewer}"
//   - { kind: "unverified" } — not APPROVED_DRAFT / ARCHIVED, or no
//     snapshot, or no APPROVED review. Normal unverified state.
//   - { kind: "integrity-warning" } — snapshot exists but one of the
//     integrity checks failed. UI must render the answer as
//     unverified AND surface a dedicated banner.

import { prisma as defaultPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";
import type { Principal } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac";

export type VerifiedAnswerKind =
  | "verified"
  | "unverified"
  | "integrity-warning";

export type IntegrityWarningCode =
  | "SNAPSHOT_HASH_BINDING_STALE"       // snapshot.draftContentHash != draft.contentHash now
  | "SNAPSHOT_VALIDATION_BINDING_STALE" // snapshot.validationId != latest APPROVED review's validationId
  | "SNAPSHOT_OPTION_MISMATCH"          // snapshot.optionText != current options[optionIndex].text
  | "SNAPSHOT_SHAPE_INVALID"            // snapshot JSON is malformed
  | "APPROVAL_LIFECYCLE_INELIGIBLE";    // state is not APPROVED_DRAFT / ARCHIVED

export interface VerifiedAnswer {
  readonly kind: "verified";
  readonly optionIndex: number;
  readonly optionText: string;
  readonly verifiedByUserId: string;
  readonly verifiedByUserName: string | null;
  readonly verifiedAt: Date;
  readonly validationId: string;
  readonly reviewId: string;
}

export interface UnverifiedAnswer {
  readonly kind: "unverified";
}

export interface IntegrityWarning {
  readonly kind: "integrity-warning";
  readonly code: IntegrityWarningCode;
  readonly safeMessage: string;
}

export type VerifiedAnswerResolution =
  | VerifiedAnswer
  | UnverifiedAnswer
  | IntegrityWarning;

/** Tenant-scoped. Returns `null` when the draft is not visible
 *  (cross-tenant / missing). */
export async function resolveVerifiedAnswer(
  principal: Principal | null | undefined,
  clubId: string,
  draftId: string,
  opts: { prisma?: PrismaClient } = {},
): Promise<VerifiedAnswerResolution | null> {
  const prisma = opts.prisma ?? defaultPrisma;
  if (!principal) return null;
  if (!hasPermission(principal, clubId, "hr:training:ai:read")) return null;

  const draft = await prisma.trainingQuestionAiDraft.findFirst({
    where: { id: draftId, clubId },
    select: {
      id: true,
      clubId: true,
      state: true,
      contentHash: true,
      draftJson: true,
      reviews: {
        where: { disposition: "APPROVED" },
        orderBy: [{ reviewedAt: "desc" }],
        take: 1,
        select: {
          id: true,
          draftContentHash: true,
          validationId: true,
          reviewedAt: true,
          reviewedByUserId: true,
          reviewedByUser: { select: { name: true } },
          validation: {
            select: {
              id: true,
              verifiedCorrectAnswerSnapshotJson: true,
            },
          },
        },
      },
    },
  });
  if (!draft) return null;

  // Check 1 — lifecycle eligibility. ARCHIVED is allowed per the
  // established flow: once a draft is APPROVED_DRAFT, an operator-
  // archive transition preserves it in ARCHIVED with the same
  // verifiedCorrectAnswerSnapshotJson binding.
  const eligibleStates = new Set(["APPROVED_DRAFT", "ARCHIVED"]);
  if (!eligibleStates.has(draft.state)) {
    return { kind: "unverified" };
  }

  const review = draft.reviews[0];
  if (!review) {
    // In an eligible state but no APPROVED review on file → integrity
    // warning. (Being in APPROVED_DRAFT without an APPROVED review
    // shouldn't happen under 4N, but we surface the discrepancy
    // defensively rather than silently.)
    return {
      kind: "integrity-warning",
      code: "APPROVAL_LIFECYCLE_INELIGIBLE",
      safeMessage:
        "This draft is in an approved state but no human-reviewer approval was found. Contact support.",
    };
  }

  // Check 2 — review must bind to the current draft content hash.
  if (review.draftContentHash !== draft.contentHash) {
    return {
      kind: "integrity-warning",
      code: "SNAPSHOT_HASH_BINDING_STALE",
      safeMessage:
        "The approved reviewer decision points at an earlier version of this question. The current content is unverified.",
    };
  }

  // Check 3 — validation row must exist + carry a snapshot.
  if (!review.validation?.verifiedCorrectAnswerSnapshotJson) {
    return {
      kind: "integrity-warning",
      code: "SNAPSHOT_VALIDATION_BINDING_STALE",
      safeMessage:
        "The approved reviewer decision has no verified-answer snapshot on its validation row. Contact support.",
    };
  }

  // Check 4 — snapshot shape + internal bindings.
  let snapshot: Record<string, unknown>;
  try {
    const parsed = JSON.parse(review.validation.verifiedCorrectAnswerSnapshotJson);
    if (parsed === null || typeof parsed !== "object") {
      return integrityWarningShape();
    }
    snapshot = parsed as Record<string, unknown>;
  } catch {
    return integrityWarningShape();
  }
  const optionIndex = typeof snapshot.optionIndex === "number" ? snapshot.optionIndex : -1;
  const optionText = typeof snapshot.optionText === "string" ? snapshot.optionText : null;
  const snapshotHash = typeof snapshot.draftContentHash === "string" ? snapshot.draftContentHash : null;
  const snapshotValidationId = typeof snapshot.validationId === "string" ? snapshot.validationId : null;
  const verifiedByUserId = typeof snapshot.verifiedByUserId === "string" ? snapshot.verifiedByUserId : null;
  const verifiedAtRaw = typeof snapshot.verifiedAt === "string" ? snapshot.verifiedAt : null;

  if (
    optionIndex < 0 ||
    !optionText ||
    !snapshotHash ||
    !snapshotValidationId ||
    !verifiedByUserId ||
    !verifiedAtRaw
  ) {
    return integrityWarningShape();
  }

  // Check 5 — the snapshot must bind to the SAME validation the
  // review points at, AND to the SAME content hash.
  if (snapshotHash !== draft.contentHash) {
    return {
      kind: "integrity-warning",
      code: "SNAPSHOT_HASH_BINDING_STALE",
      safeMessage:
        "The verified-answer snapshot is bound to an earlier version of this question. The current content is unverified.",
    };
  }
  if (snapshotValidationId !== review.validation.id) {
    return {
      kind: "integrity-warning",
      code: "SNAPSHOT_VALIDATION_BINDING_STALE",
      safeMessage:
        "The verified-answer snapshot references a different validation than the approved reviewer decision. Contact support.",
    };
  }

  // Check 6 — the option index AND text must still match the current
  // draft options array exactly. (The draft is immutable by content
  // hash, so this is belt-and-braces — but worth verifying because the
  // stored draftJson is TEXT and could in principle be mutated through
  // an unauthorised path.)
  const currentOptions = parseDraftOptions(draft.draftJson);
  if (optionIndex >= currentOptions.length) {
    return {
      kind: "integrity-warning",
      code: "SNAPSHOT_OPTION_MISMATCH",
      safeMessage:
        "The verified-answer snapshot references an option index that no longer exists on the draft.",
    };
  }
  if (currentOptions[optionIndex].text !== optionText) {
    return {
      kind: "integrity-warning",
      code: "SNAPSHOT_OPTION_MISMATCH",
      safeMessage:
        "The verified-answer snapshot's option text does not match the current draft's option text.",
    };
  }

  const verifiedAt = new Date(verifiedAtRaw);
  if (Number.isNaN(verifiedAt.getTime())) {
    return integrityWarningShape();
  }

  return {
    kind: "verified",
    optionIndex,
    optionText,
    verifiedByUserId,
    verifiedByUserName: review.reviewedByUser?.name ?? null,
    verifiedAt,
    validationId: review.validation.id,
    reviewId: review.id,
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function parseDraftOptions(json: string | null | undefined): Array<{ text: string; isCorrect: boolean }> {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (!Array.isArray(raw.options)) return [];
    return (raw.options as unknown[]).map((o) => {
      const obj = (o ?? {}) as Record<string, unknown>;
      return {
        text: typeof obj.text === "string" ? obj.text : "",
        isCorrect: obj.isCorrect === true,
      };
    });
  } catch {
    return [];
  }
}

function integrityWarningShape(): IntegrityWarning {
  return {
    kind: "integrity-warning",
    code: "SNAPSHOT_SHAPE_INVALID",
    safeMessage:
      "The verified-answer snapshot could not be parsed. The current content is unverified. Contact support.",
  };
}
