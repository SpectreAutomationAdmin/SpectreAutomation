// Payroll + Timekeeper service.
//
// IMPORTANT: This is architecture, not legal compliance. Jurisdiction-
// specific tax/CPP/EI/WCB calculations are configurable. Phase 5 ships:
//   - Employee + position model
//   - Pay periods with OPEN → LOCKED → POSTED lifecycle
//   - Timesheets + timesheet entries (manual + clock placeholder)
//   - PayrollRun computed from approved timesheets
//   - GL posting via the existing adapter pattern
//
// Posting model:
//   DR Wages Expense (per department)
//   CR Accrued Payroll (2030) for net pay
//   CR Accrued Source Deductions (2040) for taxes
//   CR Accrued Vacation (2035) when vacation accrual is configured
// Remittances (via AP):
//   DR Accrued Source Deductions / Accrued Vacation
//   CR AP Control (via AP invoice mapping)

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { toMoney, sumMoney } from "../accounting/decimal";
import { createPostedFromAdapter } from "../accounting/journal";
import { findPeriodForDate } from "../accounting/periods";

const DEFAULT_ACCRUED_PAYROLL = "2030";
const DEFAULT_ACCRUED_SOURCE_DEDUCTIONS = "2040";

// ----- Employee CRUD ------------------------------------------------------
export const employeeSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  email: z.string().email().max(254).optional().or(z.literal("")).transform((v) => v && v.length ? v.toLowerCase() : null),
  phone: z.string().trim().max(40).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
  departmentCode: z.string().optional().nullable(),
  positionCode: z.string().optional().nullable(),
  hireDate: z.string().or(z.date()).optional(),
  compensationType: z.enum(["SALARY", "HOURLY"]).default("HOURLY"),
  payRate: z.number().nonnegative().default(0),
});

async function nextEmployeeNumber(clubId: string): Promise<string> {
  const count = await prisma.employee.count({ where: { clubId } });
  return `E-${(count + 1).toString().padStart(5, "0")}`;
}

export async function createEmployee(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "payroll:employees:manage");
  const parsed = employeeSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const department = d.departmentCode ? await prisma.department.findFirst({ where: { clubId, code: d.departmentCode } }) : null;
  const position = d.positionCode ? await prisma.employeePosition.findFirst({ where: { clubId, code: d.positionCode } }) : null;
  return prisma.employee.create({
    data: {
      clubId,
      employeeNumber: await nextEmployeeNumber(clubId),
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email,
      phone: d.phone,
      departmentId: department?.id ?? null,
      positionId: position?.id ?? null,
      hireDate: d.hireDate ? new Date(d.hireDate) : null,
      compensationType: d.compensationType,
      payRate: d.payRate,
      status: "ACTIVE",
    },
  });
}

// ----- Pay periods --------------------------------------------------------
export const periodSchema = z.object({
  label: z.string().trim().min(1).max(40),
  startDate: z.string().or(z.date()),
  endDate: z.string().or(z.date()),
  payDate: z.string().or(z.date()),
});

export async function createPeriod(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "payroll:run");
  const parsed = periodSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  return prisma.payrollPeriod.create({
    data: {
      clubId,
      label: parsed.data.label,
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
      payDate: new Date(parsed.data.payDate),
      status: "OPEN",
    },
  });
}

export async function lockPeriod(principal: Principal, periodId: string) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  assertTenantOwned(period, principal);
  requirePermission(principal, period.clubId, "payroll:run");
  if (period.status === "LOCKED" || period.status === "POSTED") return period;
  const updated = await prisma.payrollPeriod.update({
    where: { id: periodId },
    data: { status: "LOCKED", lockedAt: new Date(), lockedByUserId: principal.id },
  });
  await audit(principal, { action: "payroll.period.lock", entityType: "PayrollPeriod", entityId: periodId, clubId: period.clubId, after: { status: "LOCKED" } });
  return updated;
}

