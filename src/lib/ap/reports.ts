// AP aging + vendor balance + AP-to-GL reconciliation.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { accountBalances } from "../accounting/balance";
import { sumMoney, toMoney } from "../accounting/decimal";

const DAY = 86400000;

export type APAgingRow = {
  vendorId: string;
  vendorName: string;
  current: Prisma.Decimal;
  d30: Prisma.Decimal;
  d60: Prisma.Decimal;
  d90: Prisma.Decimal;
  d120: Prisma.Decimal;
  total: Prisma.Decimal;
};

export type APAgingResult = {
  asOf: Date;
  rows: APAgingRow[];
  totals: { current: Prisma.Decimal; d30: Prisma.Decimal; d60: Prisma.Decimal; d90: Prisma.Decimal; d120: Prisma.Decimal; total: Prisma.Decimal };
};

export async function apAging(clubId: string, asOf: Date = new Date()): Promise<APAgingResult> {
  const invoices = await prisma.aPInvoice.findMany({
    where: { clubId, status: { in: ["POSTED", "PARTIALLY_PAID"] } },
    include: { vendor: true },
  });

  const byVendor = new Map<string, APAgingRow>();
  for (const inv of invoices) {
    const outstanding = toMoney(inv.total).minus(toMoney(inv.amountPaid));
    if (outstanding.lte(0)) continue;
    const dueDate = inv.dueDate ?? inv.invoiceDate;
    const ageDays = Math.floor((asOf.getTime() - dueDate.getTime()) / DAY);
    const bucketKey: keyof Omit<APAgingRow, "vendorId" | "vendorName" | "total"> =
      ageDays < 1   ? "current" :
      ageDays < 30  ? "current" :
      ageDays < 60  ? "d30" :
      ageDays < 90  ? "d60" :
      ageDays < 120 ? "d90" : "d120";

    const row = byVendor.get(inv.vendorId) ?? {
      vendorId: inv.vendorId,
      vendorName: inv.vendor.legalName,
      current: toMoney(0), d30: toMoney(0), d60: toMoney(0), d90: toMoney(0), d120: toMoney(0),
      total: toMoney(0),
    };
    row[bucketKey] = (row[bucketKey] as Prisma.Decimal).plus(outstanding);
    row.total = row.total.plus(outstanding);
    byVendor.set(inv.vendorId, row);
  }

  const rows = Array.from(byVendor.values()).sort((a, b) => b.total.cmp(a.total));
  const totals = {
    current: sumMoney(rows.map((r) => r.current)),
    d30: sumMoney(rows.map((r) => r.d30)),
    d60: sumMoney(rows.map((r) => r.d60)),
    d90: sumMoney(rows.map((r) => r.d90)),
    d120: sumMoney(rows.map((r) => r.d120)),
    total: sumMoney(rows.map((r) => r.total)),
  };
  return { asOf, rows, totals };
}

// AP subledger total = sum of (invoice.total - invoice.amountPaid) across
// POSTED/PARTIALLY_PAID invoices. GL AP control balance = 2010's signed
// balance (CR-natural, so the AP control account's normal "positive" balance
// shows as a credit in the trial balance).
export async function reconcileApToGl(clubId: string) {
  const aging = await apAging(clubId);
  const subledgerTotal = aging.totals.total;
  const balances = await accountBalances(clubId, {});
  const control = balances.find((b) => b.accountNumber === "2010");
  const glControlNatural = control?.naturalBalance ?? toMoney(0);
  const diff = subledgerTotal.minus(glControlNatural);
  return {
    subledgerTotal,
    glControlNatural,
    diff,
    isBalanced: diff.abs().lte(toMoney("0.01")),
  };
}

// Dashboard summary stats.
export async function apDashboardStats(clubId: string) {
  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * DAY);
  const [outstanding, awaitingApproval, dueThisWeek, overdue, batchesAwaiting, vendorsAwaiting, openCaptures, exceptions] = await Promise.all([
    prisma.aPInvoice.aggregate({
      where: { clubId, status: { in: ["POSTED", "PARTIALLY_PAID"] } },
      _sum: { total: true, amountPaid: true },
    }),
    prisma.aPInvoice.count({ where: { clubId, status: "PENDING_APPROVAL" } }),
    prisma.aPInvoice.count({ where: { clubId, status: { in: ["POSTED", "PARTIALLY_PAID"] }, dueDate: { lte: weekOut } } }),
    prisma.aPInvoice.count({ where: { clubId, status: { in: ["POSTED", "PARTIALLY_PAID"] }, dueDate: { lt: now } } }),
    prisma.paymentBatch.count({ where: { clubId, status: "PENDING_APPROVAL" } }),
    prisma.vendor.count({ where: { clubId, status: "PENDING_APPROVAL" } }),
    prisma.receiptCapture.count({ where: { clubId, status: { in: ["NEW", "NEEDS_REVIEW"] } } }),
    prisma.aPException.count({ where: { clubId, status: "OPEN" } }),
  ]);
  const outstandingTotal = outstanding._sum.total
    ? toMoney(outstanding._sum.total).minus(toMoney(outstanding._sum.amountPaid ?? 0))
    : toMoney(0);
  return {
    outstandingTotal,
    awaitingApproval,
    dueThisWeek,
    overdue,
    batchesAwaiting,
    vendorsAwaiting,
    openCaptures,
    openExceptions: exceptions,
  };
}
