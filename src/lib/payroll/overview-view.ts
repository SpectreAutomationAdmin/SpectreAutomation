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
  };

  // employee table population — after filters + search + pagination
  employeeTable: {
    rows: PayrollOverviewEmployeeRow[];
    filteredTotal: number;
    unfilteredTotal: number;
    page: number;
    pageSize: number;
  };

  // filter/search UI populators
  availableDepartments: Array<{ id: string; name: string }>;
  availableEmploymentTypes: Array<"Hourly" | "Salary">;
  availableStatuses: string[];
  activeFilter: PayrollOverviewFilterState;
}

const DEFAULT_PAGE_SIZE = 10;

/* ============================================================
   Frequency labels — display-only mapping over PayGroup enum.
   ============================================================ */
function frequencyLabel(payFrequency: string): string {
  switch (payFrequency) {
    case "WEEKLY":       return "Weekly";
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
function fmtLongDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-CA", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}
function fmtPeriodLabel(startISO: string, endISO: string): string {
  const s = new Date(startISO), e = new Date(endISO);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${startISO} – ${endISO}`;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return `${s.toLocaleDateString("en-CA", opts)} – ${e.toLocaleDateString("en-CA", opts)}`;
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

  // Resolve default pay group.
  const payGroups = await listPayGroups(principal, clubId);
  const activePayGroups = payGroups.filter((g) => g.active);
  const chosenPayGroup =
    (input.payGroupId && payGroups.find((g) => g.id === input.payGroupId)) ||
    (activePayGroups[0] ?? payGroups[0] ?? null);

  if (!chosenPayGroup) {
    return emptyOverview(filter, page);
  }

  // Resolve pay periods for chosen pay group. Prefer the current-year
  // list ordered by sequence so "current" is deterministic.
  const currentYear = now.getUTCFullYear();
  const [thisYear, lastYear] = await Promise.all([
    listPayPeriods(principal, clubId, { payGroupId: chosenPayGroup.id, taxYear: currentYear }),
    listPayPeriods(principal, clubId, { payGroupId: chosenPayGroup.id, taxYear: currentYear - 1 }),
  ]);
  const allPeriods = [...lastYear, ...thisYear];
  const availablePayPeriods: PayrollOverviewPayPeriodRef[] = allPeriods.map((p) => ({
    id: p.id,
    label: `${fmtPeriodLabel(p.periodStart.toString(), p.periodEnd.toString())} · Pay ${new Date(p.payDate).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`,
    periodStartISO: isoDate(new Date(p.periodStart)),
    periodEndISO: isoDate(new Date(p.periodEnd)),
    payDateISO: isoDate(new Date(p.payDate)),
  }));

  // Prefer the requested period; else current OPEN period; else most
  // recent CLOSED; else last available.
  let chosenPeriod: PayrollOverviewPayPeriodRef | null = null;
  if (input.payPeriodId) {
    chosenPeriod = availablePayPeriods.find((p) => p.id === input.payPeriodId) ?? null;
  }
  if (!chosenPeriod) {
    const rawOpen = allPeriods.find((p) => p.status === "OPEN");
    if (rawOpen) chosenPeriod = availablePayPeriods.find((p) => p.id === rawOpen.id) ?? null;
  }
  if (!chosenPeriod && allPeriods.length > 0) {
    // most-recent by periodEnd
    const sortedByEnd = [...allPeriods].sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime());
    chosenPeriod = availablePayPeriods.find((p) => p.id === sortedByEnd[0].id) ?? null;
  }

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
      employeeTable: emptyEmployeeTable(page),
      availableDepartments: [],
      availableEmploymentTypes: [],
      availableStatuses: [],
      activeFilter: filter,
    };
  }

  // Resolve active (non-VOIDED) batch for the period.
  const activeBatch = await findActiveBatchForPeriod(principal, clubId, chosenPeriod.id);

  if (!activeBatch) {
    return {
      payGroup: payGroupRef,
      payPeriod: chosenPeriod,
      availablePayPeriods,
      batch: null,
      hasBatch: false,
      kpi: emptyKpi(),
      employeeTable: emptyEmployeeTable(page),
      availableDepartments: [],
      availableEmploymentTypes: [],
      availableStatuses: [],
      activeFilter: filter,
    };
  }

  // ---- Load batch employees + relations we need for the table ----
  const [batchRow, batchEmployees, batchEarnings, batchExceptions, batchAdjustments] = await Promise.all([
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
    prisma.payrollBatchException.count({
      where: { batchId: activeBatch.id, clubId, resolvedAt: null },
    }),
    prisma.payrollBatchComponentSnapshot.count({
      where: { batch: { id: activeBatch.id, clubId }, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    }),
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
  const pageSize = DEFAULT_PAGE_SIZE;
  const filteredTotal = filtered.length;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pagedRows = filtered.slice(start, start + pageSize);

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
      exceptionsCount: batchExceptions,
    },
    employeeTable: {
      rows: pagedRows,
      filteredTotal,
      unfilteredTotal: allRows.length,
      page: safePage,
      pageSize,
    },
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
  };
}
function emptyEmployeeTable(page: number): PayrollOverviewViewModel["employeeTable"] {
  return { rows: [], filteredTotal: 0, unfilteredTotal: 0, page, pageSize: DEFAULT_PAGE_SIZE };
}
function emptyOverview(filter: PayrollOverviewFilterState, page: number): PayrollOverviewViewModel {
  return {
    payGroup: null, payPeriod: null, availablePayPeriods: [],
    batch: null, hasBatch: false,
    kpi: emptyKpi(), employeeTable: emptyEmployeeTable(page),
    availableDepartments: [], availableEmploymentTypes: [], availableStatuses: [],
    activeFilter: filter,
  };
}

/** Small helper the Overview page uses to format the pay-date line. */
export function payDateLongLabel(payPeriod: PayrollOverviewPayPeriodRef): string {
  return fmtLongDate(payPeriod.payDateISO);
}
export function periodLongLabel(payPeriod: PayrollOverviewPayPeriodRef): string {
  return `${fmtLongDate(payPeriod.periodStartISO)} – ${fmtLongDate(payPeriod.periodEndISO)}`;
}
