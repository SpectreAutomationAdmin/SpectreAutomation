// Phase 6A — Enterprise reporting engine.
//
// Architecture:
//   ReportDefinition   — the "kind" of report (e.g. "balance_sheet"). Builtin
//                        renderers live in REPORT_RENDERERS; CUSTOM is reserved
//                        for future DSL-defined reports.
//   SavedReport        — a parameterized configuration belonging to a user.
//   ReportRun          — a frozen execution: parameters + result JSON. Immutable.
//   ReportExport       — a serialized export (CSV/PDF/etc.) of a ReportRun.
//
// The engine is the single audit-safe surface for all enterprise reporting:
// every run is audit-logged, tenant-scoped, and permission-checked.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { trialBalance, balanceSheet, incomeStatement, incomeStatementByDepartment } from "../accounting/reports";
import { apAging } from "../ap/reports";

// ---------------------------------------------------------------------------
// Renderer registry. Each renderer takes (clubId, params) and returns rows.
// ---------------------------------------------------------------------------
export type ReportRenderer = (clubId: string, params: Record<string, unknown>) => Promise<{
  rows: unknown[];
  meta?: Record<string, unknown>;
}>;

export const REPORT_RENDERERS: Record<string, ReportRenderer> = {
  trial_balance: async (clubId, params) => {
    const asOf = params.asOf ? new Date(String(params.asOf)) : new Date();
    const result = await trialBalance(clubId, asOf);
    return { rows: result.rows as unknown[], meta: { totalDebit: result.totalDebit.toString(), totalCredit: result.totalCredit.toString(), isBalanced: result.isBalanced } };
  },
  balance_sheet: async (clubId, params) => {
    const asOf = params.asOf ? new Date(String(params.asOf)) : new Date();
    const result = await balanceSheet(clubId, asOf);
    return {
      rows: [...result.assets, ...result.liabilities, ...result.equity] as unknown[],
      meta: { totalAssets: result.totalAssets.toString(), totalLiabilities: result.totalLiabilities.toString(), totalEquity: result.totalEquity.toString(), isBalanced: result.isBalanced },
    };
  },
  income_statement: async (clubId, params) => {
    const from = params.from ? new Date(String(params.from)) : new Date(new Date().getFullYear(), 0, 1);
    const to = params.to ? new Date(String(params.to)) : new Date();
    const result = await incomeStatement(clubId, from, to);
    return {
      rows: [...result.revenue, ...result.cogs, ...result.opex] as unknown[],
      meta: { totalRevenue: result.totalRevenue.toString(), totalCogs: result.totalCogs.toString(), totalOpex: result.totalOpex.toString(), netIncome: result.netIncome.toString() },
    };
  },
  department_pnl: async (clubId, params) => {
    const from = params.from ? new Date(String(params.from)) : new Date(new Date().getFullYear(), 0, 1);
    const to = params.to ? new Date(String(params.to)) : new Date();
    const result = await incomeStatementByDepartment(clubId, from, to);
    return { rows: result.rows as unknown[] };
  },
  ap_aging: async (clubId, params) => {
    const asOf = params.asOf ? new Date(String(params.asOf)) : new Date();
    const result = await apAging(clubId, asOf);
    return { rows: result.rows as unknown[], meta: { total: result.totals.total.toString() } };
  },
  ar_aging: async (clubId) => {
    const accounts = await prisma.memberAccount.findMany({
      where: { clubId },
      include: { member: true },
    });
    const rows = accounts.map((a) => ({
      memberNumber: a.member.memberNumber,
      memberName: `${a.member.firstName} ${a.member.lastName}`,
      currentBalance: Number(a.currentBalance.toString()),
      thirtyDayBalance: Number(a.thirtyDayBalance.toString()),
      sixtyDayBalance: Number(a.sixtyDayBalance.toString()),
      ninetyDayBalance: Number(a.ninetyDayBalance.toString()),
      oneTwentyDayBalance: Number(a.oneTwentyDayBalance.toString()),
    }));
    return { rows };
  },
  membership_statistics: async (clubId) => {
    const grouped = await prisma.member.groupBy({
      by: ["status"],
      where: { clubId },
      _count: { _all: true },
    });
    return { rows: grouped.map((g) => ({ status: g.status, count: g._count._all })) };
  },
  budget_vs_actual: async (clubId, params) => {
    const budgetId = String(params.budgetId ?? "");
    if (!budgetId) return { rows: [] };
    const { budgetVsActual } = await import("../ops/budgets");
    const result = await budgetVsActual(clubId, budgetId);
    return {
      rows: result.rows as unknown[],
      meta: { totalBudget: result.totalBudget.toString(), totalActual: result.totalActual.toString() },
    };
  },
  inventory_valuation: async (clubId) => {
    const items = await prisma.inventoryItem.findMany({ where: { clubId, isActive: true }, include: { category: true } });
    const rows = items.map((i) => ({
      sku: i.sku,
      name: i.name,
      category: i.category?.name ?? null,
      quantityOnHand: Number(i.quantityOnHand.toString()),
      averageCost: Number(i.averageCost.toString()),
      valuation: Math.round(Number(i.quantityOnHand.toString()) * Number(i.averageCost.toString()) * 100) / 100,
    }));
    const total = rows.reduce((s, r) => s + r.valuation, 0);
    return { rows, meta: { total } };
  },
};