// ----- Timesheets ---------------------------------------------------------
export const timesheetEntrySchema = z.object({
  workDate: z.string().or(z.date()),
  totalHours: z.number().positive(),
  kind: z.enum(["REGULAR", "OVERTIME", "STAT", "VACATION", "SICK", "UNPAID"]).default("REGULAR"),
  departmentCode: z.string().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export async function ensureTimesheet(principal: Principal, employeeId: string, periodId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  assertTenantOwned(employee, principal);
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  assertTenantOwned(period, principal);
  if (period.clubId !== employee.clubId) throw new ConflictError("Period and employee belong to different clubs");
  return prisma.timesheet.upsert({
    where: { clubId_employeeId_periodId: { clubId: employee.clubId, employeeId, periodId } },
    update: {},
    create: { clubId: employee.clubId, employeeId, periodId, status: "DRAFT" },
  });
}

export async function addTimesheetEntry(principal: Principal, timesheetId: string, raw: unknown) {
  const timesheet = await prisma.timesheet.findUnique({ where: { id: timesheetId }, include: { period: true } });
  assertTenantOwned(timesheet, principal);
  if (timesheet.status !== "DRAFT") throw new ConflictError(`Timesheet is ${timesheet.status}`);
  if (timesheet.period.status === "LOCKED" || timesheet.period.status === "POSTED") {
    throw new ConflictError("Pay period is locked");
  }
  const parsed = timesheetEntrySchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const dept = d.departmentCode ? await prisma.department.findFirst({ where: { clubId: timesheet.clubId, code: d.departmentCode } }) : null;
  const entry = await prisma.timesheetEntry.create({
    data: {
      clubId: timesheet.clubId,
      timesheetId,
      workDate: new Date(d.workDate),
      totalHours: d.totalHours,
      kind: d.kind,
      departmentId: dept?.id ?? null,
      sourceType: "MANUAL",
      notes: d.notes ?? null,
    },
  });
  await recomputeTimesheetTotals(timesheetId);
  return entry;
}

async function recomputeTimesheetTotals(timesheetId: string) {
  const entries = await prisma.timesheetEntry.findMany({ where: { timesheetId } });
  const totalHours = entries.reduce((s, e) => s + Number(e.totalHours.toString()), 0);
  const totalOT = entries.filter((e) => e.kind === "OVERTIME").reduce((s, e) => s + Number(e.totalHours.toString()), 0);
  await prisma.timesheet.update({ where: { id: timesheetId }, data: { totalHours, totalOvertimeHours: totalOT } });
}

export async function submitTimesheet(principal: Principal, timesheetId: string) {
  const ts = await prisma.timesheet.findUnique({ where: { id: timesheetId } });
  assertTenantOwned(ts, principal);
  if (ts.status !== "DRAFT") throw new ConflictError(`Timesheet is ${ts.status}`);
  return prisma.timesheet.update({ where: { id: timesheetId }, data: { status: "SUBMITTED", submittedAt: new Date() } });
}

export async function approveTimesheet(principal: Principal, timesheetId: string) {
  const ts = await prisma.timesheet.findUnique({ where: { id: timesheetId } });
  assertTenantOwned(ts, principal);
  requirePermission(principal, ts.clubId, "payroll:timesheets:approve");
  if (ts.status === "LOCKED") return ts;
  if (ts.status !== "SUBMITTED" && ts.status !== "DRAFT") throw new ConflictError(`Timesheet is ${ts.status}`);
  const updated = await prisma.timesheet.update({
    where: { id: timesheetId },
    data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: principal.id },
  });
  await audit(principal, { action: "payroll.timesheet.approve", entityType: "Timesheet", entityId: timesheetId, clubId: ts.clubId, after: { status: "APPROVED" } });
  return updated;
}

// ----- Payroll run --------------------------------------------------------
// Computes a run from approved timesheets in the period. Stores per-employee
// lines with gross/net/taxes/benefits; the deduction calculator is pluggable.
//
// For Phase 5 we ship a deliberately simple deduction model: a flat 22% tax
// withholding placeholder. Real CRA tax tables are wired in Phase 7 via the
// payroll provider adapter.
const FLAT_TAX_RATE = 0.22;

export async function buildRun(principal: Principal, clubId: string, periodId: string) {
  requirePermission(principal, clubId, "payroll:run");
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period || period.clubId !== clubId) throw new NotFoundError("PayrollPeriod", periodId);
  if (period.status === "POSTED") throw new ConflictError("Period already posted");

  // Approved timesheets only.
  const timesheets = await prisma.timesheet.findMany({
    where: { clubId, periodId, status: "APPROVED" },
    include: { employee: { include: { department: true } }, entries: true },
  });
  if (timesheets.length === 0) throw new ConflictError("No approved timesheets in period");

  const runNumber = await nextRunNumber(clubId);
  const run = await prisma.payrollRun.create({
    data: {
      clubId, periodId, runNumber, status: "DRAFT", createdByUserId: principal.id,
    },
  });

  let totalGross = 0, totalTax = 0, totalNet = 0;
  for (const ts of timesheets) {
    const reg = ts.entries.filter((e) => e.kind === "REGULAR").reduce((s, e) => s + Number(e.totalHours.toString()), 0);
    const ot = ts.entries.filter((e) => e.kind === "OVERTIME").reduce((s, e) => s + Number(e.totalHours.toString()), 0);
    const rate = Number(ts.employee.payRate.toString());
    const gross = ts.employee.compensationType === "SALARY"
      ? rate / 26 // assume bi-weekly periods; configurable later
      : Math.round((reg * rate + ot * rate * 1.5) * 100) / 100;
    const tax = Math.round(gross * FLAT_TAX_RATE * 100) / 100;
    const net = Math.round((gross - tax) * 100) / 100;
    totalGross += gross; totalTax += tax; totalNet += net;
    await prisma.payrollLine.create({
      data: {
        clubId, runId: run.id, employeeId: ts.employeeId,
        departmentId: ts.employee.departmentId,
        regularHours: reg, overtimeHours: ot,
        grossPay: gross, taxes: tax, netPay: net,
        deductionsJson: JSON.stringify({ flatTaxRate: FLAT_TAX_RATE }),
      },
    });
  }
  const updated = await prisma.payrollRun.update({
    where: { id: run.id },
    data: { totalGross, totalNet, totalTaxes: totalTax, totalEmployerCost: totalGross },
  });
  await audit(principal, { action: "payroll.run.build", entityType: "PayrollRun", entityId: run.id, clubId, after: { runNumber, totalGross, totalNet } });
  return updated;
}

