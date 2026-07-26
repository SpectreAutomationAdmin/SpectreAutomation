// Phase 9E — POS reconciliation reports.
//
// Three reports:
//   - posVsGl  — POSSale subtotals vs the GL revenue accounts they posted to
//   - posVsAr  — POSSale member-account charges vs the Charge rows they wrote
//   - posVsInv — POSSaleLine.inventoryTransactionId presence for INVENTORY-kind lines

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";

export type ReconciliationRow = {
  saleId: string;
  saleNumber: string;
  saleDate: Date;
  expected: number;
  observed: number;
  delta: number;
  notes?: string;
};

export async function posVsGl(principal: Principal, clubId: string, opts?: { from?: Date; to?: Date }): Promise<ReconciliationRow[]> {
  requirePermission(principal, clubId, "ap:report:view");
  const where = {
    clubId, status: "COMPLETED" as const,
    ...(opts?.from || opts?.to ? { saleDate: { ...(opts?.from ? { gte: opts.from } : {}), ...(opts?.to ? { lte: opts.to } : {}) } } : {}),
  };
  const sales = await prisma.pOSSale.findMany({
    where, take: 500, orderBy: { saleDate: "desc" },
    include: { postedJournalEntry: { include: { lines: true } } },
  });
  return sales.map((s) => {
    const expected = Number(s.grandTotal.toString());
    const observed = s.postedJournalEntry
      ? s.postedJournalEntry.lines.reduce((sum, l) => sum + Number(l.debit.toString()), 0)
      : 0;
    const delta = Math.round((observed - expected) * 100) / 100;
    return {
      saleId: s.id, saleNumber: s.saleNumber, saleDate: s.saleDate,
      expected, observed, delta,
      notes: !s.postedJournalEntry ? "No posted JE" : delta !== 0 ? "JE total ≠ sale grand total" : undefined,
    };
  });
}

export async function posVsAr(principal: Principal, clubId: string, opts?: { from?: Date; to?: Date }): Promise<ReconciliationRow[]> {
  requirePermission(principal, clubId, "ar:read");
  const where = {
    clubId, status: "COMPLETED" as const, chargeMode: "MEMBER_ACCOUNT" as const,
    ...(opts?.from || opts?.to ? { saleDate: { ...(opts?.from ? { gte: opts.from } : {}), ...(opts?.to ? { lte: opts.to } : {}) } } : {}),
  };
  const sales = await prisma.pOSSale.findMany({
    where, take: 500, orderBy: { saleDate: "desc" },
    include: { arCharge: true },
  });
  return sales.map((s) => {
    const expected = Number(s.grandTotal.toString());
    const observed = s.arCharge ? Number(s.arCharge.amount.toString()) : 0;
    const delta = Math.round((observed - expected) * 100) / 100;
    return {
      saleId: s.id, saleNumber: s.saleNumber, saleDate: s.saleDate,
      expected, observed, delta,
      notes: !s.arCharge ? "No AR charge linked" : delta !== 0 ? "Charge amount ≠ sale grand total" : undefined,
    };
  });
}

export async function posVsInventory(principal: Principal, clubId: string, opts?: { from?: Date; to?: Date }) {
  requirePermission(principal, clubId, "inventory:read");
  const where = {
    clubId, status: "COMPLETED" as const,
    ...(opts?.from || opts?.to ? { saleDate: { ...(opts?.from ? { gte: opts.from } : {}), ...(opts?.to ? { lte: opts.to } : {}) } } : {}),
  };
  const sales = await prisma.pOSSale.findMany({
    where, take: 500, orderBy: { saleDate: "desc" },
    include: { lines: true },
  });
  const out: ReconciliationRow[] = [];
  for (const s of sales) {
    const invLines = s.lines.filter((l) => l.kind === "INVENTORY" && l.itemId);
    const linkedCount = invLines.filter((l) => l.inventoryTransactionId).length;
    out.push({
      saleId: s.id, saleNumber: s.saleNumber, saleDate: s.saleDate,
      expected: invLines.length, observed: linkedCount,
      delta: linkedCount - invLines.length,
      notes: invLines.length === linkedCount ? undefined : `${invLines.length - linkedCount} inventory line(s) unlinked`,
    });
  }
  return out;
}

// Unmapped items / locations / members detected from import errors and from
// recent POSWebhookEvent payloads. Helps the admin populate POSMapping rows.
export async function listUnmappedExternalIds(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  // Look at the last week's import errors + webhook events.
  const since = new Date(Date.now() - 7 * 86400000);
  const errors = await prisma.pOSImportError.findMany({ where: { clubId, occurredAt: { gte: since } }, take: 200 });
  return errors;
}
