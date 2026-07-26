// Phase 6F — KPI engine + dashboards.
//
// A KPI is a named, time-bucketed metric. A KPIValue is one observation
// (monthly). The compute registry dispatches by KPI.computeKey to a function
// that returns a number for a given (clubId, asOfDate). Thresholds raise
// KPIAlerts which the notification engine can deliver.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, ValidationError } from "../errors";

// ---------------------------------------------------------------------------
// Compute registry
// ---------------------------------------------------------------------------
export type KPIComputeFn = (clubId: string, asOf: Date) => Promise<number>;

export const KPI_COMPUTE: Record<string, KPIComputeFn> = {
  cash_balance: async (clubId, asOf) => {
    const { accountBalances } = await import("../accounting/balance");
    const fy = await prisma.fiscalYear.findFirst({ where: { clubId }, orderBy: { startDate: "asc" } });
    const balances = await accountBalances(clubId, { from: fy?.startDate ?? new Date(asOf.getFullYear(), 0, 1), to: asOf });
    const cashAccount = await prisma.account.findFirst({ where: { clubId, accountNumber: "1010" } });
    if (!cashAccount) return 0;
    const row = balances.find((b) => b.accountId === cashAccount.id);
    return row ? Number(row.naturalBalance.toString()) : 0;
  },
  ar_over_60: async (clubId) => {
    const accounts = await prisma.memberAccount.findMany({ where: { clubId } });
    return accounts.reduce((s, a) => s + Number(a.sixtyDayBalance.toString()) + Number(a.ninetyDayBalance.toString()) + Number(a.oneTwentyDayBalance.toString()), 0);
  },
  active_members: async (clubId) => prisma.member.count({ where: { clubId, status: "ACTIVE" } }),
  waitlist_count: async (clubId) => prisma.applicant.count({ where: { clubId, applicationStatus: "WAITLISTED" } }),
  ap_open_total: async (clubId) => {
    const invoices = await prisma.aPInvoice.findMany({ where: { clubId, status: "POSTED" } });
    return invoices.reduce((s, i) => s + Number(i.total.toString()) - Number(i.amountPaid.toString()), 0);
  },
  inventory_valuation: async (clubId) => {
    const items = await prisma.inventoryItem.findMany({ where: { clubId, isActive: true } });
    return items.reduce((s, i) => s + Number(i.quantityOnHand.toString()) * Number(i.averageCost.toString()), 0);
  },
  active_employees: async (clubId) => prisma.employee.count({ where: { clubId, status: "ACTIVE" } }),
  open_lessons: async (clubId) => prisma.lessonBooking.count({ where: { clubId, status: { in: ["SCHEDULED", "INSTRUCTOR_CONFIRMED"] } } }),
  collections_outstanding: async (clubId) => prisma.collectionNotice.count({ where: { clubId, status: "SENT" } }),
};

// ---------------------------------------------------------------------------
// KPI CRUD
// ---------------------------------------------------------------------------
export const kpiSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  kind: z.enum(["FINANCIAL", "OPERATIONAL", "MEMBERSHIP", "PAYROLL", "INVENTORY", "EVENT", "COLLECTIONS"]),
  unit: z.string().trim().max(20).optional().nullable(),
  computeKey: z.string().trim().min(1),
  direction: z.enum(["HIGHER_BETTER", "LOWER_BETTER", "NEUTRAL"]).default("HIGHER_BETTER"),
});

export async function upsertKPI(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "kpi:write");
  const parsed = kpiSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  if (!KPI_COMPUTE[d.computeKey]) throw new ConflictError(`Unknown computeKey: ${d.computeKey}`);
  const kpi = await prisma.kPI.upsert({
    where: { clubId_key: { clubId, key: d.key } },
    update: { name: d.name, description: d.description ?? null, kind: d.kind, unit: d.unit ?? null, computeKey: d.computeKey, direction: d.direction, isActive: true },
    create: { clubId, key: d.key, name: d.name, description: d.description ?? null, kind: d.kind, unit: d.unit ?? null, computeKey: d.computeKey, direction: d.direction },
  });
  await audit(principal, { action: "kpi.upsert", entityType: "KPI", entityId: kpi.id, clubId, after: { key: d.key } });
  return kpi;
}

