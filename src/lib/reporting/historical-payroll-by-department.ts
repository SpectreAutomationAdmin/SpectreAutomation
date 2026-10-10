// PAYROLL-HIST-1 (2026-10-04) — historical payroll by department
// resolver for the Monthly Reporting Package.
//
// WHY THIS EXISTS
//
// Section II's "Payroll Analysis — Department Breakdown" is a
// HISTORICAL FINANCIAL REPORT. Its question is "where was payroll
// expense recorded during the selected period?" — NOT "which
// departments currently have Employee records in Spectre?".
//
// Prior (REPORT-WIRING-1B) the card consumed `resolvePayrollDepartments`
// which reads from `prisma.employee`. On Coulee staging only 2
// departments have Employee records → the chart hid ~$72K of real
// January IS_PAYROLL activity booked to other departments.
//
// Correct architecture (per directive §1):
//   • Operational Payroll roster → `resolvePayrollDepartments` (kept)
//   • Historical payroll financial analysis → THIS resolver
//
// Classification is first-class COA (`fsGroupKey === "IS_PAYROLL"`
// + operating-fund via `isOperatingFundTag`). Department set is the
// UNION of departments with authoritative IS_PAYROLL Actual OR
// IS_PAYROLL Budget for the selected period.

import {
  incomeStatementByDepartmentFromSnapshot,
} from "@/lib/accounting/dept-pl-from-snapshot";
import { resolveBudgetPayrollByDepartment } from "@/lib/reporting/budget-resolver";
import { resolvePayrollDepartments } from "@/lib/reporting/payroll-departments-resolver";

export type HistoricalPayrollDepartmentRow = {
  departmentCode: string | null;
  departmentName: string;
  /** YTD Actual IS_PAYROLL for this department within the period. */
  actual: number;
  /** YTD Budget IS_PAYROLL for this department (null when the Budget
   *  resolver has no Budget row for this dept — never fabricated $0). */
  budget: number | null;
  /** Current Employee count on this department — DIAGNOSTIC ONLY.
   *  Zero does NOT suppress inclusion. */
  currentEmployeeCount: number;
};

export type HistoricalPayrollResult = {
  /** Canonical consolidated IS_PAYROLL Actual across every operating
   *  department (including the Nondepartmental bucket). Used by the
   *  card's headline KPI tiles so they match the GL / ratio-registry
   *  consolidated payroll exactly. */
  consolidatedActualAll: number;
  /** Same for Budget. Null when Budget resolver returned nothing. */
  consolidatedBudgetAll: number | null;
  /** Rows the chart renders — only departments with Actual > 0 OR
   *  Budget > 0 (never nondepartmental; never zero-row). */
  rows: HistoricalPayrollDepartmentRow[];
  /** Payroll Actual booked to departments EXCLUDED from the chart
   *  (nondepartmental bucket + any department with zero activity).
   *  Surfaced as the "reconciliation residual" so the delta between
   *  roster-visible + consolidated is explicit. */
  rosterResidualActual: number;
  rosterResidualBudget: number;
  rosterStatus: {
    hasEmployeeRecords: boolean;
    employeeCountByDepartment: ReadonlyMap<string, number>;
  };
};

