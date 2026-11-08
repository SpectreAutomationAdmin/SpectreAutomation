// EP-TRAIN-4Y-Q §6 (2026-11-08) — reviewer-rejection service.
//
// The lifecycle has always carried the `REVIEWER_REJECTED` transition
// (lifecycle.ts:63) but prior to this slice there was no route that
// emitted it — the PersistedReviewWorkspace had the Reject button as
// an explicit disabled stub ("Not implemented in this slice").
//
// This service wires the transition: a reviewer with
// `hr:training:ai:review` moves REQUIRES_HUMAN_REVIEW → REJECTED and
// writes an audit trail. Same separation-of-duties stance as approve:
// the same user who authored or edited a question cannot reject it
// for themselves to retry — they can only ask a reviewer.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";

export class RejectError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface RejectDraftInput {
  readonly draftId: string;
  readonly reason: string;
  readonly expectedRecordVersion?: number;
}

export async function rejectDraft(
  principal: Principal,
  clubId: string,
  input: RejectDraftInput,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{ draftId: string; state: "REJECTED" }> {
  const db = opts.prisma ?? defaultPrisma;
  if (!input.draftId) throw new RejectError("invalid_input", "draftId required", 400);
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) {
    throw new RejectError("invalid_input", "reason required (min 3 chars)", 400);
  }
  if (!hasPermission(principal, clubId, "hr:training:ai:review")) {
    // Mirror the approve route: forbidden → not_found so cross-tenant
    // probes cannot enumerate.
    throw new RejectError("forbidden", "reviewer permission required", 404);
  }
  const draft = await db.trainingQuestionAiDraft.findUnique({
    where: { id: input.draftId },
    select: {
      id: true,
      clubId: true,
      state: true,
      recordVersion: true,
      generatedByUserId: true,
      stateChangedByUserId: true,
    },
  });
  if (!draft) throw new RejectError("not_found", "draft not found", 404);
  if (draft.clubId !== clubId) throw new RejectError("not_found", "draft not in active club", 404);
  if (draft.state !== "REQUIRES_HUMAN_REVIEW") {
    throw new RejectError(
      "invalid_state",
      `draft state is ${draft.state}; REVIEWER_REJECTED can only transition from REQUIRES_HUMAN_REVIEW`,
      409,
    );
  }
  if (
    typeof input.expectedRecordVersion === "number" &&
    input.expectedRecordVersion !== draft.recordVersion
  ) {
    throw new RejectError(
      "version_conflict",
      `expected recordVersion ${input.expectedRecordVersion} but current is ${draft.recordVersion}`,
      409,
    );
  }
  // Separation of duties — reviewer cannot be the same user who
  // originally authored the draft. (The 4W worker emits drafts with
  // `generatedByUserId = null`, so this check only trips when a
  // reviewer-edit slice exists; keeping it in place is forward-safe.)
  if (draft.generatedByUserId && draft.generatedByUserId === principal.id) {
    throw new RejectError(
      "separation_of_duties",
      "the draft's author cannot reject their own candidate",
      409,
    );
  }

  const now = opts.now ?? new Date();
  const updated = await db.trainingQuestionAiDraft.updateMany({
    where: {
      id: draft.id,
      clubId,
      state: "REQUIRES_HUMAN_REVIEW",
      recordVersion: draft.recordVersion,
    },
    data: {
      state: "REJECTED",
      stateChangedAt: now,
      stateChangedByUserId: principal.id,
      recordVersion: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    throw new RejectError("version_conflict", "concurrent update — try again", 409);
  }

  // Emit a lifecycle-state-transition row so the audit history is
  // visible on the persisted-review surface (same table the
  // approval-service writes to).
  await db.trainingQuestionAiStateTransition.create({
    data: {
      clubId,
      draftId: draft.id,
      fromState: "REQUIRES_HUMAN_REVIEW",
      toState: "REJECTED",
      reasonCode: "REVIEWER_REJECTED",
      reasonDetail: reason.slice(0, 500),
      byUserId: principal.id,
      recordVersionBefore: draft.recordVersion,
      recordVersionAfter: draft.recordVersion + 1,
    },
  });

  void audit(principal, {
    action: "hr.training.ai.draft.reject",
    entityType: "TrainingQuestionAiDraft",
    entityId: draft.id,
    clubId,
    before: { state: "REQUIRES_HUMAN_REVIEW", recordVersion: draft.recordVersion },
    after: { state: "REJECTED", recordVersion: draft.recordVersion + 1 },
  });

  return { draftId: draft.id, state: "REJECTED" };
}
