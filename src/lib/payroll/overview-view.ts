// Payroll Admin 3A (2026-09-10) — read-only Payroll Overview viewmodel.
//
// Assembles the data the `PayrollAdminSurface` component consumes, from
// the existing Payroll domain services and models. This module is a
// PURE READ-SIDE PROJECTION: it does not create batches, does not
// calculate, does not mutate a single row.
//
// The founder's Slice 3A directive is explicit:
//   - No Payroll lifecycle mutations.
//   - No new schema.
//   - Real value, truthful unavailable state, or neutral placeholder —
//     never fixture data.
//   - Do not begin 3B/3C functionality merely to populate KPIs.
//
// So: KPIs the domain can answer honestly today are wired from real
// reads; anything that would require executing calculation, resolving
// per-exception UI, or wiring new state machinery is left in the
// neutral placeholder state.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { listPayGroups } from "./pay-groups";
import { listPayPeriods } from "./pay-periods";
import { findActiveBatchForPeriod } from "./batch-preparation";
import { parseSourceFactsV1 } from "./source-facts-schema";
import { getDepartmentApprovalStatus, type DepartmentApprovalState } from "./department-approval";
import { translateException, type ExceptionSeverity } from "./exception-translations";
import { getTimeReadiness, type TimeReadinessState } from "./time-readiness";

/* ============================================================
   Types
   ============================================================ */

export interface PayrollOverviewPayGroupRef {
  id: string;
  name: string;
  frequencyLabel: string;
}
export interface PayrollOverviewPayPeriodRef {
  id: string;
  label: string;
  periodStartISO: string;
  periodEndISO: string;
  payDateISO: string;
}
export interface PayrollOverviewBatchRef {
  id: string;
  status: string;
  sequence: number;
  preparedAt: string | null;
  calculatedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
}
export interface PayrollOverviewEmployeeRow {
  batchEmployeeId: string;
  employeeId: string;
  displayName: string;
  department: string;
  regularHrs: string;
  otHrs: string;
  totalHrs: string;
  grossPay: string;
  status: string;
  salaried: boolean;
  viewHref: string;
}
export interface PayrollOverviewFilterState {
  q: string;
  department: string | null;
  employmentType: "Hourly" | "Salary" | null;
  status: string | null;
}

// Payroll Admin Slice 3B (2026-09-12) — real Exceptions tab data.
export interface PayrollOverviewExceptionRow {
  id: string;
  severity: ExceptionSeverity;
  code: string;
  label: string;
  message: string;
  employeeId: string | null;
  employeeDisplayName: string | null;
  recommendedAction: string | null;
  remediation: {
    kind: string;
    label: string;
    href: string | null;
  };
}

// Payroll Admin Slice 3B — real Approvals tab data. Extended by the
// 3B acceptance hotfix (2026-09-12) to distinguish reviewable-but-
// unfrozen scopes from Payroll-frozen scopes so the Approvals tab
// stops falsely showing "No departments to approve" when materialised
// timesheet entries exist.
export interface PayrollOverviewApprovalRow {
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  employeeCount: number;
  entryCount: number;
  frozenEntryCount: number;
  exceptionCount: number;
  pendingCorrectionCount: number;
  totalHoursDisplay: string;
  state: TimeReadinessState;
  stateLabel: string;
  approvedAt: string | null;
  approvedByDisplayName: string | null;
  reviewHref: string;
}

// Payroll Admin Slice 3B — data-driven workflow tracker.
export type PayrollOverviewWorkflowState = "done" | "current" | "pending";
export interface PayrollOverviewWorkflowStep {
  n: number;
  label: string;
  sub: string;
  state: PayrollOverviewWorkflowState;
}

// Payroll Admin Slice 3B — data-driven pre-calculation checklist.
export interface PayrollOverviewChecklistItem {
  id: string;
  label: string;
  done: boolean;
  detail: string | null;
  /** True for items that legitimately belong to a later slice — the
   *  UI renders them in a neutral not-yet-owned state. */
  future: boolean;
}

export type PayrollOverviewTab =
  | "employees"
  | "exceptions"
  | "approvals"
  | "adjustments"
  | "summary";

export interface PayrollOverviewViewModel {
  // context
  payGroup: PayrollOverviewPayGroupRef | null;
  payPeriod: PayrollOverviewPayPeriodRef | null;
  availablePayPeriods: PayrollOverviewPayPeriodRef[];
  batch: PayrollOverviewBatchRef | null;
  hasBatch: boolean;

  // KPIs
  kpi: {
    employeesInRun: number | null;
    hourlyCount: number | null;
    salaryCount: number | null;
    totalHoursDisplay: string;
    grossPayDisplay: string;
    grossPaySemantics: "PRE_PREPARE" | "PREPARED_ESTIMATE" | "CALCULATED" | "POSTED";
    adjustmentsCount: number | null;
    exceptionsCount: number | null;
    exceptionsBlockerCount: number | null;
    exceptionsWarningCount: number | null;
    exceptionsInfoCount: number | null;
    approvalsCompleteCount: number | null;
    approvalsRequiredCount: number | null;
    // 3B acceptance hotfix (2026-09-12) — time-readiness rollup so
    // the Overview can honestly reflect Manager-approval + Freeze
    // progression without misleading "no departments" language when
    // reviewable timesheet entries exist.
    timesheetEntryCount: number | null;
    approvedTimeEntryCount: number | null;
    openSessionCount: number | null;
    nullAssignmentEntryCount: number | null;
    clockEventCount: number | null;
  };

