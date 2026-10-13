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
  /** MBR-PY-1 (2026-10-13) — YTD IS_PAYROLL for this department in
   *  the comparable prior-year period (same fiscal YTD window shifted
   *  back one year).  Null when no committed prior-year TB exists for
   *  the matched period, or when this department has no prior-year
   *  payroll row — never fabricated $0 so the chart's 3rd series
   *  can honestly omit missing bars. */
  priorYearActual: number | null;
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
  /** MBR-PY-1 (2026-10-13) — consolidated prior-year YTD IS_PAYROLL
   *  Actual across every operating department (same scope as
   *  `consolidatedActualAll` but one fiscal year earlier).  Null when
   *  no committed prior-year TB covers the matched period. */
  consolidatedPriorYearActualAll: number | null;
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

  // MBR-PY-1 (2026-10-13) — prior-year comparable window.  Same
  // calendar-month end-of-period shifted back one year; same fiscal
  // YTD start.  `incomeStatementByDepartmentFromSnapshot` matches the
  // committed Mar 2025 TB when periodStart = 2025-01-01 and periodEnd
  // = 2025-03-31 (via `reportingAccountBalances` YTD-slice shape).
  // When no 2025 TB covers that window, the resolver's internal
  // `allowCarryForward` returns an operational-ledger result with
  // empty department rows — we filter that case out so the chart's
  // prior-year series stays honestly null.
  const priorYear = fiscalYear - 1;
  const priorFiscalYtdStart = new Date(Date.UTC(priorYear, 0, 1));
  const priorPeriodEnd = new Date(Date.UTC(
    priorYear,
    periodEnd.getUTCMonth(),
    periodEnd.getUTCDate(),
    23, 59, 59, 999,
  ));

  const [actualDept, priorYearDept, budgetMap, rosterStatus] = await Promise.all([
    incomeStatementByDepartmentFromSnapshot(clubId, fiscalYtdStart, periodEnd),
    incomeStatementByDepartmentFromSnapshot(clubId, priorFiscalYtdStart, priorPeriodEnd).catch(() => null),
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
  // MBR-PY-1 (2026-10-13) — prior-year amounts overlay onto existing
  // Entry rows by department code.  Prior-year-only departments are
  // NOT added to `byCode` (the chart's x-axis is driven by current-
  // year + budget; prior-year is a comparative overlay, not a seed).
  // ------------------------------------------------------------------
  type Entry = {
    code: string;
    name: string;
    actual: number;
    budget: number | null;
    priorYearActual: number | null;
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
        priorYearActual: null,
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
          priorYearActual: null,
        });
      }
    }
  }

  // MBR-PY-1 — overlay Prior-Year departmental payroll Actual onto
  // existing entries.  Only departments already present in `byCode`
  // (current-year or budget-visible) receive a prior-year value;
  // prior-year-only departments are intentionally NOT added so the
  // chart's x-axis stays stable with the current-year scope.
  //
  // Null tracking: `consolidatedPriorYearActualAll` stays null when
  // the prior-year TB wasn't resolved (no `priorYearDept`) or when
  // the resolver returned no payroll rows — the chart's prior-year
  // series is then entirely absent.
  let consolidatedPriorYearActualAll: number | null = null;
  if (priorYearDept != null && priorYearDept.rows.length > 0) {
    const priorByDept = new Map<string, number>();
    let anyPriorPayroll = false;
    for (const r of priorYearDept.rows) {
      const payroll = Number(r.payroll.toString());
      if (payroll !== 0) anyPriorPayroll = true;
      if (r.departmentCode == null) continue;
      priorByDept.set(r.departmentCode, payroll);
    }
    if (anyPriorPayroll) {
      consolidatedPriorYearActualAll = 0;
      for (const r of priorYearDept.rows) {
        consolidatedPriorYearActualAll += Number(r.payroll.toString());
      }
      for (const entry of byCode.values()) {
        const prior = priorByDept.get(entry.code);
        if (prior != null && prior !== 0) entry.priorYearActual = prior;
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
      priorYearActual: e.priorYearActual,
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
    consolidatedPriorYearActualAll,
    rows,
    rosterResidualActual,
    rosterResidualBudget,
    rosterStatus: {
      hasEmployeeRecords: rosterStatus.hasEmployeeRecords,
      employeeCountByDepartment: rosterStatus.employeeCountByDepartment,
    },
  };
}
