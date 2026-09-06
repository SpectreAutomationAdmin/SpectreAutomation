// Payroll-3C-4 (2026-09-09) — one-time payroll adjustments.
//
// A one-time adjustment is a PayrollBatchComponentSnapshot row with
// `provenance = ONE_TIME_PAYROLL_ADJUSTMENT`. It:
//   • references a Club-scoped PayrollComponent (so treatment is
//     inherited — never invented on the payroll screen);
//   • lives ONLY on a specific batch employee;
//   • carries a required `reason` and `enteredByUserId`;
//   • may be created / removed only while the batch is PREPARED;
//   • never carries a `sourceAssignmentId` — it doesn't originate
//     from a recurring assignment.
//
// The calculator already reads every PayrollBatchComponentSnapshot
// row uniformly, so one-time adjustments participate in the same
// four-independent-base pipeline as recurring components.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { Prisma } from "@prisma/client";

const ENTITY = "PayrollBatchComponentSnapshot";
const REASON_MAX = 240;

export interface AddOneTimeAdjustmentInput {
  batchEmployeeId: string;
  componentCode:   string;
  amount?:         string | number | null;
  percentBps?:     number | null;
  reason:          string;
}

export interface RemoveOneTimeAdjustmentInput {
  snapshotId: string;
}

// -------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------
function assertBatchAcceptsAdjustments(status: string) {
  // Payroll-3C-4A (2026-09-09) — HOTFIX: tightened to PREPARED-only.
  //
  // Rationale (§9 of the 3C-4A brief):
  //   • DRAFT is a scratch state; adjustments have no meaning yet.
  //   • CALCULATED / SUBMITTED_FOR_APPROVAL / APPROVED / POSTED are
  //     all post-calculation — mutating them silently changes the
  //     economics the Controller reviewed. The operational path for
  //     a genuine correction is VOID → PREPARE replacement.
  if (status === "PREPARED") return;
  throw new ConflictError(
    `Cannot modify adjustments on a ${status} batch. ` +
    `One-time adjustments can only be added or removed while the batch is PREPARED. ` +
    `If the batch is already CALCULATED or later, void it and prepare a replacement.`,
  );
}

function sanitizeReason(input: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: "reason", message: "reason is required." }]);
  }
  const trimmed = input.trim().replace(/[<>]/g, "").slice(0, REASON_MAX);
  if (trimmed.length === 0) {
    throw new ValidationError([{ path: "reason", message: "reason is required." }]);
  }
  return trimmed;
}