  // employee table population — after filters + search + pagination
  employeeTable: {
    rows: PayrollOverviewEmployeeRow[];
    filteredTotal: number;
    unfilteredTotal: number;
    page: number;
    pageSize: number;
  };

  // Slice 3B — real data feeds for the workflow tracker, checklist,
  // Exceptions tab, and Approvals tab.
  workflow: PayrollOverviewWorkflowStep[];
  checklist: PayrollOverviewChecklistItem[];
  exceptions: PayrollOverviewExceptionRow[];
  approvals: PayrollOverviewApprovalRow[];
  activeTab: PayrollOverviewTab;

  // filter/search UI populators
  availableDepartments: Array<{ id: string; name: string }>;
  availableEmploymentTypes: Array<"Hourly" | "Salary">;
  availableStatuses: string[];
  activeFilter: PayrollOverviewFilterState;
}

const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type PayrollOverviewPageSize = (typeof PAGE_SIZE_OPTIONS)[number];

function normalizePageSize(raw: number | null | undefined): PayrollOverviewPageSize {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (n === 25) return 25;
  if (n === 50) return 50;
  return 10;
}

// Actionable (non-terminal) batch statuses — the resume algorithm
// selects the period of the most recent actionable batch so the
// Payroll Admin lands where their work-in-progress is. POSTED and
// VOIDED are TERMINAL and never resume; if only terminal batches
// exist, the algorithm falls through to the current-period path.
const ACTIONABLE_BATCH_STATUSES = [
  "DRAFT",
  "PREPARED",
  "CALCULATED",
  "SUBMITTED_FOR_APPROVAL",
  "APPROVED",
] as const;

/** UTC-midnight of the given moment — the payroll domain treats
 *  today as a calendar day, not an instant. */
function todayCalendarUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/* ============================================================
   Frequency labels — display-only mapping over PayGroup enum.
   ============================================================ */
function frequencyLabel(payFrequency: string): string {
  switch (payFrequency) {
    case "WEEKLY":       return "Weekly";
    case "BIWEEKLY":     return "Bi-Weekly";
    case "BI_WEEKLY":    return "Bi-Weekly";
    case "SEMI_MONTHLY": return "Semi-Monthly";
    case "MONTHLY":      return "Monthly";
    default:             return payFrequency.replace(/_/g, " ").toLowerCase();
  }
}

/* ============================================================
   PayrollBatchEmployee.status → display label.
   Domain values are PENDING | INCLUDED | EXCLUDED | ERRORED; the
   Payroll Admin needs friendlier labels but we DO NOT invent any
   new statuses (per §12: "Do not introduce new domain states").
   ============================================================ */
