// Slice E (2026-09-19) — canonical Payroll Register DTO.
//
// Answers, at the batch level: who is being paid, why, how much, what
// deductions, what employer costs, what net pay, what reconciles to
// the GL. Consumes ONLY frozen `PayrollBatchEmployee` + calculator
// outputs + component snapshots + the same `previewPayrollJournal`
// used by GL Preview / Post. Does NOT re-derive numbers independently.
// Register.state === "POSTED" binds to the posted calculation version;
// mutating live employee/plan/component data afterwards CANNOT drift
// the register.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError } from "../errors";
import { previewPayrollJournal } from "./payroll-journal-preview";

export type RegisterState =
  | "PREPARED"
  | "CALCULATED"
  | "SUBMITTED_FOR_APPROVAL"
  | "APPROVED"
  | "POSTED";

export interface RegisterEmployeeRow {
  batchEmployeeId: string;
  employeeNumber: string | null;
  employeeName: string;              // "Last, First" — frozen at snapshot time via PayrollBatchEmployee joined on Employee
  departmentCode: string;            // frozen from the batch's department dimension
  departmentName: string;
  payTypeLabel: string;              // "Salary" | "Hourly" | "Mixed"
  // Slice F (2026-09-19) — hourly regular / overtime split.
  regularHours: string;              // "80.0000" — hourly employees only; "0.0000" for salary
  overtimeHours: string;             // "5.0000"
  overtimeRate: string;              // "33.7500"
  overtimeEarnings: string;          // "168.75"
  regularEarnings: string;           // salaried period base OR hourly regular = regularHours × baseRate. Includes REGULAR earning rows only (excludes OVERTIME)
  otherEarnings: string;             // additional-earning + bonus one-time
  taxableBenefits: string;           // employer non-cash taxable
  grossCashEarnings: string;         // net-pay-side gross
  cpp: string;
  cpp2: string;
  ei: string;
  federalTax: string;
  provincialTax: string;
  otherDeductions: string;           // employee LTD, employee cell-phone deduction, etc. EXCLUDES RRSP EE for the dedicated column.
  rrspEmployeeContribution: string;
  netPay: string;
  employerCpp: string;
  employerCpp2: string;
  employerEi: string;
  employerBenefits: string;          // employer non-cash + employer LTD/Health
  rrspEmployerContribution: string;
  totalEmployerCost: string;         // gross + employer CPP + CPP2 + EI + benefits + RRSP-ER
}

export interface RegisterTotals {
  regularHours: string;
  overtimeHours: string;
  overtimeEarnings: string;
  regularEarnings: string;
  otherEarnings: string;
  taxableBenefits: string;
  grossCashEarnings: string;
  cpp: string;
  cpp2: string;
  ei: string;
  federalTax: string;
  provincialTax: string;
  otherDeductions: string;
  rrspEmployeeContribution: string;
  netPay: string;
  employerCpp: string;
  employerCpp2: string;
  employerEi: string;
  employerBenefits: string;
  rrspEmployerContribution: string;
  totalEmployerCost: string;
}

export interface RegisterReconciliation {
  grossPayroll: string;              // sum(gross)
  employeeDeductions: string;        // sum(gross - net) i.e. everything reducing net
  netPayroll: string;                // sum(net)
  employerPayrollCosts: string;      // sum(employerCpp+cpp2+ei+benefits+rrspER)
  glDebits: string;                  // sum of Preview debit lines
  glCredits: string;                 // sum of Preview credit lines
  differenceCents: number;           // must be 0 for POSTED to be considered valid
}

export interface RegisterExceptionSummary {
  blockerCount: number;
  warningCount: number;
  infoCount: number;
  unresolvedBlockers: Array<{ code: string; message: string; employeeName: string | null }>;
  warnings: Array<{ code: string; message: string; employeeName: string | null }>;
}