async function nextRunNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.payrollRun.count({ where: { clubId, createdAt: { gte: new Date(year, 0, 1) } } });
  return `PR-${year}-${(count + 1).toString().padStart(4, "0")}`;
}

// Post a payroll run: writes the JE and flips status to POSTED.
export async function postRun(principal: Principal, runId: string) {
  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    include: { lines: { include: { employee: { include: { department: true } } } }, period: true },
  });
  assertTenantOwned(run, principal);
  requirePermission(principal, run.clubId, "payroll:run");
  if (run.status === "POSTED") return run;
  if (run.status !== "DRAFT" && run.status !== "APPROVED") {
    throw new ConflictError(`Run is ${run.status}`);
  }
  const postDate = run.period.payDate;
  if (!(await findPeriodForDate(run.clubId, postDate))) {
    throw new ConflictError("No fiscal period for pay date");
  }

  // Aggregate wage expense by department code.
  type Line = { accountNumber: string; departmentCode?: string | null; description?: string | null; debit?: string; credit?: string };
  const wageByDept = new Map<string, number>();
  for (const line of run.lines) {
    const code = line.employee.department?.code ?? "ADMIN";
    wageByDept.set(code, (wageByDept.get(code) ?? 0) + Number(line.grossPay.toString()));
  }
  const lines: Line[] = [];
  // Department-keyed expense accounts: 6000 Course, 6100 Pro Shop, 6200 F&B,
  // 6300 Clubhouse, 6400 Admin. Default to 6400 if unmapped.
  const expenseAccountByDept: Record<string, string> = {
    COURSE: "6000", PROSHOP: "6100", FB: "6200", CLUBHOUSE: "6300", ADMIN: "6400",
  };
  for (const [code, amount] of wageByDept.entries()) {
    if (amount <= 0) continue;
    const acct = expenseAccountByDept[code] ?? "6400";
    lines.push({ accountNumber: acct, departmentCode: code, description: `Wages · ${code}`, debit: amount.toFixed(2) });
  }
  const totalTaxes = Number(run.totalTaxes.toString());
  const totalNet = Number(run.totalNet.toString());
  if (totalTaxes > 0) lines.push({ accountNumber: DEFAULT_ACCRUED_SOURCE_DEDUCTIONS, credit: totalTaxes.toFixed(2), description: "Source deductions" });
  lines.push({ accountNumber: DEFAULT_ACCRUED_PAYROLL, credit: totalNet.toFixed(2), description: "Net pay to disburse" });

  const journal = await createPostedFromAdapter(
    principal, run.clubId,
    { entryDate: postDate, description: `Payroll run ${run.runNumber}`, lines },
    { source: "PAYROLL", sourceEntityType: "PayrollRun", sourceEntityId: run.id }
  );
  const updated = await prisma.payrollRun.update({
    where: { id: runId },
    data: { status: "POSTED", postedAt: new Date(), postedByUserId: principal.id, postedJournalEntryId: journal.id },
  });
  await prisma.payrollPeriod.update({
    where: { id: run.periodId },
    data: { status: "POSTED" },
  });
  await audit(principal, { action: "payroll.run.post", entityType: "PayrollRun", entityId: runId, clubId: run.clubId, after: { status: "POSTED", totalGross: run.totalGross.toString(), journalEntryId: journal.id } });
  return updated;
}

