// SIGNUP-2 M4-INT-B §2 (2026-10-29) -- Operator-facing exception
// resolution helpers.
//
// Thin wrappers over BillingExceptionCase writes so routes do not
// inline Prisma mutations.  The underlying rows are preserved
// (never deleted) -- Spectre only annotates them with operator
// decisions.  Payment-failure / dispute / reversal events remain
// durably recorded; operators record WHAT WAS DONE, not WHAT
// HAPPENED.
//
// SoD note: the acknowledging operator may differ from the
// resolving operator.  Both identities are audited.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { AppError } from "@/lib/errors";

export type OperatorResolution =
  | "SUSPEND_TENANT"
  | "RETRY_INVOICE"
  | "SCHEDULE_CANCELLATION"
  | "ACCEPT_LOSS"
  | "AWAIT_DISPUTE_OUTCOME"
  | "NO_ACTION";

export const OPERATOR_RESOLUTIONS: ReadonlyArray<OperatorResolution> = [
  "SUSPEND_TENANT",
  "RETRY_INVOICE",
  "SCHEDULE_CANCELLATION",
  "ACCEPT_LOSS",
  "AWAIT_DISPUTE_OUTCOME",
  "NO_ACTION",
];

/** Operator acknowledges an exception.  Idempotent via conditional
 *  updateMany on operatorAcknowledgedAt=null.  Does NOT remove the
 *  underlying financial record. */
export async function acknowledgeException(args: {
  exceptionId: string;
  acknowledgedByUserId: string;
}): Promise<{ acknowledged: boolean; alreadyAcknowledged: boolean }> {
  const existing = await prisma.billingExceptionCase.findUnique({
    where: { id: args.exceptionId },
    select: {
      id: true, operatorAcknowledgedAt: true, billingCycleId: true, category: true,
      billingCycle: { select: { clubId: true } },
    },
  });
  if (!existing) {
    throw new AppError("EXCEPTION_NOT_FOUND", `exception ${args.exceptionId.slice(-6)} not found`, 404);
  }
  if (existing.operatorAcknowledgedAt) {
    return { acknowledged: false, alreadyAcknowledged: true };
  }
  const updated = await prisma.billingExceptionCase.updateMany({
    where: { id: args.exceptionId, operatorAcknowledgedAt: null },
    data: {
      operatorAcknowledgedByUserId: args.acknowledgedByUserId,
      operatorAcknowledgedAt: new Date(),
    },
  });
  if (updated.count !== 1) {
    return { acknowledged: false, alreadyAcknowledged: true };
  }
  await audit(null, {
    action: "signup.m4.exception.acknowledged",
    entityType: "BillingExceptionCase",
    entityId: args.exceptionId,
    clubId: existing.billingCycle?.clubId ?? null,
    meta: {
      exceptionIdTail: args.exceptionId.slice(-6),
      category: existing.category,
      acknowledgedByUserIdTail: args.acknowledgedByUserId.slice(-6),
    },
  });
  return { acknowledged: true, alreadyAcknowledged: false };
}

/** Operator records a resolution decision + notes.  Does NOT invoke
 *  the resolution itself (e.g. SUSPEND_TENANT is a separate operator
 *  action under /platform/tenants/*).  This records the DECISION. */
export async function recordExceptionResolution(args: {
  exceptionId: string;
  resolvedByUserId: string;
  resolution: OperatorResolution;
  resolutionNotes: string;
}): Promise<void> {
  if (!OPERATOR_RESOLUTIONS.includes(args.resolution)) {
    throw new AppError("INVALID_RESOLUTION", `unknown resolution '${args.resolution}'`, 400);
  }
  const existing = await prisma.billingExceptionCase.findUnique({
    where: { id: args.exceptionId },
    select: {
      id: true, operatorAcknowledgedAt: true, category: true,
      billingCycle: { select: { clubId: true } },
    },
  });
  if (!existing) {
    throw new AppError("EXCEPTION_NOT_FOUND", `exception ${args.exceptionId.slice(-6)} not found`, 404);
  }
  if (!existing.operatorAcknowledgedAt) {
    throw new AppError(
      "EXCEPTION_NOT_ACKNOWLEDGED",
      "acknowledge the exception before recording a resolution",
      409,
    );
  }
  await prisma.billingExceptionCase.update({
    where: { id: args.exceptionId },
    data: {
      operatorResolution: args.resolution,
      operatorResolutionNotes: args.resolutionNotes,
    },
  });
  await audit(null, {
    action: "signup.m4.exception.resolution_recorded",
    entityType: "BillingExceptionCase",
    entityId: args.exceptionId,
    clubId: existing.billingCycle?.clubId ?? null,
    meta: {
      exceptionIdTail: args.exceptionId.slice(-6),
      category: existing.category,
      resolution: args.resolution,
      resolvedByUserIdTail: args.resolvedByUserId.slice(-6),
      notesLen: args.resolutionNotes.length,
    },
  });
}

/** Flags the exception as needing further operator attention (e.g.
 *  "uncertain outcome" after a dispute closes with ambiguous status).
 *  Sets requiresOperatorAction=true + clears any prior resolution so
 *  the entry reappears in the hub's unresolved count. */
export async function escalateException(args: {
  exceptionId: string;
  escalatedByUserId: string;
  escalationNotes: string;
}): Promise<void> {
  const existing = await prisma.billingExceptionCase.findUnique({
    where: { id: args.exceptionId },
    select: {
      id: true, category: true,
      billingCycle: { select: { clubId: true } },
    },
  });
  if (!existing) {
    throw new AppError("EXCEPTION_NOT_FOUND", `exception ${args.exceptionId.slice(-6)} not found`, 404);
  }
  await prisma.billingExceptionCase.update({
    where: { id: args.exceptionId },
    data: {
      requiresOperatorAction: true,
      operatorAcknowledgedByUserId: null,
      operatorAcknowledgedAt: null,
      operatorResolution: null,
      operatorResolutionNotes:
        `[escalated ${new Date().toISOString()}] ${args.escalationNotes}`.slice(0, 2000),
    },
  });
  await audit(null, {
    action: "signup.m4.exception.escalated",
    entityType: "BillingExceptionCase",
    entityId: args.exceptionId,
    clubId: existing.billingCycle?.clubId ?? null,
    meta: {
      exceptionIdTail: args.exceptionId.slice(-6),
      category: existing.category,
      escalatedByUserIdTail: args.escalatedByUserId.slice(-6),
    },
  });
}