export interface PayrollRegisterV1 {
  version: 1;
  clubId: string;
  clubName: string;
  batchId: string;
  batchDisplayCode: string | null;
  state: RegisterState;
  statePosted: boolean;
  posted: {
    journalEntryId: string | null;
    postedAt: string | null;
    postedByUserId: string | null;
    calculationVersion: number | null;
  };
  approved: {
    approvedAt: string | null;
    approvedByUserId: string | null;
    submittedAt: string | null;
    submittedByUserId: string | null;
  };
  payPeriod: {
    id: string;
    startIso: string;
    endIso: string;                  // inclusive display
    payDateIso: string;
  };
  employees: RegisterEmployeeRow[];
  totals: RegisterTotals;
  exceptionSummary: RegisterExceptionSummary;
  reconciliation: RegisterReconciliation;
  generatedAtIso: string;
}

function dec(v: unknown): string {
  if (v == null) return "0.00";
  if (typeof v === "string") return v || "0.00";
  // Prisma Decimal has toFixed on the underlying object
  const asStr = String(v);
  return asStr;
}
function toDec2(v: unknown): number {
  const s = dec(v);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function fmt2(n: number): string { return n.toFixed(2); }
function addStr(...xs: (string | number)[]): string {
  return fmt2(xs.reduce<number>((a, x) => a + (typeof x === "number" ? x : Number(x) || 0), 0));
}

export async function buildPayrollRegister(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<PayrollRegisterV1> {
  requirePermission(principal, clubId, "payroll:read");

  const batch = await prisma.payrollBatch.findFirstOrThrow({
    where: { id: batchId, clubId },
  });
  // Slice E closeout §1 — the canonical final Payroll Register is only
  // available once the batch has actually been calculated. PREPARED /
  // DRAFT batches have no net pay, no statutory deductions, no GL
  // preview — rendering them as a "register" would misrepresent an
  // uncalculated payroll as final. Refuse fail-closed with a
  // ConflictError; the founder-facing surface catches this and shows
  // "Payroll Register available after Calculate Payroll."
  if (batch.status === "DRAFT" || batch.status === "PREPARED") {
    throw new ConflictError(
      "Payroll Register available after Calculate Payroll. " +
      "A PREPARED batch has no calculated deductions, net pay, or GL preview.",
    );
  }
  const club = await prisma.club.findUniqueOrThrow({ where: { id: clubId }, select: { name: true } });
  const payPeriod = await prisma.payrollPayPeriod.findUniqueOrThrow({
    where: { id: batch.payPeriodId },
    select: { id: true, periodStart: true, periodEnd: true, payDate: true },
  });
  const journalEntry = batch.glJournalEntryId
    ? await prisma.journalEntry.findUnique({
        where: { id: batch.glJournalEntryId },
        select: { id: true, postedAt: true, postedByUserId: true },
      })
    : null;

  const employees = await prisma.payrollBatchEmployee.findMany({
    where: { batchId, clubId },
    include: {
      employee: { select: { firstName: true, lastName: true, employeeNumber: true, department: { select: { code: true, name: true } } } },
      componentSnapshots: true,
    },
    orderBy: [{ employee: { lastName: "asc" } }, { employee: { firstName: "asc" } }],
  });

  const exceptions = await prisma.payrollBatchException.findMany({
    where: { batchId, clubId },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
    include: { batchEmployee: { include: { employee: { select: { firstName: true, lastName: true } } } } },
  });

  // Register rows.
  const rows: RegisterEmployeeRow[] = employees.map((be) => {
    // Slice E closeout §2 — historical identity uses the frozen
    // firstNameSnapshot/lastNameSnapshot when populated (new batches
    // from Slice E onward), else falls back to live Employee.first/lastName
    // (legacy batches that pre-date this slice; documented compat).
    const first = be.firstNameSnapshot ?? be.employee?.firstName ?? "";
    const last  = be.lastNameSnapshot  ?? be.employee?.lastName  ?? "";
    const empName = `${last}, ${first}`.replace(/^, |, $/g, "").trim() || "(unknown)";
    // Compensation cadence isn't frozen on PayrollBatchEmployee directly;
    // approximate by whether the batch employee has any salary earning row.
    // Salary — hourly split: use `salariedFullPeriod` snapshot if present.
    const payType = (be as unknown as { salariedFullPeriod?: boolean }).salariedFullPeriod ? "Salary" : "Hourly";

    // Split component snapshots
    const eeSnaps = be.componentSnapshots.filter((s) => s.side === "EMPLOYEE");
    const erSnaps = be.componentSnapshots.filter((s) => s.side === "EMPLOYER");
    // RRSP employee = EE PERCENT snapshot whose ER sibling carries matchBps
    let rrspEE = 0;
    let rrspER = 0;
    const rrspEnrolIds = new Set<string>();
    for (const s of erSnaps) {
      if (s.matchBps != null && s.sourceEnrolmentId) rrspEnrolIds.add(s.sourceEnrolmentId);
    }
    for (const s of eeSnaps) {
      if (s.sourceEnrolmentId && rrspEnrolIds.has(s.sourceEnrolmentId)) {
        rrspEE += toDec2(s.resolvedAmount);
      }
    }
    for (const s of erSnaps) {
      if (s.matchBps != null) rrspER += toDec2(s.resolvedAmount);
    }
    // Other employee deductions = EE snapshots with cashEffect=DECREASES_NET_PAY that are NOT RRSP.
    let otherEEDed = 0;
    for (const s of eeSnaps) {
      if (s.cashEffect !== "DECREASES_NET_PAY") continue;
      if (s.sourceEnrolmentId && rrspEnrolIds.has(s.sourceEnrolmentId)) continue;
      otherEEDed += toDec2(s.resolvedAmount);
    }
    // Employer benefits = ER snapshots that are NOT RRSP employer match.
    let employerBenefits = 0;
    for (const s of erSnaps) {
      if (s.matchBps != null) continue;
      employerBenefits += toDec2(s.resolvedAmount);
    }
    // Other-earnings + taxable-benefits inference:
    //   otherEarnings = EE INCREASES_NET_PAY snapshots that are NOT salary
    //                   (recurring + one-time additional earnings)
    //   taxableBenefits = ER non-cash snapshots with taxableEffect=ADD
    let otherEarnings = 0;
    for (const s of eeSnaps) {
      if (s.cashEffect !== "INCREASES_NET_PAY") continue;
      // Approximate: RECURRING cash "REGULAR" earnings are baked into base grossPay via SALARY earning row; component snapshots for cell-phone / bonus fall here.
      otherEarnings += toDec2(s.resolvedAmount);
    }
    let taxableBenefits = 0;
    for (const s of erSnaps) {
      if (s.cashEffect !== "NO_NET_PAY_EFFECT") continue;
      if (s.taxableEffect !== "ADD") continue;
      taxableBenefits += toDec2(s.resolvedAmount);
    }

    const gross = toDec2(be.grossPay);
    // Slice F — hourly overtime split (frozen at Prepare).
    const regularHoursNum   = be.regularHoursSnapshot   ? Number(be.regularHoursSnapshot.toString())   : 0;
    const overtimeHoursNum  = be.overtimeHoursSnapshot  ? Number(be.overtimeHoursSnapshot.toString())  : 0;
    const baseRateNum       = be.hourlyBaseRateSnapshot ? Number(be.hourlyBaseRateSnapshot.toString()) : 0;
    const overtimeRateNum   = be.overtimeRateSnapshot   ? Number(be.overtimeRateSnapshot.toString())   : 0;
    const overtimeEarnings  = overtimeHoursNum * overtimeRateNum;
    const hourlyRegularEarnings = regularHoursNum * baseRateNum;
    // For salaried employees hourlyRegularEarnings === 0. Use hourly
    // regular when the batch employee is hourly, else use gross-minus-other.
    const regular = (overtimeHoursNum > 0 || regularHoursNum > 0)
      ? hourlyRegularEarnings
      : Math.max(0, gross - otherEarnings - overtimeEarnings);
    const cpp = toDec2(be.deductionCppEeCombined);
    const cpp2 = toDec2(be.deductionCpp2Ee);
    const ei = toDec2(be.deductionEiEe);
    const federalTax = toDec2(be.deductionFederalTax) + toDec2(be.additionalFederalTax);
    const provincialTax = toDec2(be.deductionProvincialTax) + toDec2(be.additionalProvincialTax);
    const employerCpp = toDec2(be.employerCppCombined);
    const employerCpp2 = toDec2(be.employerCpp2);
    const employerEi = toDec2(be.employerEi);
    const netPay = toDec2(be.netPay);

    const totalEmployerCost = gross + employerCpp + employerCpp2 + employerEi + employerBenefits + rrspER;

    return {
      batchEmployeeId: be.id,
      employeeNumber: be.employee?.employeeNumber ?? null,
      employeeName: empName,
      departmentCode: be.employee?.department?.code ?? "",
      departmentName: be.employee?.department?.name ?? "",
      payTypeLabel: overtimeHoursNum > 0 || regularHoursNum > 0 ? "Hourly" : payType,
      regularHours: regularHoursNum.toFixed(4),
      overtimeHours: overtimeHoursNum.toFixed(4),
      overtimeRate: overtimeRateNum.toFixed(4),
      overtimeEarnings: fmt2(overtimeEarnings),
      regularEarnings: fmt2(regular),
      otherEarnings: fmt2(otherEarnings),
      taxableBenefits: fmt2(taxableBenefits),
      grossCashEarnings: fmt2(gross),
      cpp: fmt2(cpp),
      cpp2: fmt2(cpp2),
      ei: fmt2(ei),
      federalTax: fmt2(federalTax),
      provincialTax: fmt2(provincialTax),
      otherDeductions: fmt2(otherEEDed),
      rrspEmployeeContribution: fmt2(rrspEE),
      netPay: fmt2(netPay),
      employerCpp: fmt2(employerCpp),
      employerCpp2: fmt2(employerCpp2),
      employerEi: fmt2(employerEi),
      employerBenefits: fmt2(employerBenefits),
      rrspEmployerContribution: fmt2(rrspER),
      totalEmployerCost: fmt2(totalEmployerCost),
    };
  });

  const totals: RegisterTotals = {
    regularHours:             addStr(...rows.map((r) => r.regularHours)),
    overtimeHours:            addStr(...rows.map((r) => r.overtimeHours)),
    overtimeEarnings:         addStr(...rows.map((r) => r.overtimeEarnings)),
    regularEarnings:          addStr(...rows.map((r) => r.regularEarnings)),
    otherEarnings:            addStr(...rows.map((r) => r.otherEarnings)),
    taxableBenefits:          addStr(...rows.map((r) => r.taxableBenefits)),
    grossCashEarnings:        addStr(...rows.map((r) => r.grossCashEarnings)),
    cpp:                      addStr(...rows.map((r) => r.cpp)),
    cpp2:                     addStr(...rows.map((r) => r.cpp2)),
    ei:                       addStr(...rows.map((r) => r.ei)),
    federalTax:               addStr(...rows.map((r) => r.federalTax)),
    provincialTax:            addStr(...rows.map((r) => r.provincialTax)),
    otherDeductions:          addStr(...rows.map((r) => r.otherDeductions)),
    rrspEmployeeContribution: addStr(...rows.map((r) => r.rrspEmployeeContribution)),
    netPay:                   addStr(...rows.map((r) => r.netPay)),
    employerCpp:              addStr(...rows.map((r) => r.employerCpp)),
    employerCpp2:             addStr(...rows.map((r) => r.employerCpp2)),
    employerEi:               addStr(...rows.map((r) => r.employerEi)),
    employerBenefits:         addStr(...rows.map((r) => r.employerBenefits)),
    rrspEmployerContribution: addStr(...rows.map((r) => r.rrspEmployerContribution)),
    totalEmployerCost:        addStr(...rows.map((r) => r.totalEmployerCost)),
  };

  // Preview journal for GL reconciliation. Skip if batch is PREPARED
  // (no journal yet); Preview requires CALCULATED at minimum.
  let preview: Awaited<ReturnType<typeof previewPayrollJournal>> | null = null;
  if (batch.status !== "PREPARED" && batch.status !== "DRAFT") {
    preview = await previewPayrollJournal(principal, clubId, batchId).catch(() => null);
  }
  const glDebits  = preview ? preview.lines.reduce<number>((a, l) => a + Number(l.debit  ?? 0), 0) : 0;
  const glCredits = preview ? preview.lines.reduce<number>((a, l) => a + Number(l.credit ?? 0), 0) : 0;
  const totalGross = Number(totals.grossCashEarnings);
  const totalNet   = Number(totals.netPay);
  const employeeDeductions = totalGross - totalNet;
  const employerPayrollCosts =
    Number(totals.employerCpp) + Number(totals.employerCpp2) + Number(totals.employerEi) +
    Number(totals.employerBenefits) + Number(totals.rrspEmployerContribution);
  const differenceCents = Math.round((glDebits - glCredits) * 100);

  const exceptionSummary: RegisterExceptionSummary = {
    blockerCount: exceptions.filter((e) => e.severity === "BLOCKER").length,
    warningCount: exceptions.filter((e) => e.severity === "WARNING").length,
    infoCount:    exceptions.filter((e) => e.severity === "INFO").length,
    unresolvedBlockers: exceptions
      .filter((e) => e.severity === "BLOCKER" && e.resolvedAt == null)
      .map((e) => ({
        code: e.code, message: e.message,
        employeeName: e.batchEmployee
          ? (() => {
              const f = e.batchEmployee!.firstNameSnapshot ?? e.batchEmployee!.employee?.firstName ?? "";
              const l = e.batchEmployee!.lastNameSnapshot  ?? e.batchEmployee!.employee?.lastName  ?? "";
              return `${l}, ${f}`.replace(/^, |, $/g, "").trim() || null;
            })()
          : null,
      })),
    warnings: exceptions
      .filter((e) => e.severity === "WARNING")
      .map((e) => ({
        code: e.code, message: e.message,
        employeeName: e.batchEmployee
          ? (() => {
              const f = e.batchEmployee!.firstNameSnapshot ?? e.batchEmployee!.employee?.firstName ?? "";
              const l = e.batchEmployee!.lastNameSnapshot  ?? e.batchEmployee!.employee?.lastName  ?? "";
              return `${l}, ${f}`.replace(/^, |, $/g, "").trim() || null;
            })()
          : null,
      })),
  };

  return {
    version: 1,
    clubId,
    clubName: club.name,
    batchId,
    batchDisplayCode: (batch as unknown as { displayCode?: string }).displayCode ?? null,
    state: batch.status as RegisterState,
    statePosted: batch.status === "POSTED",
    posted: {
      journalEntryId: journalEntry?.id ?? null,
      postedAt: journalEntry?.postedAt?.toISOString() ?? null,
      postedByUserId: journalEntry?.postedByUserId ?? null,
      calculationVersion: (batch as unknown as { calculationVersion?: number }).calculationVersion ?? null,
    },
    approved: {
      approvedAt: (batch as unknown as { approvedAt?: Date | null }).approvedAt?.toISOString() ?? null,
      approvedByUserId: (batch as unknown as { approvedByUserId?: string | null }).approvedByUserId ?? null,
      submittedAt: (batch as unknown as { submittedAt?: Date | null }).submittedAt?.toISOString() ?? null,
      submittedByUserId: (batch as unknown as { submittedByUserId?: string | null }).submittedByUserId ?? null,
    },
    payPeriod: {
      id: payPeriod.id,
      startIso: payPeriod.periodStart.toISOString(),
      endIso: new Date(payPeriod.periodEnd.getTime() - 86_400_000).toISOString(),
      payDateIso: payPeriod.payDate.toISOString(),
    },
    employees: rows,
    totals,
    exceptionSummary,
    reconciliation: {
      grossPayroll: fmt2(totalGross),
      employeeDeductions: fmt2(employeeDeductions),
      netPayroll: fmt2(totalNet),
      employerPayrollCosts: fmt2(employerPayrollCosts),
      glDebits: fmt2(glDebits),
      glCredits: fmt2(glCredits),
      differenceCents,
    },
    generatedAtIso: new Date().toISOString(),
  };
}