// ---------------------------------------------------------------------------
// Compute + persist
// ---------------------------------------------------------------------------
export async function computeKPIValues(clubId: string, asOf: Date = new Date()) {
  const kpis = await prisma.kPI.findMany({ where: { clubId, isActive: true } });
  const periodLabel = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, "0")}`;
  const results: Array<{ kpiId: string; value: number }> = [];
  for (const kpi of kpis) {
    const fn = KPI_COMPUTE[kpi.computeKey];
    if (!fn) continue;
    const value = await fn(clubId, asOf);
    await prisma.kPIValue.upsert({
      where: { kpiId_periodLabel: { kpiId: kpi.id, periodLabel } },
      update: { value, asOfDate: asOf, computedAt: new Date() },
      create: { clubId, kpiId: kpi.id, periodLabel, asOfDate: asOf, value },
    });
    results.push({ kpiId: kpi.id, value });
    // Evaluate thresholds.
    const thresholds = await prisma.kPIThreshold.findMany({ where: { kpiId: kpi.id, isActive: true } });
    for (const t of thresholds) {
      const breached = evaluateThreshold(value, t.op, Number(t.threshold.toString()));
      if (breached) {
        await prisma.kPIAlert.create({
          data: { clubId, kpiId: kpi.id, thresholdId: t.id, periodLabel, observedValue: value, status: "OPEN" },
        });
      }
    }
  }
  return { periodLabel, kpiCount: results.length, results };
}

function evaluateThreshold(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case "GT": return value > threshold;
    case "GTE": return value >= threshold;
    case "LT": return value < threshold;
    case "LTE": return value <= threshold;
    case "EQ": return value === threshold;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Threshold management
// ---------------------------------------------------------------------------
export const thresholdSchema = z.object({
  kpiKey: z.string(),
  kind: z.enum(["WARNING", "CRITICAL"]).default("WARNING"),
  op: z.enum(["GT", "GTE", "LT", "LTE", "EQ"]),
  threshold: z.number(),
  notifyRoleKey: z.string().optional().nullable(),
  notifyUserId: z.string().optional().nullable(),
});

export async function upsertThreshold(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "kpi:write");
  const parsed = thresholdSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  const kpi = await prisma.kPI.findUnique({ where: { clubId_key: { clubId, key: d.kpiKey } } });
  if (!kpi) throw new ConflictError(`Unknown KPI ${d.kpiKey}`);
  return prisma.kPIThreshold.create({
    data: { clubId, kpiId: kpi.id, kind: d.kind, op: d.op, threshold: d.threshold, notifyRoleKey: d.notifyRoleKey ?? null, notifyUserId: d.notifyUserId ?? null },
  });
}

// ---------------------------------------------------------------------------
// Dashboard CRUD
// ---------------------------------------------------------------------------
export const dashboardSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  audience: z.enum(["GM", "CONTROLLER", "BOARD", "DEPARTMENT", "MEMBERSHIP", "INTERNAL"]).default("INTERNAL"),
});

export async function upsertDashboard(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "kpi:write");
  const parsed = dashboardSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);
  const d = parsed.data;
  return prisma.kPIDashboard.upsert({
    where: { clubId_key: { clubId, key: d.key } },
    update: { name: d.name, description: d.description ?? null, audience: d.audience, isActive: true },
    create: { clubId, key: d.key, name: d.name, description: d.description ?? null, audience: d.audience },
  });
}

export async function addWidget(principal: Principal, dashboardId: string, args: { kpiKey?: string; title: string; kind?: "STAT" | "TREND" | "TABLE" | "NARRATIVE"; sortOrder?: number; width?: "SM" | "MD" | "LG" | "XL"; configJson?: string }) {
  const dash = await prisma.kPIDashboard.findUnique({ where: { id: dashboardId } });
  assertTenantOwned(dash, principal);
  requirePermission(principal, dash.clubId, "kpi:write");
  const kpi = args.kpiKey ? await prisma.kPI.findUnique({ where: { clubId_key: { clubId: dash.clubId, key: args.kpiKey } } }) : null;
  return prisma.kPIWidget.create({
    data: { clubId: dash.clubId, dashboardId, kpiId: kpi?.id ?? null, title: args.title, kind: args.kind ?? "STAT", sortOrder: args.sortOrder ?? 0, width: args.width ?? "MD", configJson: args.configJson ?? null },
  });
}

export async function getDashboard(principal: Principal, clubId: string, dashboardKey: string) {
  requirePermission(principal, clubId, "kpi:read");
  const dash = await prisma.kPIDashboard.findUnique({
    where: { clubId_key: { clubId, key: dashboardKey } },
    include: {
      widgets: {
        orderBy: { sortOrder: "asc" },
        include: { kpi: { include: { values: { orderBy: { asOfDate: "desc" }, take: 12 }, thresholds: true } } },
      },
    },
  });
  return dash;
}

export async function listDashboards(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "kpi:read");
  return prisma.kPIDashboard.findMany({ where: tenantWhere(principal, clubId), orderBy: { name: "asc" } });
}

export async function listAlerts(principal: Principal, clubId: string, opts?: { status?: string }) {
  requirePermission(principal, clubId, "kpi:read");
  return prisma.kPIAlert.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : { status: "OPEN" }) },
    include: { kpi: true, threshold: true },
    orderBy: { raisedAt: "desc" },
    take: 100,
  });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
export const DEFAULT_KPIS = [
  { key: "cash_balance",  name: "Cash Balance",            kind: "FINANCIAL",   unit: "$",     computeKey: "cash_balance",  direction: "HIGHER_BETTER" },
  { key: "ar_over_60",    name: "AR Over 60 Days",         kind: "FINANCIAL",   unit: "$",     computeKey: "ar_over_60",    direction: "LOWER_BETTER" },
  { key: "ap_open_total", name: "AP Open Total",           kind: "FINANCIAL",   unit: "$",     computeKey: "ap_open_total", direction: "NEUTRAL" },
  { key: "active_members",name: "Active Members",          kind: "MEMBERSHIP",  unit: "count", computeKey: "active_members",direction: "HIGHER_BETTER" },
  { key: "waitlist_count",name: "Waitlist",                kind: "MEMBERSHIP",  unit: "count", computeKey: "waitlist_count",direction: "HIGHER_BETTER" },
  { key: "inventory_valuation", name: "Inventory Valuation", kind: "INVENTORY", unit: "$",     computeKey: "inventory_valuation", direction: "NEUTRAL" },
  { key: "active_employees", name: "Active Employees",     kind: "PAYROLL",     unit: "count", computeKey: "active_employees", direction: "NEUTRAL" },
  { key: "open_lessons",  name: "Open Lessons",            kind: "OPERATIONAL", unit: "count", computeKey: "open_lessons",  direction: "NEUTRAL" },
  { key: "collections_outstanding", name: "Open Collection Notices", kind: "COLLECTIONS", unit: "count", computeKey: "collections_outstanding", direction: "LOWER_BETTER" },
] as const;

export async function ensureDefaultKPIs(clubId: string) {
  for (const k of DEFAULT_KPIS) {
    await prisma.kPI.upsert({
      where: { clubId_key: { clubId, key: k.key } },
      update: { name: k.name, kind: k.kind, unit: k.unit, computeKey: k.computeKey, direction: k.direction, isActive: true },
      create: { clubId, key: k.key, name: k.name, kind: k.kind, unit: k.unit, computeKey: k.computeKey, direction: k.direction },
    });
  }
}

export const DEFAULT_DASHBOARDS = [
  { key: "gm", name: "General Manager", audience: "GM", widgets: ["cash_balance", "active_members", "ar_over_60", "ap_open_total", "open_lessons", "active_employees"] },
  { key: "controller", name: "Controller", audience: "CONTROLLER", widgets: ["cash_balance", "ar_over_60", "ap_open_total", "inventory_valuation", "collections_outstanding"] },
  { key: "board", name: "Board", audience: "BOARD", widgets: ["cash_balance", "active_members", "ar_over_60", "ap_open_total"] },
  { key: "membership", name: "Membership", audience: "MEMBERSHIP", widgets: ["active_members", "waitlist_count"] },
] as const;

export async function ensureDefaultDashboards(clubId: string) {
  for (const d of DEFAULT_DASHBOARDS) {
    const dash = await prisma.kPIDashboard.upsert({
      where: { clubId_key: { clubId, key: d.key } },
      update: { name: d.name, audience: d.audience, isSystem: true, isActive: true },
      create: { clubId, key: d.key, name: d.name, audience: d.audience, isSystem: true },
    });
    // Idempotent widget creation: only add if dashboard has no widgets yet.
    const existing = await prisma.kPIWidget.count({ where: { dashboardId: dash.id } });
    if (existing === 0) {
      for (let i = 0; i < d.widgets.length; i++) {
        const kpi = await prisma.kPI.findUnique({ where: { clubId_key: { clubId, key: d.widgets[i] } } });
        if (kpi) {
          await prisma.kPIWidget.create({
            data: { clubId, dashboardId: dash.id, kpiId: kpi.id, title: kpi.name, kind: "STAT", sortOrder: i, width: "MD" },
          });
        }
      }
    }
  }
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
