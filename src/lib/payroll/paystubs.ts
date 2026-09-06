// Payroll MVP posting (2026-09-05) — pay statement read service.
//
// Reads immutable pay-statement data from PayrollBatchEmployee. Never
// recomputes anything — the row is the source of truth once the batch
// is CALCULATED or later. Available to `payroll:read` for administrators
// and to the employee themselves (Employee.userId == principal.id).

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { ForbiddenError, NotFoundError } from "../errors";
import { assertTenantOwned } from "../services/tenant";

const ENTITY = "PayrollBatch";

export interface PayStatement {
  batchId:              string;
  batchEmployeeId:      string;
  clubId:               string;
  status:               string;
  payPeriod: {
    startIso:           string;
    endInclusiveIso:    string;
    payDateIso:         string;
    taxYear:            number;
    sequenceInYear:     number;
  };
  employer: {
    clubName:           string;
  };
  employee: {
    employeeId:         string;
    firstName:          string;
    lastName:           string;
    employeeNumber:     string | null;
    homeProvince:       string | null;
  };
  earnings: {
    gross:              string;
    taxable:            string;
    pensionable:        string;
    insurable:          string;
    breakdown:          Array<{ type: string; quantity: string; rate: string; amount: string }>;
  };
  employeeDeductions: {
    cpp:                string;
    cpp2:               string;
    ei:                 string;
    federalTax:         string;
    provincialTax:      string;
    total:              string;
  };
  employerContributions: {
    cpp:                string;
    cpp2:               string;
    ei:                 string;
    total:              string;
  };
  netPay:               string;
  posted: {
    isPosted:           boolean;
    postedAtIso:        string | null;
    glJournalEntryId:   string | null;
  };
}

function d(x: unknown): string {
  if (x === null || x === undefined) return "0.00";
  return (x as { toFixed?: (n: number) => string }).toFixed
    ? (x as { toFixed: (n: number) => string }).toFixed(2)
    : String(x);
}

function addD(...xs: unknown[]): string {
  const total = xs.reduce<number>((acc, v) => acc + Number(v ?? 0), 0);
  return total.toFixed(2);
}

/**
 * All pay statements in a batch — used by an administrator with
 * `payroll:read` to view / print every stub after posting.
 */
export async function getBatchPayStatements(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<PayStatement[]> {
  requirePermission(principal, clubId, "payroll:read");

  const batch = await prisma.payrollBatch.findUnique({
    where: { id: batchId },
    include: {
      payPeriod: true,
      club: { select: { name: true } },
      employees: {
        include: { employee: true, earnings: true },
        orderBy: [{ employee: { lastName: "asc" } }, { employee: { firstName: "asc" } }],
      },
    },
  });
  if (!batch) throw new NotFoundError(ENTITY, batchId);
  assertTenantOwned(batch, principal);
  if (batch.clubId !== clubId) throw new NotFoundError(ENTITY, batchId);

  return batch.employees.map((row) => materialise(batch, row));
}

/**
 * A single pay statement — accessible to the employee themselves OR to
 * anyone with `payroll:read` at the club.
 */
export async function getPayStatement(
  principal: Principal,
  clubId: string,
  batchEmployeeId: string,
): Promise<PayStatement> {
  const row = await prisma.payrollBatchEmployee.findUnique({
    where: { id: batchEmployeeId },
    include: {
      employee: true,
      earnings: true,
      batch: {
        include: {
          payPeriod: true,
          club: { select: { name: true } },
        },
      },
    },
  });
  if (!row) throw new NotFoundError("PayrollBatchEmployee", batchEmployeeId);
  assertTenantOwned(row, principal);
  if (row.batch.clubId !== clubId) throw new NotFoundError("PayrollBatchEmployee", batchEmployeeId);

  const isSelf = row.employee.userId === principal.id;
  if (!isSelf) requirePermission(principal, clubId, "payroll:read");
  else if (row.employee.userId !== principal.id) {
    throw new ForbiddenError("You may only view your own pay statement.");
  }

  return materialise(row.batch, row);
}

interface MinBatch {
  id: string; clubId: string; status: string;
  postedAt: Date | null;
  glJournalEntryId?: string | null;
  payPeriod: { periodStart: Date; periodEnd: Date; payDate: Date; taxYear: number; sequenceInYear: number };
  club: { name: string };
}
interface MinRow {
  id: string;
  employee: {
    id: string; firstName: string; lastName: string;
    employeeNumber: string | null; homeProvince: string | null;
  };
  earnings?: Array<{ earningType: string; quantity?: unknown; rate?: unknown }>;
  grossPay?: unknown;
  earningsTaxable?: unknown; earningsPensionable?: unknown; earningsInsurable?: unknown;
  deductionCppEeCombined?: unknown; deductionCpp2Ee?: unknown;
  deductionEiEe?: unknown; deductionFederalTax?: unknown; deductionProvincialTax?: unknown;
  totalEmployeeDeductions?: unknown;
  employerCppCombined?: unknown; employerCpp2?: unknown; employerEi?: unknown;
  netPay?: unknown;
}

function materialise(batch: MinBatch, row: MinRow): PayStatement {
  const eeTotal = row.totalEmployeeDeductions != null
    ? d(row.totalEmployeeDeductions)
    : addD(row.deductionCppEeCombined, row.deductionCpp2Ee, row.deductionEiEe,
           row.deductionFederalTax, row.deductionProvincialTax);
  const erTotal = addD(row.employerCppCombined, row.employerCpp2, row.employerEi);

  const breakdown = (row.earnings ?? []).map((e) => {
    const qty  = Number(e.quantity ?? 0);
    const rate = Number(e.rate ?? 0);
    return {
      type: e.earningType,
      quantity: qty.toFixed(2),
      rate: rate.toFixed(2),
      amount: (qty * rate).toFixed(2),
    };
  });

  return {
    batchId: batch.id,
    batchEmployeeId: row.id,
    clubId: batch.clubId,
    status: batch.status,
    payPeriod: {
      startIso: batch.payPeriod.periodStart.toISOString(),
      endInclusiveIso: new Date(batch.payPeriod.periodEnd.getTime() - 86_400_000).toISOString(),
      payDateIso: batch.payPeriod.payDate.toISOString(),
      taxYear: batch.payPeriod.taxYear,
      sequenceInYear: batch.payPeriod.sequenceInYear,
    },
    employer: { clubName: batch.club.name },
    employee: {
      employeeId: row.employee.id,
      firstName: row.employee.firstName,
      lastName: row.employee.lastName,
      employeeNumber: row.employee.employeeNumber,
      homeProvince: row.employee.homeProvince,
    },
    earnings: {
      gross:       d(row.grossPay),
      taxable:     d(row.earningsTaxable),
      pensionable: d(row.earningsPensionable),
      insurable:   d(row.earningsInsurable),
      breakdown,
    },
    employeeDeductions: {
      cpp:           d(row.deductionCppEeCombined),
      cpp2:          d(row.deductionCpp2Ee),
      ei:            d(row.deductionEiEe),
      federalTax:    d(row.deductionFederalTax),
      provincialTax: d(row.deductionProvincialTax),
      total:         eeTotal,
    },
    employerContributions: {
      cpp:   d(row.employerCppCombined),
      cpp2:  d(row.employerCpp2),
      ei:    d(row.employerEi),
      total: erTotal,
    },
    netPay: d(row.netPay),
    posted: {
      isPosted: batch.status === "POSTED",
      postedAtIso: batch.postedAt ? batch.postedAt.toISOString() : null,
      glJournalEntryId: batch.glJournalEntryId ?? null,
    },
  };
}
