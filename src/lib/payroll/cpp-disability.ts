// Payroll-3B-5B-1 (2026-08-31) — CPP disability status service.
//
// Records the minimum statutory Payroll fact that a Spectre-run
// payroll needs to stop / restart CPP contributions per CRA.
//
// Explicitly NOT a medical record. This service:
//   • never accepts diagnosis text
//   • never accepts prescription / treatment / provider fields
//   • caps `sourceBasis` to a short evidence label
//
// Statuses:
//   NOT_DISABLED   — default; CPP applies normally.
//   CPP_DISABLED   — receiving a CPP disability benefit; CPP
//                    contributions stop from the effective date.
//   QPP_DISABLED   — receiving a QPP disability benefit; CPP
//                    contributions stop from the effective date.
//
// The resolver reads the ACTIVE interval covering the pay date.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ValidationError, NotFoundError } from "../errors";

const ENTITY = "EmployeeCppDisability";

export type CppDisabilityStatus = "NOT_DISABLED" | "CPP_DISABLED" | "QPP_DISABLED";

export interface CppDisabilityView {
  id: string;
  clubId: string;
  employeeId: string;
  status: CppDisabilityStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceBasis: string | null;
  createdAt: Date;
}

const STATUSES: readonly CppDisabilityStatus[] = ["NOT_DISABLED", "CPP_DISABLED", "QPP_DISABLED"];

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface RecordDisabilityInput {
  employeeId: string;
  status: CppDisabilityStatus;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  sourceBasis?: string | null;
}

/**
 * Record a new CPP disability status row. If an existing OPEN row
 * (effectiveTo NULL) covers `effectiveFrom` for the same employee,
 * that row's `effectiveTo` is capped at the new `effectiveFrom` so
 * the timeline stays a clean partition.
 */
export async function recordCppDisabilityStatus(
  principal: Principal,
  clubId: string,
  input: RecordDisabilityInput,
): Promise<CppDisabilityView> {
  requirePermission(principal, clubId, "payroll:run");

  if (!STATUSES.includes(input.status)) {
    throw new ValidationError([{ path: "status", message: `status must be one of ${STATUSES.join(", ")}` }]);
  }
  if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) {
    throw new ValidationError([{ path: "effectiveTo", message: "effectiveTo must be strictly greater than effectiveFrom." }]);
  }
  if (input.sourceBasis && input.sourceBasis.length > 500) {
    throw new ValidationError([{ path: "sourceBasis", message: "sourceBasis is limited to 500 characters." }]);
  }
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, clubId }, select: { id: true } });
  if (!emp) throw new ValidationError([{ path: "employeeId", message: "Employee does not belong to this Club." }]);

  const from = utcMidnight(input.effectiveFrom);
  const to = input.effectiveTo ? utcMidnight(input.effectiveTo) : null;

  const row = await prisma.$transaction(async (tx) => {
    // Cap any open covering row.
    const openCovering = await tx.employeeCppDisability.findFirst({
      where: {
        clubId,
        employeeId: input.employeeId,
        effectiveFrom: { lt: from },
        effectiveTo: null,
      },
    });
    if (openCovering) {
      await tx.employeeCppDisability.update({
        where: { id: openCovering.id },
        data: { effectiveTo: from },
      });
    }
    return tx.employeeCppDisability.create({
      data: {
        clubId,
        employeeId: input.employeeId,
        status: input.status,
        effectiveFrom: from,
        effectiveTo: to,
        sourceBasis: input.sourceBasis?.trim() ?? null,
        recordedByUserId: principal.id,
      },
    });
  });

  await audit(principal, {
    action: "payroll.cpp-disability.record",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: {
      employeeId: input.employeeId,
      status: input.status,
      effectiveFrom: from.toISOString(),
      effectiveTo: to?.toISOString() ?? null,
    },
  });

  return toView(row);
}

/** ACTIVE disability status covering `payDate`, or null. */
export async function resolveActiveDisabilityOn(
  clubId: string,
  employeeId: string,
  payDate: Date,
): Promise<CppDisabilityView | null> {
  const d = utcMidnight(payDate);
  const row = await prisma.employeeCppDisability.findFirst({
    where: {
      clubId,
      employeeId,
      effectiveFrom: { lte: d },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: d } }],
    },
    orderBy: [{ effectiveFrom: "desc" }],
  });
  return row ? toView(row) : null;
}

function toView(row: Awaited<ReturnType<typeof prisma.employeeCppDisability.findFirst>>): CppDisabilityView {
  if (!row) throw new NotFoundError(ENTITY, "(null)");
  return {
    id: row.id,
    clubId: row.clubId,
    employeeId: row.employeeId,
    status: row.status as CppDisabilityStatus,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    sourceBasis: row.sourceBasis,
    createdAt: row.createdAt,
  };
}