export function batchEmployeeStatusToDisplay(raw: string, batchStatus: string): string {
  if (raw === "ERRORED") return "Exception";
  if (raw === "EXCLUDED") return "Excluded";
  // Pre-CALCULATED: PENDING / INCLUDED both read as "Ready" (row is
  // in the run and has no error). Post-CALCULATED: same. There is no
  // "Pending Approval" domain state in Slice 3A — it would be a 3B/3E
  // concept — so we do not surface that label here.
  return "Ready";
}
function isoDate(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "";
}
// Payroll 3A date-boundary hotfix (2026-09-11) — timezone-agnostic
// calendar-date formatting. See PayrollAdminOverview.tsx fmtCalendarDate
// for the client-side twin. Both must agree exactly for header /
// selector / Pay Period card to display the same calendar date.
const MONTH_SHORT_SRV = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtShortMonthDay(iso: string): string {
  const raw = iso.slice(0, 10);
  const [y, m, d] = raw.split("-").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  return `${MONTH_SHORT_SRV[m - 1]} ${d}`;
}
function fmtShortMonthDayYear(iso: string): string {
  const raw = iso.slice(0, 10);
  const [y, m, d] = raw.split("-").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  return `${MONTH_SHORT_SRV[m - 1]} ${d}, ${y}`;
}
function fmtPeriodLabel(startISO: string, endISO: string): string {
  return `${fmtShortMonthDayYear(startISO)} – ${fmtShortMonthDayYear(endISO)}`;
}
function fmtHoursDecimal(n: number): string {
  return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ============================================================
   Main entry point
   ============================================================ */

export interface BuildPayrollOverviewInput {
  principal: Principal;
  clubId: string;
  payGroupId?: string | null;
  payPeriodId?: string | null;
  q?: string | null;
  department?: string | null;
  employmentType?: "Hourly" | "Salary" | null;
  status?: string | null;
  page?: number | null;
  pageSize?: number | null;
  tab?: string | null;
}

function normalizeTab(raw: string | null | undefined): PayrollOverviewTab {
  if (raw === "exceptions" || raw === "approvals" || raw === "adjustments" || raw === "summary") return raw;
  return "employees";
}

function approvalStateLabel(state: DepartmentApprovalState): string {
  switch (state) {
    case "PENDING":  return "Pending";
    case "APPROVED": return "Approved";
    case "REOPENED": return "Reopened — review required";
    default:         return state;
  }
}

function baseWorkflow(): PayrollOverviewWorkflowStep[] {
  // Payroll Admin Slice 3B: only steps 1-3 have real state. Steps
  // 4-8 remain "pending" until their slice owns them.
  return [
    { n: 1, label: "Prepare",         sub: "",              state: "current" },
    { n: 2, label: "Review",          sub: "Exceptions",    state: "pending" },
    { n: 3, label: "Approvals",       sub: "(Dept. Heads)", state: "pending" },
    { n: 4, label: "Calculate",       sub: "Payroll",       state: "pending" },
    { n: 5, label: "Review & Adjust", sub: "",              state: "pending" },
    { n: 6, label: "Submit",          sub: "for Approval",  state: "pending" },
    { n: 7, label: "Approved",        sub: "(Controller)",  state: "pending" },
    { n: 8, label: "Posted",          sub: "Complete",      state: "pending" },
  ];
}

function baseChecklist(): PayrollOverviewChecklistItem[] {
  return [
    { id: "time-imported",         label: "All time entries imported",     done: false, detail: null, future: false },
    { id: "department-approvals",  label: "Department head approvals",     done: false, detail: null, future: false },
    { id: "resolve-exceptions",    label: "Resolve payroll exceptions",    done: false, detail: null, future: false },
    { id: "one-time-adjustments",  label: "Review one-time adjustments",   done: false, detail: null, future: true },
    { id: "recurring-components",  label: "Review recurring components",   done: false, detail: null, future: true },
    { id: "verify-employee-data",  label: "Verify employee data",          done: false, detail: null, future: true },
  ];
}

export async function buildPayrollOverview(input: BuildPayrollOverviewInput): Promise<PayrollOverviewViewModel> {
  const { principal, clubId } = input;
  requirePermission(principal, clubId, "payroll:read");

  const now = new Date();
  const filter: PayrollOverviewFilterState = {
    q: (input.q ?? "").trim(),
    department: input.department?.trim() || null,
    employmentType: input.employmentType ?? null,
    status: input.status?.trim() || null,
  };
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize: PayrollOverviewPageSize = normalizePageSize(input.pageSize ?? null);
  const activeTab: PayrollOverviewTab = normalizeTab(input.tab ?? null);

  // Resolve default pay group.
  const payGroups = await listPayGroups(principal, clubId);
  const activePayGroups = payGroups.filter((g) => g.active);
  const chosenPayGroup =
    (input.payGroupId && payGroups.find((g) => g.id === input.payGroupId)) ||
    (activePayGroups[0] ?? payGroups[0] ?? null);

  if (!chosenPayGroup) {
    return emptyOverview(filter, page, pageSize);
  }

  // Load pay periods for chosen pay group across this + last tax year.
  // 3A hotfix (2026-09-11) — the "up to one period beyond current"
  // horizon and the reverse-chronological sort are applied AFTER the
  // canonical asc-sorted set is loaded, so the resume algorithm below
  // can still see historical periods when picking a landing spot.
  const currentYear = now.getUTCFullYear();
  const [thisYear, lastYear] = await Promise.all([
    listPayPeriods(principal, clubId, { payGroupId: chosenPayGroup.id, taxYear: currentYear }),
    listPayPeriods(principal, clubId, { payGroupId: chosenPayGroup.id, taxYear: currentYear - 1 }),
  ]);
  const allPeriodsAsc = [...lastYear, ...thisYear];

  // Identify today's calendar-day position within the period set.
  //   currentIdx = last period whose periodStart <= today (may equal
  //   the period we're inside, or the most-recently-ended period if
  //   today lands on a generation gap).
  //   nextIdx    = first period whose periodStart > today.
  const today = todayCalendarUTC(now);
  let currentIdx = -1;
  for (let i = 0; i < allPeriodsAsc.length; i++) {
    if (new Date(allPeriodsAsc[i]!.periodStart).getTime() <= today.getTime()) currentIdx = i;
    else break;
  }
  const nextIdx = Math.min(currentIdx + 1, allPeriodsAsc.length - 1);

  // Horizon rule (§5): dropdown includes all periods with index <=
  // nextIdx — i.e. every historical period + current + exactly one
  // upcoming. If an explicit payPeriodId sits outside that window,
  // it's added so the selector can still display the requested
  // period (§4 — explicit URL always wins).
  const horizonIndices = new Set<number>();
  for (let i = 0; i <= nextIdx && i < allPeriodsAsc.length; i++) horizonIndices.add(i);

  // Default period selection — resume algorithm (§3, §4).
  let chosenId: string | null = null;

  //   Priority 1 (§4): explicit URL wins.
  if (input.payPeriodId) {
    const found = allPeriodsAsc.find((p) => p.id === input.payPeriodId);
    if (found) chosenId = found.id;
  }

  //   Priority 2 (§3.1): most recent actionable batch for this pay
  //   group. "Actionable" = non-terminal (POSTED / VOIDED excluded).
  //   Ordered by preparedAt desc, then createdAt desc, so the most
  //   recently-touched work-in-progress wins.
  if (!chosenId) {
    const actionable = await prisma.payrollBatch.findFirst({
      where: {
        clubId,
        payGroupId: chosenPayGroup.id,
        status: { in: [...ACTIONABLE_BATCH_STATUSES] },
      },
      orderBy: [{ preparedAt: "desc" }, { createdAt: "desc" }],
      select: { payPeriodId: true },
    });
    if (actionable) chosenId = actionable.payPeriodId;
  }

  //   Priority 3 (§3.2): current pay period — today falls inside
  //   [periodStart, periodEnd).
  if (!chosenId && currentIdx >= 0) {
    const cur = allPeriodsAsc[currentIdx]!;
    const curEnd = new Date(cur.periodEnd).getTime();
    if (curEnd > today.getTime()) chosenId = cur.id;
  }

  //   Priority 4 (§3.3): next allowable pay period.
  if (!chosenId && nextIdx < allPeriodsAsc.length) {
    const nxt = allPeriodsAsc[nextIdx]!;
    if (new Date(nxt.periodStart).getTime() > today.getTime()) chosenId = nxt.id;
  }

  //   Priority 5 (§3.4): most recently completed period as a
  //   sensible fallback — largest periodEnd <= today.
  if (!chosenId && allPeriodsAsc.length > 0) {
    const lastCompleted = [...allPeriodsAsc]
      .filter((p) => new Date(p.periodEnd).getTime() <= today.getTime())
      .sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime())[0];
    if (lastCompleted) chosenId = lastCompleted.id;
  }

  // If the chosen period sits outside the horizon (e.g. explicit
  // URL for a POSTED historical period, or an actionable batch on
  // a period farther back than the default horizon), include it in
  // the visible list so the selector can display it.
  const chosenIdx = chosenId ? allPeriodsAsc.findIndex((p) => p.id === chosenId) : -1;
  if (chosenIdx >= 0) horizonIndices.add(chosenIdx);

  const horizonPeriodsAsc = allPeriodsAsc.filter((_, i) => horizonIndices.has(i));

  // Fetch existing (non-VOIDED) batches for the horizon periods —
  // used to append " · DRAFT" / " · PREPARED" / … / " · No batch"
  // to each option label. Keep the highest-sequence per period.
  const horizonPeriodIds = horizonPeriodsAsc.map((p) => p.id);
  const batchByPeriodId = new Map<string, { status: string; sequence: number }>();
  if (horizonPeriodIds.length > 0) {
    const batchRows = await prisma.payrollBatch.findMany({
      where: {
        clubId,
        payGroupId: chosenPayGroup.id,
        payPeriodId: { in: horizonPeriodIds },
        status: { not: "VOIDED" },
      },
      orderBy: [{ payPeriodId: "asc" }, { sequence: "desc" }],
      select: { payPeriodId: true, status: true, sequence: true },
    });
    for (const r of batchRows) {
      const existing = batchByPeriodId.get(r.payPeriodId);
      if (!existing || r.sequence > existing.sequence) {
        batchByPeriodId.set(r.payPeriodId, { status: r.status, sequence: r.sequence });
      }
    }
  }

  // Reverse-chronological sort for display (§6). Newest first.
  const horizonPeriodsDesc = [...horizonPeriodsAsc].sort(
    (a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime(),
  );
  const availablePayPeriods: PayrollOverviewPayPeriodRef[] = horizonPeriodsDesc.map((p) => {
    const startISO = isoDate(new Date(p.periodStart));
    const endISO = isoDate(new Date(p.periodEnd));
    const payISO = isoDate(new Date(p.payDate));
    const b = batchByPeriodId.get(p.id);
    const statusSuffix = b ? ` · ${b.status}` : " · No batch";
    return {
      id: p.id,
      label: `${fmtPeriodLabel(startISO, endISO)} · Pay ${fmtShortMonthDay(payISO)}${statusSuffix}`,
      periodStartISO: startISO,
      periodEndISO: endISO,
      payDateISO: payISO,
    };
  });

  const chosenPeriod: PayrollOverviewPayPeriodRef | null =
    chosenId ? (availablePayPeriods.find((p) => p.id === chosenId) ?? null) : null;

  const payGroupRef: PayrollOverviewPayGroupRef = {
    id: chosenPayGroup.id,
    name: chosenPayGroup.name,
    frequencyLabel: frequencyLabel((chosenPayGroup as { payFrequency?: string }).payFrequency ?? ""),
  };

  if (!chosenPeriod) {
    return {
      payGroup: payGroupRef,
      payPeriod: null,
      availablePayPeriods,
      batch: null,
      hasBatch: false,
      kpi: emptyKpi(),
      employeeTable: emptyEmployeeTable(page, pageSize),
      workflow: baseWorkflow(),
      checklist: baseChecklist(),
      exceptions: [],
      approvals: [],
      activeTab,
      availableDepartments: [],
      availableEmploymentTypes: [],
      availableStatuses: [],
      activeFilter: filter,
    };
  }

  // 3B acceptance hotfix (2026-09-12) — resolve time-readiness for
  // the chosen period BEFORE the active-batch check. Reviewable
  // department time exists independently of whether Prepare has
  // been clicked yet — a manager may need to approve time before
  // the Payroll Admin has even created the batch. Surfacing this
  // scope on the Approvals tab is exactly the founder's §11 rule.
  const activeBatch = await findActiveBatchForPeriod(principal, clubId, chosenPeriod.id);
  const preBatchReadiness = activeBatch ? null : await getTimeReadiness(principal, clubId, chosenPeriod.id);

  if (!activeBatch) {
    const r = preBatchReadiness!;
    const approvalsPreBatch: PayrollOverviewApprovalRow[] = r.scopes.map((s) => ({
      departmentId: s.departmentId,
      departmentCode: s.departmentCode,
      departmentName: s.departmentName,
      employeeCount: s.employeeCount,
      entryCount: s.entryCount,
      frozenEntryCount: s.frozenEntryCount,
      exceptionCount: s.exceptionCount,
      pendingCorrectionCount: s.pendingCorrectionCount,
      totalHoursDisplay: s.recordedHoursDisplay,
      state: s.state,
      stateLabel: s.stateLabel,
      approvedAt: s.approvedAt?.toISOString() ?? null,
      approvedByDisplayName: null,
      reviewHref: s.reviewHref,
    }));
    // No-batch checklist: item 1 still reconciles source-time even
    // when no batch has been prepared yet.
    const noBatchChecklist = baseChecklist();
    noBatchChecklist[0] = {
      ...noBatchChecklist[0]!,
      done: r.allImported,
      detail: r.timesheetEntryCount === 0 && r.clockEventCount === 0
        ? "No time to import"
        : r.needsAttentionTimesheetCount > 0
          ? `${r.needsAttentionTimesheetCount} timesheet${r.needsAttentionTimesheetCount === 1 ? "" : "s"} needs attention`
          : `${r.timesheetEntryCount} imported`,
    };
    noBatchChecklist[1] = {
      ...noBatchChecklist[1]!,
      done: r.allApproved && r.scopeCount > 0,
      detail: r.scopeCount === 0
        ? "No departments to approve"
        : `${r.frozenScopeCount}/${r.scopeCount} frozen · ${r.pendingScopeCount} pending${r.reopenedScopeCount > 0 ? ` · ${r.reopenedScopeCount} reopened` : ""}`,
    };
    return {
      payGroup: payGroupRef,
      payPeriod: chosenPeriod,
      availablePayPeriods,
      batch: null,
      hasBatch: false,
      kpi: {
        ...emptyKpi(),
        timesheetEntryCount: r.timesheetEntryCount,
        approvedTimeEntryCount: r.approvedTimeEntryCount,
        openSessionCount: r.needsAttentionTimesheetCount,
        nullAssignmentEntryCount: r.nullAssignmentEntryCount,
        clockEventCount: r.clockEventCount,
        approvalsCompleteCount: r.frozenScopeCount,
        approvalsRequiredCount: r.scopeCount,
      },
      employeeTable: emptyEmployeeTable(page, pageSize),
      workflow: baseWorkflow(),
      checklist: noBatchChecklist,
      exceptions: [],
      approvals: approvalsPreBatch,
      activeTab,
      availableDepartments: [],
      availableEmploymentTypes: [],
      availableStatuses: [],
      activeFilter: filter,
    };
  }

  // ---- Load batch employees + relations we need for the table ----
  //
  // 3B acceptance hotfix (2026-09-12): the Approvals tab data source
  // is now the unified per-department `getTimeReadiness` projection
  // — it reads BOTH the manager-review lens (PayrollTimesheetEntry
  // via listReviewableScopes) AND the payroll-frozen lens
  // (PayrollApprovedTimeEntry via getDepartmentApprovalStatus) so a
  // department appears in the tab the moment any reviewable time
  // exists, not only after Payroll Admin has clicked Freeze.
  const [
    batchRow,
    batchEmployees,
    batchEarnings,
    batchExceptionRows,
    batchAdjustments,
    readiness,
  ] = await Promise.all([
    prisma.payrollBatch.findFirst({
      where: { id: activeBatch.id, clubId },
      select: {
        id: true, status: true, sequence: true,
        preparedAt: true, calculatedAt: true, submittedAt: true, approvedAt: true, postedAt: true,
      },
    }),
    prisma.payrollBatchEmployee.findMany({
      where: { batchId: activeBatch.id, clubId },
      include: {
        employee: { select: { firstName: true, lastName: true, preferredName: true } },
      },
    }),
    prisma.payrollBatchEarning.findMany({
      where: { batchId: activeBatch.id, clubId },
      select: { batchEmployeeId: true, earningType: true, quantity: true, rate: true },
    }),
    prisma.payrollBatchException.findMany({
      where: { batchId: activeBatch.id, clubId, resolvedAt: null },
      orderBy: [{ severity: "asc" }, { code: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, severity: true, code: true, message: true,
        recommendedAction: true, employeeId: true, batchEmployeeId: true,
      },
    }),
    prisma.payrollBatchComponentSnapshot.count({
      where: { batch: { id: activeBatch.id, clubId }, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    }),
    getTimeReadiness(principal, clubId, chosenPeriod.id),
  ]);

  const batchRef: PayrollOverviewBatchRef | null = batchRow ? {
    id: batchRow.id,
    status: batchRow.status,
    sequence: batchRow.sequence,
    preparedAt: batchRow.preparedAt?.toISOString() ?? null,
    calculatedAt: batchRow.calculatedAt?.toISOString() ?? null,
    submittedAt: batchRow.submittedAt?.toISOString() ?? null,
    approvedAt: batchRow.approvedAt?.toISOString() ?? null,
    postedAt: batchRow.postedAt?.toISOString() ?? null,
  } : null;

  // ---- Enrich employees with department (from sourceFactsJson primary assignment) ----
  const allDepartmentIds = new Set<string>();
  const primaryDepartmentByBatchEmployeeId = new Map<string, string | null>();

  for (const be of batchEmployees) {
    try {
      const facts = parseSourceFactsV1(be.sourceFactsJson);
      const primary = facts?.assignments.find((a) => a.role === "PRIMARY") ?? facts?.assignments[0] ?? null;
      const deptId = primary?.departmentId ?? null;
      primaryDepartmentByBatchEmployeeId.set(be.id, deptId);
      if (deptId) allDepartmentIds.add(deptId);
    } catch {
      primaryDepartmentByBatchEmployeeId.set(be.id, null);
    }
  }

  const departmentNameById = new Map<string, string>();
  if (allDepartmentIds.size > 0) {
    const departments = await prisma.department.findMany({
      where: { id: { in: Array.from(allDepartmentIds) }, clubId },
      select: { id: true, name: true },
    });
    for (const d of departments) departmentNameById.set(d.id, d.name);
  }

  // ---- Aggregate earnings by batchEmployeeId ----
  const regHrsByBe = new Map<string, number>();
  const otHrsByBe = new Map<string, number>();
  const grossPreCalcCentsByBe = new Map<string, number>();
  for (const e of batchEarnings) {
    const q = Number(e.quantity);
    const r = Number(e.rate);
    if (e.earningType === "REGULAR") regHrsByBe.set(e.batchEmployeeId, (regHrsByBe.get(e.batchEmployeeId) ?? 0) + q);
    else if (e.earningType === "OVERTIME") otHrsByBe.set(e.batchEmployeeId, (otHrsByBe.get(e.batchEmployeeId) ?? 0) + q);
    // "Prepared gross" estimate — sum quantity × rate across ALL earnings on the batch employee.
    const contribCents = Math.round(q * r * 100);
    grossPreCalcCentsByBe.set(e.batchEmployeeId, (grossPreCalcCentsByBe.get(e.batchEmployeeId) ?? 0) + contribCents);
  }

  // ---- KPI totals ----
  const employeesInRun = batchEmployees.filter((be) => be.status !== "EXCLUDED").length;
  const hourlyCount = batchEmployees.filter((be) => !be.salaried && be.status !== "EXCLUDED").length;
  const salaryCount = batchEmployees.filter((be) => be.salaried && be.status !== "EXCLUDED").length;

  const totalHoursSum = batchEmployees.reduce((sum, be) => sum + Number(be.approvedHoursSnapshot ?? 0), 0);
  const totalHoursDisplay = batchEmployees.some((be) => be.approvedHoursSnapshot !== null)
    ? fmtHoursDecimal(totalHoursSum)
    : "—";

  // Gross Pay semantics — see §L in the checkpoint. We prefer:
  //   1. Post-CALCULATED: PayrollBatchEmployee.grossPay (persisted result).
  //   2. PREPARED: sum(quantity × rate) from PayrollBatchEarning ("prepared gross" estimate).
  //   3. DRAFT / pre-PREPARE: "—".
  const isCalculated = activeBatch.status === "CALCULATED" ||
    activeBatch.status === "SUBMITTED_FOR_APPROVAL" ||
    activeBatch.status === "APPROVED" ||
    activeBatch.status === "POSTED";
  const isPrepared = isCalculated || activeBatch.status === "PREPARED";

  let grossPayDisplay = "—";
  let grossPaySemantics: PayrollOverviewViewModel["kpi"]["grossPaySemantics"] = "PRE_PREPARE";
  if (isCalculated) {
    const calcCents = batchEmployees.reduce((sum, be) => sum + Math.round(Number(be.grossPay ?? 0) * 100), 0);
    grossPayDisplay = calcCents > 0 ? fmtMoney(calcCents) : "—";
    grossPaySemantics = activeBatch.status === "POSTED" ? "POSTED" : "CALCULATED";
  } else if (isPrepared) {
    const preparedCents = Array.from(grossPreCalcCentsByBe.values()).reduce((a, b) => a + b, 0);
    grossPayDisplay = preparedCents > 0 ? fmtMoney(preparedCents) : "—";
    grossPaySemantics = "PREPARED_ESTIMATE";
  }

  // ---- Employee table rows (before filters) ----
  const allRows: PayrollOverviewEmployeeRow[] = batchEmployees.map((be) => {
    const empName = (be.employee?.preferredName || `${be.employee?.firstName ?? ""} ${be.employee?.lastName ?? ""}`).trim() || "(unnamed)";
    const deptId = primaryDepartmentByBatchEmployeeId.get(be.id) ?? null;
    const deptName = deptId ? (departmentNameById.get(deptId) ?? "—") : "—";
    const regHrs = regHrsByBe.get(be.id) ?? 0;
    const otHrs = otHrsByBe.get(be.id) ?? 0;
    const totalHrs = Number(be.approvedHoursSnapshot ?? (regHrs + otHrs));
    const rowGrossCents = isCalculated
      ? Math.round(Number(be.grossPay ?? 0) * 100)
      : (grossPreCalcCentsByBe.get(be.id) ?? 0);
    return {
      batchEmployeeId: be.id,
      employeeId: be.employeeId,
      displayName: empName,
      department: deptName,
      regularHrs: be.salaried && regHrs === 0 ? "—" : fmtHoursDecimal(regHrs),
      otHrs: be.salaried && otHrs === 0 ? "—" : fmtHoursDecimal(otHrs),
      totalHrs: totalHrs > 0 ? fmtHoursDecimal(totalHrs) : (be.salaried ? "—" : "0.00"),
      grossPay: rowGrossCents > 0 ? fmtMoney(rowGrossCents) : "—",
      status: batchEmployeeStatusToDisplay(be.status, activeBatch.status),
      salaried: be.salaried,
      viewHref: `/app/admin/payroll/batches/${activeBatch.id}?employeeId=${be.employeeId}`,
    };
  });

  // ---- Available filter values from the loaded population ----
  const availableDepartments = Array.from(departmentNameById.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const availableEmploymentTypes: Array<"Hourly" | "Salary"> = [];
  if (allRows.some((r) => !r.salaried)) availableEmploymentTypes.push("Hourly");
  if (allRows.some((r) => r.salaried))  availableEmploymentTypes.push("Salary");
  const availableStatuses = Array.from(new Set(allRows.map((r) => r.status))).sort();

  // ---- Apply filters ----
  const q = filter.q.toLowerCase();
  const filtered = allRows.filter((r) => {
    if (q && !r.displayName.toLowerCase().includes(q)) return false;
    if (filter.department) {
      const dept = availableDepartments.find((d) => d.id === filter.department);
      if (!dept || r.department !== dept.name) return false;
    }
    if (filter.employmentType === "Hourly" && r.salaried) return false;
    if (filter.employmentType === "Salary" && !r.salaried) return false;
    if (filter.status && r.status !== filter.status) return false;
    return true;
  });

  // ---- Pagination ----
  const filteredTotal = filtered.length;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pagedRows = filtered.slice(start, start + pageSize);

  // ---- Slice 3B: exception rollup ----
  const employeeNameById = new Map<string, string>();
  for (const be of batchEmployees) {
    if (!be.employee) continue;
    employeeNameById.set(
      be.employeeId,
      (be.employee.preferredName || `${be.employee.firstName ?? ""} ${be.employee.lastName ?? ""}`).trim() || "(unnamed)",
    );
  }
  const exceptions: PayrollOverviewExceptionRow[] = batchExceptionRows.map((x) => {
    const t = translateException(x.code);
    const href = t.remediation.hrefFor({ employeeId: x.employeeId, payPeriodId: chosenPeriod.id });
    return {
      id: x.id,
      severity: x.severity as ExceptionSeverity,
      code: x.code,
      label: t.label,
      message: x.message,
      employeeId: x.employeeId,
      employeeDisplayName: x.employeeId ? (employeeNameById.get(x.employeeId) ?? null) : null,
      recommendedAction: x.recommendedAction,
      remediation: {
        kind: t.remediation.kind,
        label: t.remediation.label,
        href,
      },
    };
  });
  const blockerCount = exceptions.filter((e) => e.severity === "BLOCKER").length;
  const warningCount = exceptions.filter((e) => e.severity === "WARNING").length;
  const infoCount    = exceptions.filter((e) => e.severity === "INFO").length;

  // ---- Slice 3B (acceptance-hotfix rev): approvals rollup ----
  //
  // Rows now come from `getTimeReadiness` so the tab reflects the
  // FULL manager-review + freeze lifecycle, not just frozen scopes.
  // States:
  //   PENDING             — reviewable time exists, manager not yet approved
  //   NEEDS_ATTENTION     — open sessions / null-assignment entries
  //   APPROVED_UNFROZEN   — manager approved, Payroll Admin has not clicked Freeze
  //   FROZEN              — manager approved + frozen into PayrollApprovedTimeEntry
  //   REOPENED            — approval reopened after a source-time correction
  const approvals: PayrollOverviewApprovalRow[] = readiness.scopes.map((s) => ({
    departmentId: s.departmentId,
    departmentCode: s.departmentCode,
    departmentName: s.departmentName,
    employeeCount: s.employeeCount,
    entryCount: s.entryCount,
    frozenEntryCount: s.frozenEntryCount,
    exceptionCount: s.exceptionCount,
    pendingCorrectionCount: s.pendingCorrectionCount,
    totalHoursDisplay: s.recordedHoursDisplay,
    state: s.state,
    stateLabel: s.stateLabel,
    approvedAt: s.approvedAt?.toISOString() ?? null,
    approvedByDisplayName: null,
    reviewHref: s.reviewHref,
  }));
  const approvalsCompleteCount = readiness.frozenScopeCount;
  const approvalsRequiredCount = readiness.scopeCount;

  // ---- Slice 3B (acceptance-hotfix rev): workflow tracker ----
  //
  // Step 3 now honours the full reconciliation: it is `done` ONLY
  // when every reviewable department has been Manager-approved AND
  // frozen (readiness.allApproved), AND no unmaterialised source
  // time remains (readiness.allImported). This prevents the prior
  // false-positive where Step 3 auto-completed just because
  // getDepartmentApprovalStatus returned empty on an unfrozen
  // period.
  const workflow = baseWorkflow();
  workflow[0] = { ...workflow[0]!, state: "done" };
  workflow[1] = { ...workflow[1]!, state: blockerCount === 0 ? "done" : "current" };
  const approvalsDone = readiness.allApproved && readiness.allImported;
  workflow[2] = { ...workflow[2]!, state: approvalsDone ? "done" : "current" };

  // ---- Slice 3B (acceptance-hotfix rev): checklist ----
  //
  // Item 1 is now a reconciliation rule against the time-readiness
  // rollup. "All time entries imported" = every eligible completed
  // source-time record has entered the reviewable payroll-time
  // pipeline (PayrollTimesheetEntry), with no open sessions and no
  // null-assignment entries lingering. Simply having a single
  // PayrollApprovedTimeEntry is NOT enough — it never was.
  const checklist = baseChecklist();
  const detailForItem1 = (() => {
    if (readiness.needsAttentionTimesheetCount > 0) {
      return `${readiness.needsAttentionTimesheetCount} timesheet${readiness.needsAttentionTimesheetCount === 1 ? "" : "s"} needs attention`;
    }
    if (readiness.nullAssignmentEntryCount > 0) {
      return `${readiness.nullAssignmentEntryCount} entr${readiness.nullAssignmentEntryCount === 1 ? "y" : "ies"} missing department`;
    }
    if (readiness.timesheetEntryCount === 0 && readiness.clockEventCount === 0) {
      return "No time to import";
    }
    if (readiness.timesheetEntryCount === 0 && readiness.clockEventCount > 0) {
      return `${readiness.clockEventCount} clock event${readiness.clockEventCount === 1 ? "" : "s"} awaiting materialization`;
    }
    return `${readiness.timesheetEntryCount} imported · ${readiness.approvedTimeEntryCount} frozen`;
  })();
  checklist[0] = {
    ...checklist[0]!,
    done: readiness.allImported,
    detail: detailForItem1,
  };
  //   Item 2 — Department head approvals. X/Y frozen (frozen is the
  //   payroll-usable state; approved-unfrozen still requires a
  //   Payroll Admin freeze click before Calculate can consume it).
  checklist[1] = {
    ...checklist[1]!,
    done: approvalsDone,
    detail: readiness.scopeCount === 0
      ? "No departments to approve"
      : `${readiness.frozenScopeCount}/${readiness.scopeCount} frozen · ${readiness.pendingScopeCount} pending${readiness.reopenedScopeCount > 0 ? ` · ${readiness.reopenedScopeCount} reopened` : ""}`,
  };
  //   Item 3 — Resolve payroll exceptions (BLOCKERS only per §28).
  checklist[2] = {
    ...checklist[2]!,
    done: blockerCount === 0,
    detail: blockerCount === 0
      ? (warningCount === 0 ? "No unresolved issues" : `${warningCount} warning${warningCount === 1 ? "" : "s"} remain`)
      : `${blockerCount} blocker${blockerCount === 1 ? "" : "s"} unresolved`,
  };

  return {
    payGroup: payGroupRef,
    payPeriod: chosenPeriod,
    availablePayPeriods,
    batch: batchRef,
    hasBatch: true,
    kpi: {
      employeesInRun,
      hourlyCount,
      salaryCount,
      totalHoursDisplay,
      grossPayDisplay,
      grossPaySemantics,
      adjustmentsCount: batchAdjustments,
      exceptionsCount: exceptions.length,
      exceptionsBlockerCount: blockerCount,
      exceptionsWarningCount: warningCount,
      exceptionsInfoCount: infoCount,
      approvalsCompleteCount,
      approvalsRequiredCount,
      timesheetEntryCount: readiness.timesheetEntryCount,
      approvedTimeEntryCount: readiness.approvedTimeEntryCount,
      openSessionCount: readiness.needsAttentionTimesheetCount,
      nullAssignmentEntryCount: readiness.nullAssignmentEntryCount,
      clockEventCount: readiness.clockEventCount,
    },
    employeeTable: {
      rows: pagedRows,
      filteredTotal,
      unfilteredTotal: allRows.length,
      page: safePage,
      pageSize,
    },
    workflow,
    checklist,
    exceptions,
    approvals,
    activeTab,
    availableDepartments,
    availableEmploymentTypes,
    availableStatuses,
    activeFilter: filter,
  };
}

function emptyKpi(): PayrollOverviewViewModel["kpi"] {
  return {
    employeesInRun: null, hourlyCount: null, salaryCount: null,
    totalHoursDisplay: "—", grossPayDisplay: "—",
    grossPaySemantics: "PRE_PREPARE",
    adjustmentsCount: null, exceptionsCount: null,
    exceptionsBlockerCount: null, exceptionsWarningCount: null, exceptionsInfoCount: null,
    approvalsCompleteCount: null, approvalsRequiredCount: null,
    timesheetEntryCount: null, approvedTimeEntryCount: null,
    openSessionCount: null, nullAssignmentEntryCount: null, clockEventCount: null,
  };
}
function emptyEmployeeTable(page: number, pageSize: PayrollOverviewPageSize = DEFAULT_PAGE_SIZE as PayrollOverviewPageSize): PayrollOverviewViewModel["employeeTable"] {
  return { rows: [], filteredTotal: 0, unfilteredTotal: 0, page, pageSize };
}
function emptyOverview(filter: PayrollOverviewFilterState, page: number, pageSize: PayrollOverviewPageSize = DEFAULT_PAGE_SIZE as PayrollOverviewPageSize): PayrollOverviewViewModel {
  return {
    payGroup: null, payPeriod: null, availablePayPeriods: [],
    batch: null, hasBatch: false,
    kpi: emptyKpi(), employeeTable: emptyEmployeeTable(page, pageSize),
    workflow: baseWorkflow(),
    checklist: baseChecklist(),
    exceptions: [], approvals: [],
    activeTab: "employees",
    availableDepartments: [], availableEmploymentTypes: [], availableStatuses: [],
    activeFilter: filter,
  };
}

/** Small helper the Overview page uses to format the pay-date line.
 *  Timezone-agnostic (calendar-date semantics per §3 hotfix). */
export function payDateLongLabel(payPeriod: PayrollOverviewPayPeriodRef): string {
  return fmtLongCalendarDate(payPeriod.payDateISO);
}
export function periodLongLabel(payPeriod: PayrollOverviewPayPeriodRef): string {
  return `${fmtLongCalendarDate(payPeriod.periodStartISO)} – ${fmtLongCalendarDate(payPeriod.periodEndISO)}`;
}
const WEEKDAY_SHORT_SRV = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function fmtLongCalendarDate(iso: string): string {
  const raw = iso.slice(0, 10);
  const [y, m, d] = raw.split("-").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = WEEKDAY_SHORT_SRV[dt.getUTCDay()];
  return `${weekday}, ${MONTH_SHORT_SRV[m - 1]} ${d}, ${y}`;
}