export async function resolveHistoricalPayrollByDepartment(
  clubId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<HistoricalPayrollResult> {
  const throughMonth = periodEnd.getUTCMonth() + 1;
  const fiscalYear = periodEnd.getUTCFullYear();
  // MBR-FIX-2G (2026-10-10) — the Jonas TB snapshot's YTD-slice
  // `sameDay(snapshot.periodStart, filter.from)` gate requires
  // `from = fiscal-year start` (Jan 1), not the current-month
  // start the caller passes (`period.periodStart = Feb 1` for
  // the Feb package).  Section XII inherits the Section X fix:
  // compute fiscal-YTD start locally.  Same DEF-4 pattern
  // MBR-FIX-1 / 2A / 2B / 2C / 2D / 2E / 2F corrected on their
  // respective paths.  The `periodStart` parameter is kept on
  // the signature for API stability — callers that happen to
  // pass fiscal-year start already stay correct.
  const fiscalYtdStart = new Date(Date.UTC(fiscalYear, 0, 1));
  void periodStart;

  const [actualDept, budgetMap, rosterStatus] = await Promise.all([
    incomeStatementByDepartmentFromSnapshot(clubId, fiscalYtdStart, periodEnd),
    resolveBudgetPayrollByDepartment({
      clubId,
      fiscalYear,
      throughMonth,
    }).catch(() => new Map<string | null, number>()),
    resolvePayrollDepartments(clubId).catch(() => ({
      hasEmployeeRecords: false,
      departmentCodes: new Set<string>(),
      employeeCountByDepartment: new Map<string, number>(),
    })),
  ]);

  // ------------------------------------------------------------------
  // Union of departments: Actual payroll > 0 OR Budget payroll > 0.
  // Nondepartmental (code === null) rolls into the roster residual
  // because the chart has no x-slot for it.
  // ------------------------------------------------------------------
  type Entry = {
    code: string;
    name: string;
    actual: number;
    budget: number | null;
  };
  const byCode = new Map<string, Entry>();
  const nameByCode = new Map<string, string>();

  // Seed from Actual dept rows.
  let consolidatedActualAll = 0;
  let nondepartmentalActual = 0;
  for (const r of actualDept.rows) {
    const payroll = Number(r.payroll.toString());
    consolidatedActualAll += payroll;
    if (r.departmentCode == null) {
      nondepartmentalActual += payroll;
      continue;
    }
    nameByCode.set(r.departmentCode, r.departmentName);
    if (payroll !== 0) {
      byCode.set(r.departmentCode, {
        code: r.departmentCode,
        name: r.departmentName,
        actual: payroll,
        budget: null,
      });
    }
  }

  // Add Budget dept entries + overlay onto Actual entries.
  let consolidatedBudgetAll: number | null = null;
  let nondepartmentalBudget = 0;
  if (budgetMap.size > 0) {
    consolidatedBudgetAll = 0;
    for (const [code, amount] of budgetMap.entries()) {
      consolidatedBudgetAll += amount;
      if (code == null) {
        nondepartmentalBudget += amount;
        continue;
      }
      const existing = byCode.get(code);
      if (existing) {
        existing.budget = amount;
      } else if (amount !== 0) {
        byCode.set(code, {
          code,
          name: nameByCode.get(code) ?? code,
          actual: 0,
          budget: amount,
        });
      }
    }
  }

  const rows: HistoricalPayrollDepartmentRow[] = Array.from(byCode.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      departmentCode: e.code,
      departmentName: e.name,
      actual: e.actual,
      budget: e.budget,
      currentEmployeeCount: rosterStatus.employeeCountByDepartment.get(e.code) ?? 0,
    }));

  // Residual = payroll NOT on the chart. For Actual this is the
  // nondepartmental bucket (chart has no slot for it) + any department
  // dropped from `rows` because both Actual and Budget are zero (none
  // today — the filter above already requires one or the other).
  const chartedActual = rows.reduce((s, r) => s + r.actual, 0);
  const chartedBudget = rows.reduce((s, r) => s + (r.budget ?? 0), 0);
  const rosterResidualActual = consolidatedActualAll - chartedActual;
  const rosterResidualBudget =
    consolidatedBudgetAll == null ? 0 : consolidatedBudgetAll - chartedBudget;

  return {
    consolidatedActualAll,
    consolidatedBudgetAll,
    rows,
    rosterResidualActual,
    rosterResidualBudget,
    rosterStatus: {
      hasEmployeeRecords: rosterStatus.hasEmployeeRecords,
      employeeCountByDepartment: rosterStatus.employeeCountByDepartment,
    },
  };
}
