// Slice E (2026-09-19) — explicit zero-hours acknowledgement.
//
// Satisfies the NO_APPROVED_HOURS_FOR_HOURLY blocker for legitimate
// cases: unpaid leave, no shifts, seasonal inactive, other. One row
// per (batch × employee). Acknowledging it does NOT silently bypass —
// it records who, why, and when, and clears the blocker on the next
// Re-Prepare or is picked up at the exception-scan pass Prepare
// currently runs against `PayrollBatchException`.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { withPostingGuard } from "../posting-guard";
import { NotFoundError, ValidationError } from "../errors";

const ENTITY = "PayrollZeroHoursAcknowledgement";

export type ZeroHoursReason =
  | "UNPAID_LEAVE"
  | "NO_SHIFTS_IN_PERIOD"
  | "SEASONAL_INACTIVE"
  | "OTHER";

const REASONS: readonly ZeroHoursReason[] = [
  "UNPAID_LEAVE", "NO_SHIFTS_IN_PERIOD", "SEASONAL_INACTIVE", "OTHER",
];

export const ZERO_HOURS_REASON_LABEL: Record<ZeroHoursReason, string> = {
  UNPAID_LEAVE:        "Unpaid leave",
  NO_SHIFTS_IN_PERIOD: "No shifts scheduled in this period",
  SEASONAL_INACTIVE:   "Seasonal — inactive but still employed",
  OTHER:               "Other (see note)",
};

export interface AckInput {
  batchEmployeeId: string;
  reason: ZeroHoursReason;
  reasonDetail?: string | null;
}

/** Ack a specific batch × employee as legitimately zero-hours. */
export async function acknowledgeZeroHours(
  principal: Principal,
  clubId: string,
  input: AckInput,
): Promise<{ id: string }> {
  requirePermission(principal, clubId, "payroll:edit");

  if (!REASONS.includes(input.reason)) {
    throw new ValidationError([{
      path: "reason",
      message: `reason must be one of ${REASONS.join(", ")}`,
    }]);
  }
  if (input.reason === "OTHER" && !input.reasonDetail?.trim()) {
    throw new ValidationError([{
      path: "reasonDetail",
      message: "reasonDetail is required when reason=OTHER.",
    }]);
  }

  const be = await prisma.payrollBatchEmployee.findFirst({
    where: { id: input.batchEmployeeId, clubId },
    select: { id: true, batchId: true, employeeId: true },
  });
  if (!be) throw new NotFoundError("PayrollBatchEmployee", input.batchEmployeeId);

  // M1d (2026-10-27) -- withPostingGuard holds FOR UPDATE on ClubSubscription for the write.
  // Scope note: both the upsert of the acknowledgement row and the
  // follow-up resolution of the NO_APPROVED_HOURS_FOR_HOURLY exception
  // rows are state-changing writes that must commit atomically with
  // the posting-guard check — they move together or not at all.
  const row = await withPostingGuard(
    principal,
    clubId,
    "payroll.zero_hours_ack",
    async (tx) => {
      const r = await tx.payrollZeroHoursAcknowledgement.upsert({
        where: { batchEmployeeId: be.id },
        create: {
          clubId, batchId: be.batchId, batchEmployeeId: be.id, employeeId: be.employeeId,
          reason: input.reason,
          reasonDetail: input.reasonDetail ?? null,
          acknowledgedByUserId: principal.id,
        },
        update: {
          reason: input.reason,
          reasonDetail: input.reasonDetail ?? null,
          acknowledgedByUserId: principal.id,
          acknowledgedAt: new Date(),
        },
      });

      // Also resolve the NO_APPROVED_HOURS_FOR_HOURLY exception row on
      // this batch × employee so the review UI reflects the ack immediately
      // (without waiting for a Re-Prepare).
      await tx.payrollBatchException.updateMany({
        where: {
          clubId,
          batchId: be.batchId,
          batchEmployeeId: be.id,
          code: "NO_APPROVED_HOURS_FOR_HOURLY",
          resolvedAt: null,
        },
        data: {
          resolvedAt: new Date(),
          resolvedByUserId: principal.id,
        },
      });
      return r;
    },
    { entityType: ENTITY, entityId: input.batchEmployeeId },
  );

  await audit(principal, {
    action: "payroll.zero_hours_ack",
    entityType: ENTITY, entityId: row.id, clubId,
    after: { batchId: be.batchId, employeeId: be.employeeId, reason: input.reason },
  });

  return { id: row.id };
}
