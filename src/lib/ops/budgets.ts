// Budgeting + Forecasting + Variance.
//
// A Budget is a fiscal-year container holding BudgetLines: one per
// (account, department) with 12 monthly amounts. The variance engine compares
// budget lines to posted GL activity from accountBalances() in the same
// fiscal-year window.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { toMoney, sumMoney, ZERO } from "../accounting/decimal";
import { accountBalances } from "../accounting/balance";

export const budgetSchema = z.object({
  fiscalYearId: z.string(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  version: z.number().int().min(1).default(1),
});

export async function createBudget(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "budget:edit");
  const parsed = budgetSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const fy = await prisma.fiscalYear.findUnique({ where: { id: d.fiscalYearId } });
  if (!fy || fy.clubId !== clubId) throw new NotFoundError("FiscalYear", d.fiscalYearId);
  const budget = await prisma.budget.create({
    data: {
      clubId, fiscalYearId: d.fiscalYearId,
      name: d.name, description: d.description ?? null,
      version: d.version, status: "DRAFT",
      createdByUserId: principal.id,
    },
  });
  await audit(principal, { action: "budget.create", entityType: "Budget", entityId: budget.id, clubId, after: { name: d.name, version: d.version } });
  return budget;
}

export const budgetLineSchema = z.object({
  accountNumber: z.string(),
  departmentCode: z.string().optional().nullable(),
  monthlyAmounts: z.array(z.number()).length(12),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export async function upsertBudgetLine(principal: Principal, budgetId: string, raw: unknown) {
  const budget = await prisma.budget.findUnique({ where: { id: budgetId } });
  assertTenantOwned(budget, principal);
  requirePermission(principal, budget.clubId, "budget:edit");
  if (budget.status === "APPROVED" || budget.status === "ACTIVE" || budget.status === "ARCHIVED") {
    throw new ConflictError(`Budget is ${budget.status} — create a new version to edit`);
  }
  const parsed = budgetLineSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const account = await prisma.account.findFirst({ where: { clubId: budget.clubId, accountNumber: d.accountNumber } });
  if (!account) throw new ConflictError(`Unknown account ${d.accountNumber}`);
  if (account.isHeader) throw new ConflictError("Cannot budget a header account");
  const department = d.departmentCode ? await prisma.department.findFirst({ where: { clubId: budget.clubId, code: d.departmentCode } }) : null;
  const annualTotal = Math.round(d.monthlyAmounts.reduce((s, v) => s + v, 0) * 100) / 100;

  // Prisma's typed where for the compound-unique key with a nullable
  // departmentId is awkward — emulate upsert by hand.
  const existing = await prisma.budgetLine.findFirst({
    where: { budgetId, accountId: account.id, departmentId: department?.id ?? null },
  });
  const data = {
    monthlyAmounts: JSON.stringify(d.monthlyAmounts),
    annualTotal,
    notes: d.notes ?? null,
  };
  if (existing) {
    return prisma.budgetLine.update({ where: { id: existing.id }, data });
  }
  return prisma.budgetLine.create({
    data: {
      ...data,
      clubId: budget.clubId, budgetId,
      accountId: account.id, departmentId: department?.id ?? null,
    },
  });
}

export async function approveBudget(principal: Principal, budgetId: string) {
  const budget = await prisma.budget.findUnique({ where: { id: budgetId } });
  assertTenantOwned(budget, principal);
  requirePermission(principal, budget.clubId, "budget:approve");
  if (budget.status !== "DRAFT" && budget.status !== "UNDER_REVIEW") {
    throw new ConflictError(`Budget is ${budget.status}`);
  }
  const updated = await prisma.budget.update({ where: { id: budgetId }, data: { status: "APPROVED" } });
  await audit(principal, { action: "budget.approve", entityType: "Budget", entityId: budgetId, clubId: budget.clubId, after: { status: "APPROVED" } });
  return updated;
}

export async function activateBudget(principal: Principal, budgetId: string) {
  const budget = await prisma.budget.findUnique({ where: { id: budgetId } });
  assertTenantOwned(budget, principal);
  requirePermission(principal, budget.clubId, "budget:approve");
  if (budget.status !== "APPROVED") throw new ConflictError(`Budget must be APPROVED first (was ${budget.status})`);
  // At most one ACTIVE budget per fiscal year — archive the previous active.
  await prisma.budget.updateMany({
    where: { clubId: budget.clubId, fiscalYearId: budget.fiscalYearId, status: "ACTIVE", id: { not: budgetId } },
    data: { status: "ARCHIVED" },
  });
  const updated = await prisma.budget.update({ where: { id: budgetId }, data: { status: "ACTIVE" } });
  await audit(principal, { action: "budget.activate", entityType: "Budget", entityId: budgetId, clubId: budget.clubId, after: { status: "ACTIVE" } });
  return updated;
}

// ----- Variance -----------------------------------------------------------
export type VarianceRow = {
  accountNumber: string;
  accountName: string;
  accountType: string;
  departmentName: string | null;
  budget: Prisma.Decimal;
  actual: Prisma.Decimal;
  variance: Prisma.Decimal;
  variancePct: number;
};

export async function budgetVsActual(
  clubId: string,
  budgetId: string,
  opts?: { asOf?: Date }
): Promise<{ rows: VarianceRow[]; totalBudget: Prisma.Decimal; totalActual: Prisma.Decimal; totalVariance: Prisma.Decimal }> {
  const budget = await prisma.budget.findUnique({
    where: { id: budgetId },
    include: { fiscalYear: true, lines: { include: { account: true, department: true } } },
  });
  if (!budget || budget.clubId !== clubId) throw new NotFoundError("Budget", budgetId);

  const asOf = opts?.asOf ?? new Date();
  // Sum posted activity from FY start through asOf (capped at FY end).
  const to = asOf < budget.fiscalYear.endDate ? asOf : budget.fiscalYear.endDate;
  const balances = await accountBalances(clubId, { from: budget.fiscalYear.startDate, to });
  const actualByAccount = new Map<string, Prisma.Decimal>();
  for (const b of balances) {
    actualByAccount.set(b.accountId, b.naturalBalance);
  }

  // Budget contribution scaled to fraction of year elapsed.
  const fyLengthMs = budget.fiscalYear.endDate.getTime() - budget.fiscalYear.startDate.getTime();
  const elapsedMs = Math.max(0, Math.min(fyLengthMs, to.getTime() - budget.fiscalYear.startDate.getTime()));
  const elapsedFraction = fyLengthMs > 0 ? elapsedMs / fyLengthMs : 1;

  const rows: VarianceRow[] = budget.lines.map((line) => {
    const monthly = JSON.parse(line.monthlyAmounts) as number[];
    // Sum the months that have fully elapsed, plus a pro-rata of the current month.
    const monthsElapsed = elapsedFraction * 12;
    let budgetActualToDate = 0;
    for (let i = 0; i < 12; i++) {
      if (i + 1 <= monthsElapsed) {
        budgetActualToDate += monthly[i];
      } else if (i < monthsElapsed) {
        budgetActualToDate += monthly[i] * (monthsElapsed - i);
      }
    }
    const budgetDec = toMoney(Math.round(budgetActualToDate * 100) / 100);
    const actualDec = actualByAccount.get(line.accountId) ?? ZERO;
    const variance = actualDec.minus(budgetDec);
    const variancePct = budgetDec.isZero() ? 0 : Math.round(variance.div(budgetDec.abs()).mul(100).toNumber() * 10) / 10;
    return {
      accountNumber: line.account.accountNumber,
      accountName: line.account.name,
      accountType: line.account.type,
      departmentName: line.department?.name ?? null,
      budget: budgetDec,
      actual: actualDec,
      variance,
      variancePct,
    };
  });
  const totalBudget = sumMoney(rows.map((r) => r.budget));
  const totalActual = sumMoney(rows.map((r) => r.actual));
  return { rows, totalBudget, totalActual, totalVariance: totalActual.minus(totalBudget) };
}

export async function listBudgets(principal: Principal, clubId: string) {
  return prisma.budget.findMany({
    where: tenantWhere(principal, clubId),
    include: { fiscalYear: true, lines: true },
    orderBy: [{ fiscalYearId: "desc" }, { version: "desc" }],
  });
}

export async function getBudget(principal: Principal, budgetId: string) {
  const b = await prisma.budget.findUnique({
    where: { id: budgetId },
    include: {
      fiscalYear: true,
      lines: { include: { account: true, department: true }, orderBy: [{ account: { accountNumber: "asc" } }] },
      assumptions: true,
    },
  });
  if (!b) throw new NotFoundError("Budget", budgetId);
  assertTenantOwned(b, principal);
  return b;
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