// ---------------------------------------------------------------------------
// Builtin definitions seed
// ---------------------------------------------------------------------------
export const BUILTIN_REPORT_DEFINITIONS = [
  { key: "trial_balance", name: "Trial Balance", category: "FINANCIAL", permissionKey: "reports:financial" },
  { key: "balance_sheet", name: "Balance Sheet", category: "FINANCIAL", permissionKey: "reports:financial" },
  { key: "income_statement", name: "Income Statement", category: "FINANCIAL", permissionKey: "reports:financial" },
  { key: "department_pnl", name: "Department P&L", category: "FINANCIAL", permissionKey: "reports:financial" },
  { key: "ap_aging", name: "AP Aging", category: "FINANCIAL", permissionKey: "ap:report:view" },
  { key: "ar_aging", name: "AR Aging", category: "FINANCIAL", permissionKey: "ar:read" },
  { key: "membership_statistics", name: "Membership Statistics", category: "MEMBERSHIP", permissionKey: "members:read" },
  { key: "budget_vs_actual", name: "Budget vs Actual", category: "FINANCIAL", permissionKey: "budget:read" },
  { key: "inventory_valuation", name: "Inventory Valuation", category: "OPERATING", permissionKey: "inventory:read" },
] as const;

export async function ensureBuiltinDefinitions(clubId: string) {
  for (const d of BUILTIN_REPORT_DEFINITIONS) {
    await prisma.reportDefinition.upsert({
      where: { clubId_key: { clubId, key: d.key } },
      update: { name: d.name, category: d.category, permissionKey: d.permissionKey, kind: "BUILTIN", isActive: true },
      create: {
        clubId, key: d.key, name: d.name, category: d.category, permissionKey: d.permissionKey, kind: "BUILTIN",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------------
export const savedReportSchema = z.object({
  definitionKey: z.string(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  isShared: z.boolean().default(false),
});

export async function createSavedReport(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "reports:write");
  const parsed = savedReportSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const def = await prisma.reportDefinition.findFirst({ where: { clubId, key: d.definitionKey } });
  if (!def) throw new NotFoundError("ReportDefinition", d.definitionKey);
  const saved = await prisma.savedReport.create({
    data: {
      clubId, definitionId: def.id, name: d.name, description: d.description ?? null,
      parametersJson: JSON.stringify(d.parameters), isShared: d.isShared, ownerUserId: principal.id,
    },
  });
  await audit(principal, { action: "report.saved.create", entityType: "SavedReport", entityId: saved.id, clubId, after: { name: d.name } });
  return saved;
}

export async function listSavedReports(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "reports:read");
  return prisma.savedReport.findMany({
    where: { ...tenantWhere(principal, clubId), OR: [{ ownerUserId: principal.id }, { isShared: true }] },
    include: { definition: true },
    orderBy: { updatedAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Run reports
// ---------------------------------------------------------------------------
export async function runReport(
  principal: Principal,
  clubId: string,
  args: { definitionKey: string; parameters?: Record<string, unknown>; savedReportId?: string | null }
) {
  requirePermission(principal, clubId, "reports:read");
  const def = await prisma.reportDefinition.findFirst({ where: { clubId, key: args.definitionKey } });
  if (!def) throw new NotFoundError("ReportDefinition", args.definitionKey);

  // Enforce the definition's specific permission gate.
  if (def.permissionKey && !hasPermission(principal, clubId, def.permissionKey as never)) {
    throw new ConflictError(`Missing report permission: ${def.permissionKey}`);
  }

  const renderer = REPORT_RENDERERS[def.key];
  if (!renderer) throw new ConflictError(`No renderer for ${def.key}`);
  const params = args.parameters ?? {};

  const run = await prisma.reportRun.create({
    data: {
      clubId, definitionId: def.id, savedReportId: args.savedReportId ?? null,
      parametersJson: JSON.stringify(params), status: "RUNNING",
      startedAt: new Date(), runByUserId: principal.id,
    },
  });
  try {
    const result = await renderer(clubId, params);
    const rowCount = Array.isArray(result.rows) ? result.rows.length : 0;
    const resultJson = safeStringify({ rows: result.rows, meta: result.meta });
    const updated = await prisma.reportRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED", finishedAt: new Date(), rowCount,
        resultJson,
      },
    });
    if (args.savedReportId) {
      await prisma.savedReport.update({ where: { id: args.savedReportId }, data: { lastRunId: run.id } });
    }
    await audit(principal, { action: "report.run", entityType: "ReportRun", entityId: run.id, clubId, after: { definitionKey: def.key, rowCount } });
    return updated;
  } catch (err) {
    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: "FAILED", finishedAt: new Date(), errorMessage: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

export async function getReportRun(principal: Principal, runId: string) {
  const run = await prisma.reportRun.findUnique({ where: { id: runId }, include: { definition: true, savedReport: true } });
  assertTenantOwned(run, principal);
  requirePermission(principal, run.clubId, "reports:read");
  return run;
}

export async function listReportRuns(principal: Principal, clubId: string, opts?: { definitionKey?: string; limit?: number }) {
  requirePermission(principal, clubId, "reports:read");
  const def = opts?.definitionKey ? await prisma.reportDefinition.findFirst({ where: { clubId, key: opts.definitionKey } }) : null;
  return prisma.reportRun.findMany({
    where: { ...tenantWhere(principal, clubId), ...(def ? { definitionId: def.id } : {}) },
    orderBy: { startedAt: "desc" },
    take: opts?.limit ?? 50,
    include: { definition: true },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}

function safeStringify(v: unknown): string {
  const json = JSON.stringify(v);
  // Hard cap to ~4 MB (SQLite TEXT). Larger results should go to a Document.
  return json.length > 4_000_000 ? json.slice(0, 4_000_000) + "…[truncated]" : json;
}
