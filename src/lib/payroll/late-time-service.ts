// Payroll-3D-4 (2026-09-05) — Late-time / retro adjustment resolution.
//
// Payroll Admin's write surface for PayrollTimeAdjustment rows. Two
// resolutions:
//   • INCLUDE_CURRENT — accept as-is. For LATE_APPROVAL, the frozen
//     PayrollApprovedTimeEntry rows already exist and stay APPROVED
//     for batch consumption. For RETRO_CORRECTION on a consumed
//     historical row, the difference is deferred to next payroll
//     (there is no legal way to mutate a consumed row).
//   • DEFER_NEXT_PAYROLL — target the next open period. Any
//     unconsumed PayrollApprovedTimeEntry linked to this adjustment
//     is transitioned to DEFERRED so batch prep excludes it.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

const ENTITY = "PayrollTimeAdjustment";

export type LateResolution = "INCLUDE_CURRENT" | "DEFER_NEXT_PAYROLL";

export interface ResolveLateInput {
  adjustmentId:  string;
  resolution:    LateResolution;
  notes?:        string | null;
}

export interface ResolveLateResult {
  adjustmentId:    string;
  status:          "INCLUDE_CURRENT" | "DEFER_NEXT_PAYROLL";
  resolutionType:  string;
  targetPayPeriodId: string | null;
  affectedFrozenRowIds: string[];
}

export async function resolveLateAdjustment(
  principal: Principal, clubId: string, input: ResolveLateInput,
): Promise<ResolveLateResult> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(
    principal, clubId, "payroll.time-adjustment.resolve",
    ENTITY, input.adjustmentId,
  );

  const adj = await prisma.payrollTimeAdjustment.findFirst({
    where: { id: input.adjustmentId, clubId },
  });
  if (!adj) throw new NotFoundError(ENTITY, input.adjustmentId);
  if (adj.status !== "OPEN") {
    throw new ConflictError(`Adjustment is already ${adj.status}.`);
  }

  const notes = (input.notes ?? "").trim().slice(0, 500) || null;
  const now = new Date();
  const affectedFrozenRowIds: string[] = [];
  let targetPayPeriodId: string | null = adj.targetPayPeriodId ?? null;

  if (input.resolution === "DEFER_NEXT_PAYROLL") {
    // Find the next open pay period AFTER the adjustment's payPeriod
    // for the same pay group. This gives Payroll Admin a deterministic
    // target so the adjustment appears in one place.
    const currentPeriod = await prisma.payrollPayPeriod.findUniqueOrThrow({
      where: { id: adj.payPeriodId },
      select: { payGroupId: true, periodStart: true, clubId: true },
    });
    const next = await prisma.payrollPayPeriod.findFirst({
      where: {
        clubId: currentPeriod.clubId,
        payGroupId: currentPeriod.payGroupId,
        periodStart: { gt: currentPeriod.periodStart },
        status: { in: ["FUTURE", "OPEN"] },
      },
      orderBy: { periodStart: "asc" },
      select: { id: true },
    });
    targetPayPeriodId = next?.id ?? null;
  }

  await prisma.$transaction(async (tx) => {
    const cas = await tx.payrollTimeAdjustment.updateMany({
      where: { id: adj.id, status: "OPEN" },
      data: {
        status: input.resolution,
        resolvedAt: now,
        resolvedByUserId: principal.id,
        resolutionType: input.resolution,
        targetPayPeriodId,
        notes: notes ? `${adj.notes ?? ""}\nresolved:${notes}`.trim() : adj.notes,
      },
    });
    if (cas.count === 0) {
      throw new ConflictError("Adjustment was already resolved by another user.");
    }

    if (input.resolution === "DEFER_NEXT_PAYROLL" && adj.reason === "LATE_APPROVAL") {
      // Move affected frozen rows (unconsumed only) to DEFERRED so
      // batch prep excludes them. Consumed rows are IMMUTABLE — even
      // a defer resolution cannot rewrite them.
      const scopeToken = extractScopeToken(adj.notes ?? "");
      if (scopeToken) {
        const rows = await tx.payrollApprovedTimeEntry.findMany({
          where: {
            clubId,
            sourceApprovalId: extractApprovalToken(adj.notes ?? "") ?? undefined,
            approvalState: "APPROVED",
            consumedByBatchId: null,
          },
          select: { id: true },
        });
        if (rows.length) {
          await tx.payrollApprovedTimeEntry.updateMany({
            where: { id: { in: rows.map((r) => r.id) } },
            data: { approvalState: "DEFERRED" },
          });
          affectedFrozenRowIds.push(...rows.map((r) => r.id));
        }
      }
    }
  }, { timeout: 15_000, maxWait: 5_000 });

  await audit(principal, {
    clubId,
    action: input.resolution === "INCLUDE_CURRENT"
      ? "payroll.time-adjustment.include-current"
      : "payroll.time-adjustment.defer-next",
    entityType: ENTITY,
    entityId: adj.id,
    before: { status: "OPEN" },
    after: {
      status: input.resolution,
      targetPayPeriodId,
      affectedFrozenRowCount: affectedFrozenRowIds.length,
    },
  });

  return {
    adjustmentId: adj.id,
    status: input.resolution,
    resolutionType: input.resolution,
    targetPayPeriodId,
    affectedFrozenRowIds,
  };
}

// -------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------
export async function listOpenLateExceptions(
  principal: Principal, clubId: string, payPeriodId: string,
) {
  requirePermission(principal, clubId, "payroll:timesheets:read");
  return prisma.payrollTimeAdjustment.findMany({
    where: { clubId, payPeriodId, status: "OPEN" },
    orderBy: { createdAt: "asc" },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

// -------------------------------------------------------------------
// Helpers (parse the notes token we stamp at creation time)
// -------------------------------------------------------------------
function extractApprovalToken(notes: string): string | null {
  const m = /approval:([A-Za-z0-9_-]+)/.exec(notes);
  return m?.[1] ?? null;
}
function extractScopeToken(notes: string): string | null {
  const m = /scope:([A-Za-z0-9_-]+)/.exec(notes);
  return m?.[1] ?? null;
}

// Validation used by the server action; separate for reuse.
export function assertValidResolution(r: string): asserts r is LateResolution {
  if (r !== "INCLUDE_CURRENT" && r !== "DEFER_NEXT_PAYROLL") {
    throw new ValidationError([{ path: "resolution", message: "Unknown resolution." }]);
  }
}