// ----- Labour vs budget ---------------------------------------------------
export async function labourVsBudget(clubId: string, periodLabel: string) {
  const [actual, budget] = await Promise.all([
    prisma.payrollLine.groupBy({
      by: ["departmentId"],
      where: { clubId, run: { period: { label: periodLabel } } },
      _sum: { grossPay: true, regularHours: true, overtimeHours: true },
    }),
    prisma.labourBudget.findMany({ where: { clubId, periodLabel } }),
  ]);
  const byDept = new Map<string | null, { actualHours: number; actualCost: number; budgetedHours: number; budgetedCost: number }>();
  for (const a of actual) {
    const hours = (Number(a._sum.regularHours?.toString() ?? "0")) + (Number(a._sum.overtimeHours?.toString() ?? "0"));
    byDept.set(a.departmentId, { actualHours: hours, actualCost: Number(a._sum.grossPay?.toString() ?? "0"), budgetedHours: 0, budgetedCost: 0 });
  }
  for (const b of budget) {
    const existing = byDept.get(b.departmentId) ?? { actualHours: 0, actualCost: 0, budgetedHours: 0, budgetedCost: 0 };
    existing.budgetedHours = Number(b.budgetedHours.toString());
    existing.budgetedCost = Number(b.budgetedCost.toString());
    byDept.set(b.departmentId, existing);
  }
  return Array.from(byDept.entries()).map(([deptId, v]) => ({ departmentId: deptId, ...v }));
}

export async function listEmployees(principal: Principal, clubId: string) {
  return prisma.employee.findMany({
    where: { ...tenantWhere(principal, clubId), status: { not: "TERMINATED" } },
    include: { department: true, position: true },
    orderBy: { lastName: "asc" },
  });
}

export async function listPeriods(principal: Principal, clubId: string) {
  return prisma.payrollPeriod.findMany({
    where: tenantWhere(principal, clubId),
    orderBy: { startDate: "desc" },
  });
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
void Prisma; void toMoney; void sumMoney;