// -------------------------------------------------------------------
// Add
// -------------------------------------------------------------------
export async function addOneTimeAdjustment(
  principal: Principal,
  clubId: string,
  batchId: string,
  input: AddOneTimeAdjustmentInput,
): Promise<{ snapshotId: string }> {
  // Payroll-3C-4 (2026-09-09) — adjustments are batch INPUTS. Use
  // `payroll:edit` (Payroll Admin holds; Controller does not) so that
  // SoD is preserved: the same user who approves the run cannot also
  // reshape its inputs. See §26 of the brief.
  requirePermission(principal, clubId, "payroll:edit");

  const batch = await prisma.payrollBatch.findUnique({
    where: { id: batchId }, select: { id: true, clubId: true, status: true },
  });
  if (!batch) throw new NotFoundError("PayrollBatch", batchId);
  assertTenantOwned(batch, principal);
  if (batch.clubId !== clubId) throw new NotFoundError("PayrollBatch", batchId);
  assertBatchAcceptsAdjustments(batch.status);

  const be = await prisma.payrollBatchEmployee.findUnique({
    where: { id: input.batchEmployeeId },
    select: { id: true, clubId: true, batchId: true, employeeId: true },
  });
  if (!be || be.clubId !== clubId || be.batchId !== batchId) {
    throw new NotFoundError("PayrollBatchEmployee", input.batchEmployeeId);
  }

  const component = await prisma.payrollComponent.findFirst({
    where: { clubId, code: input.componentCode, active: true },
  });
  if (!component) {
    throw new ValidationError([{
      path: "componentCode",
      message: `Component ${input.componentCode} is not active in this club's catalogue.`,
    }]);
  }

  const reason = sanitizeReason(input.reason);

  let resolvedAmount: Prisma.Decimal | null = null;
  let percentBps: number | null = null;
  let eligibleEarningsBase: string | null = null;

  if (component.calculationMethod === "FIXED_AMOUNT") {
    if (input.amount == null) {
      throw new ValidationError([{ path: "amount", message: "amount is required for FIXED_AMOUNT components." }]);
    }
    if (input.percentBps != null) {
      throw new ValidationError([{ path: "percentBps", message: "percentBps must be omitted for FIXED_AMOUNT components." }]);
    }
    const amt = new Prisma.Decimal(String(input.amount));
    if (amt.lte(0)) {
      throw new ValidationError([{
        path: "amount",
        message: "amount must be a positive dollar value. Direction is determined by the component's cash effect — never enter a negative amount.",
      }]);
    }
    resolvedAmount = amt;
  } else if (component.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS") {
    // Payroll-3C-4 (§8) — defer percentage one-time adjustments until
    // the eligible-base ordering is clarified. Refuse loudly.
    throw new ConflictError(
      "PERCENT_OF_ELIGIBLE_EARNINGS one-time adjustments are not yet supported. " +
      "Use a FIXED_AMOUNT component, or wait for the next Payroll release.",
    );
  } else {
    throw new ValidationError([{
      path: "calculationMethod",
      message: `Unsupported calculation method: ${component.calculationMethod}`,
    }]);
  }

  const created = await prisma.payrollBatchComponentSnapshot.create({
    data: {
      clubId, batchId, batchEmployeeId: be.id, employeeId: be.employeeId,
      sourceComponentId: component.id, sourceAssignmentId: null,
      componentCode: component.code, displayName: component.displayName,
      category: component.category, side: component.side,
      displaySection: component.displaySection, displayOrder: component.displayOrder,
      cashEffect: component.cashEffect,
      taxableEffect: component.taxableEffect,
      cppPensionableEffect: component.cppPensionableEffect,
      eiInsurableEffect: component.eiInsurableEffect,
      calculationMethod: component.calculationMethod,
      statutoryTreatmentSource: component.statutoryTreatmentSource,
      resolvedAmount, sourcePercentBps: percentBps, eligibleEarningsBase,
      sourceEffectiveFrom: new Date(),
      sourceEffectiveTo: null,
      provenance: "ONE_TIME_PAYROLL_ADJUSTMENT",
      enteredByUserId: principal.id,
      reason,
      // Payroll-3C-6 (2026-09-05) — one-time adjustments freeze the
      // component's GL mapping at add-time so they post through the
      // same tenant-configured accounts as their recurring siblings.
      expenseAccountIdSnapshot:   component.expenseAccountId   ?? null,
      liabilityAccountIdSnapshot: component.liabilityAccountId ?? null,
    },
    select: { id: true },
  });

  await audit(principal, {
    clubId, action: "payroll.adjustment.add",
    entityType: ENTITY, entityId: created.id,
    after: {
      batchId, batchEmployeeId: be.id, componentCode: component.code,
      resolvedAmount: resolvedAmount?.toFixed(2), reason,
    },
  });

  return { snapshotId: created.id };
}

// -------------------------------------------------------------------
// Remove
// -------------------------------------------------------------------
export async function removeOneTimeAdjustment(
  principal: Principal,
  clubId: string,
  input: RemoveOneTimeAdjustmentInput,
): Promise<void> {
  // Payroll-3C-4 (2026-09-09) — adjustments are batch INPUTS. Use
  // `payroll:edit` (Payroll Admin holds; Controller does not) so that
  // SoD is preserved: the same user who approves the run cannot also
  // reshape its inputs. See §26 of the brief.
  requirePermission(principal, clubId, "payroll:edit");

  const snap = await prisma.payrollBatchComponentSnapshot.findUnique({
    where: { id: input.snapshotId },
    select: {
      id: true, clubId: true, batchId: true, batchEmployeeId: true,
      componentCode: true, provenance: true, resolvedAmount: true,
      batch: { select: { status: true } },
    },
  });
  if (!snap) throw new NotFoundError(ENTITY, input.snapshotId);
  assertTenantOwned(snap, principal);
  if (snap.clubId !== clubId) throw new NotFoundError(ENTITY, input.snapshotId);
  if (snap.provenance !== "ONE_TIME_PAYROLL_ADJUSTMENT") {
    throw new ConflictError(
      "Cannot remove a snapshot that isn't a one-time adjustment. " +
      "Recurring component snapshots are frozen from Employee setup.",
    );
  }
  assertBatchAcceptsAdjustments(snap.batch.status);

  await prisma.payrollBatchComponentSnapshot.delete({ where: { id: snap.id } });

  await audit(principal, {
    clubId, action: "payroll.adjustment.remove",
    entityType: ENTITY, entityId: snap.id,
    before: {
      batchId: snap.batchId, batchEmployeeId: snap.batchEmployeeId,
      componentCode: snap.componentCode,
      resolvedAmount: snap.resolvedAmount?.toString() ?? null,
    },
  });
}

// -------------------------------------------------------------------
// List — used by the review DTO to break out one-time rows for UI.
// -------------------------------------------------------------------
export async function listOneTimeAdjustmentsForBatch(
  principal: Principal,
  clubId: string,
  batchId: string,
) {
  requirePermission(principal, clubId, "payroll:read");
  return prisma.payrollBatchComponentSnapshot.findMany({
    where: { clubId, batchId, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    orderBy: [{ batchEmployeeId: "asc" }, { createdAt: "asc" }],
  });
}
