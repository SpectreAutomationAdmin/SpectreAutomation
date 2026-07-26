// Payment batch service.
//
// Flow:
//   createBatch(name, paymentDate, bankAccount, method)
//     → addInvoiceToBatch(batch, invoiceId, amount)     (status: PENDING)
//     → submitForApproval (creates ApprovalRequest)
//     → finalizeApprovalState (advances to APPROVED when quorum reached)
//     → processBatch — iterates items, creates VendorPayments, posts to GL
//
// Excludes:
//   - blocked vendors
//   - invoices not in POSTED / PARTIALLY_PAID
//   - vendors without VERIFIED & active banking when batch.method === EFT
//
// A single item may not exceed the invoice's outstanding balance. Multiple
// batches can target the same invoice but `amountPaid` is updated through
// the payment service so overpayment is structurally prevented.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, ValidationError } from "../errors";
import { toMoney, sumMoney } from "../accounting/decimal";
import { submitForApproval, getRequestForEntity, isApproved } from "./approvals";
import { processPayment } from "./payments";

async function nextBatchNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.paymentBatch.count({ where: { clubId, createdAt: { gte: new Date(year, 0, 1) } } });
  return `BATCH-${year}-${(count + 1).toString().padStart(4, "0")}`;
}

export const batchCreateSchema = z.object({
  description: z.string().trim().min(1).max(200),
  paymentDate: z.string().or(z.date()),
  bankAccountNumber: z.string().trim().max(40).default("1010"),
  paymentMethod: z.enum(["EFT", "CHEQUE"]).default("EFT"),
  currency: z.string().trim().max(8).default("CAD"),
});

export async function createBatch(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "ap:payment:create");
  const parsed = batchCreateSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const bankAccount = await prisma.account.findFirst({ where: { clubId, accountNumber: parsed.data.bankAccountNumber } });
  if (!bankAccount) throw new ConflictError(`Unknown bank account ${parsed.data.bankAccountNumber}`);
  const batchNumber = await nextBatchNumber(clubId);
  const created = await prisma.paymentBatch.create({
    data: {
      clubId,
      batchNumber,
      description: parsed.data.description,
      paymentDate: new Date(parsed.data.paymentDate),
      bankAccountId: bankAccount.id,
      paymentMethod: parsed.data.paymentMethod,
      currency: parsed.data.currency,
      status: "DRAFT",
      createdByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "ap.batch.create",
    entityType: "PaymentBatch", entityId: created.id, clubId,
    after: { batchNumber, paymentMethod: parsed.data.paymentMethod, paymentDate: parsed.data.paymentDate },
  });
  return created;
}

// Add an invoice to a draft batch. Re-runs eligibility checks.
export const addItemSchema = z.object({
  invoiceId: z.string(),
  amount: z.number().positive(),
});

export async function addItem(principal: Principal, batchId: string, raw: unknown) {
  const batch = await prisma.paymentBatch.findUnique({ where: { id: batchId } });
  assertTenantOwned(batch, principal);
  requirePermission(principal, batch.clubId, "ap:payment:create");
  if (batch.status !== "DRAFT") throw new ConflictError(`Batch is ${batch.status}`);
  const parsed = addItemSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));

  const inv = await prisma.aPInvoice.findUnique({
    where: { id: parsed.data.invoiceId },
    include: { vendor: true },
  });
  if (!inv || inv.clubId !== batch.clubId) throw new ConflictError("Invoice not found");
  if (inv.vendor.status === "BLOCKED") throw new ConflictError("Vendor is BLOCKED");
  if (inv.status !== "POSTED" && inv.status !== "PARTIALLY_PAID") {
    throw new ConflictError(`Invoice is ${inv.status} — must be POSTED to include in a batch`);
  }
  if (batch.paymentMethod === "EFT") {
    const banking = await prisma.vendorBankingProfile.findFirst({
      where: { vendorId: inv.vendorId, status: "VERIFIED", isActive: true },
    });
    if (!banking) throw new ConflictError(`Vendor has no VERIFIED banking — cannot include in EFT batch`);
  }

  const outstanding = Number(inv.total.toString()) - Number(inv.amountPaid.toString());
  // Subtract amounts that other PENDING batch items have already earmarked.
  const earmarked = await prisma.paymentBatchItem.aggregate({
    where: { invoiceId: inv.id, status: "PENDING", batchId: { not: batchId } },
    _sum: { amount: true },
  });
  const earmarkedAmount = earmarked._sum.amount ? Number(earmarked._sum.amount.toString()) : 0;
  const available = outstanding - earmarkedAmount;
  if (parsed.data.amount > available + 0.005) {
    throw new ConflictError(`Amount exceeds available ${available.toFixed(2)} (outstanding ${outstanding.toFixed(2)} minus earmarked ${earmarkedAmount.toFixed(2)})`);
  }

  const item = await prisma.paymentBatchItem.create({
    data: {
      clubId: batch.clubId, batchId, invoiceId: inv.id,
      amount: toMoney(parsed.data.amount), status: "PENDING",
    },
  });
  // Recompute batch total.
  const items = await prisma.paymentBatchItem.findMany({ where: { batchId, status: { in: ["PENDING", "PROCESSED"] } } });
  const total = sumMoney(items.map((i) => i.amount as unknown as number));
  await prisma.paymentBatch.update({ where: { id: batchId }, data: { totalAmount: total } });
  await audit(principal, {
    action: "ap.batch.add_item",
    entityType: "PaymentBatch", entityId: batchId, clubId: batch.clubId,
    after: { invoiceId: inv.id, amount: parsed.data.amount, total: total.toString() },
  });
  return item;
}

export async function removeItem(principal: Principal, itemId: string) {
  const item = await prisma.paymentBatchItem.findUnique({ where: { id: itemId }, include: { batch: true } });
  assertTenantOwned(item, principal);
  requirePermission(principal, item.clubId, "ap:payment:create");
  if (item.batch.status !== "DRAFT") throw new ConflictError(`Batch is ${item.batch.status}`);
  await prisma.paymentBatchItem.delete({ where: { id: itemId } });
  const items = await prisma.paymentBatchItem.findMany({ where: { batchId: item.batchId, status: { in: ["PENDING", "PROCESSED"] } } });
  const total = sumMoney(items.map((i) => i.amount as unknown as number));
  await prisma.paymentBatch.update({ where: { id: item.batchId }, data: { totalAmount: total } });
  await audit(principal, {
    action: "ap.batch.remove_item",
    entityType: "PaymentBatchItem", entityId: itemId, clubId: item.clubId,
    meta: { batchId: item.batchId, removedAmount: item.amount.toString() },
  });
}

export async function submitBatchForApproval(principal: Principal, batchId: string) {
  const batch = await prisma.paymentBatch.findUnique({ where: { id: batchId }, include: { items: true } });
  assertTenantOwned(batch, principal);
  requirePermission(principal, batch.clubId, "ap:payment:create");
  if (batch.status !== "DRAFT") throw new ConflictError(`Batch is ${batch.status}`);
  if (batch.items.length === 0) throw new ConflictError("Batch is empty");

  await submitForApproval(principal, batch.clubId, "PAYMENT_BATCH", batchId, Number(batch.totalAmount.toString()));
  const updated = await prisma.paymentBatch.update({
    where: { id: batchId },
    data: { status: "PENDING_APPROVAL" },
  });
  await audit(principal, {
    action: "ap.batch.submit",
    entityType: "PaymentBatch", entityId: batchId, clubId: batch.clubId,
    before: { status: "DRAFT" }, after: { status: "PENDING_APPROVAL" },
  });
  return updated;
}

export async function finalizeApprovalState(principal: Principal, batchId: string) {
  const batch = await prisma.paymentBatch.findUnique({ where: { id: batchId } });
  assertTenantOwned(batch, principal);
  if (batch.status !== "PENDING_APPROVAL") return batch;
  const req = await getRequestForEntity(batch.clubId, "PAYMENT_BATCH", batchId);
  if (!isApproved(req)) return batch;
  const updated = await prisma.paymentBatch.update({ where: { id: batchId }, data: { status: "APPROVED" } });
  await audit(principal, {
    action: "ap.batch.approved",
    entityType: "PaymentBatch", entityId: batchId, clubId: batch.clubId,
    after: { status: "APPROVED" },
  });
  return updated;
}

// Process the batch: for each PENDING item, create + post a VendorPayment.
export async function processBatch(principal: Principal, batchId: string) {
  const batch = await prisma.paymentBatch.findUnique({
    where: { id: batchId },
    include: { items: { include: { invoice: { include: { vendor: true } } } } },
  });
  assertTenantOwned(batch, principal);
  requirePermission(principal, batch.clubId, "ap:payment:process");

  if (batch.status === "PROCESSED") return batch;
  if (batch.status !== "APPROVED") {
    // Try to advance from PENDING_APPROVAL if approvals are now done.
    if (batch.status === "PENDING_APPROVAL") {
      const advanced = await finalizeApprovalState(principal, batchId);
      if (advanced.status !== "APPROVED" && !hasPermission(principal, batch.clubId, "ap:exception:override")) {
        throw new ConflictError("Batch is not APPROVED");
      }
    } else {
      throw new ConflictError(`Batch is ${batch.status} — cannot process`);
    }
  }

  await prisma.paymentBatch.update({ where: { id: batchId }, data: { status: "PROCESSING" } });

  let processed = 0, failed = 0;
  for (const item of batch.items) {
    if (item.status !== "PENDING") continue;
    try {
      // Re-check EFT banking eligibility at process time.
      if (batch.paymentMethod === "EFT") {
        const banking = await prisma.vendorBankingProfile.findFirst({
          where: { vendorId: item.invoice.vendorId, status: "VERIFIED", isActive: true },
        });
        if (!banking) {
          await prisma.paymentBatchItem.update({
            where: { id: item.id }, data: { status: "EXCLUDED", notes: "Banking not verified at processing time" },
          });
          failed++;
          continue;
        }
      }
      const payment = await processPayment(principal, {
        clubId: batch.clubId,
        invoiceId: item.invoiceId,
        vendorId: item.invoice.vendorId,
        amount: Number(item.amount.toString()),
        paymentDate: batch.paymentDate,
        method: batch.paymentMethod as "EFT" | "CHEQUE",
        processorRef: null,
        batchId: batch.id,
      });
      await prisma.paymentBatchItem.update({
        where: { id: item.id },
        data: { status: "PROCESSED", paymentId: payment.id },
      });
      processed++;
    } catch (err) {
      await prisma.paymentBatchItem.update({
        where: { id: item.id },
        data: { status: "FAILED", notes: (err as Error).message },
      });
      failed++;
    }
  }

  const updated = await prisma.paymentBatch.update({
    where: { id: batchId },
    data: { status: "PROCESSED", processedAt: new Date(), processedByUserId: principal.id },
  });
  await audit(principal, {
    action: "ap.batch.process",
    entityType: "PaymentBatch", entityId: batchId, clubId: batch.clubId,
    after: { status: "PROCESSED", processed, failed },
  });
  return updated;
}

// Reads.
export async function listBatches(principal: Principal, clubId: string, opts?: { status?: string }) {
  return prisma.paymentBatch.findMany({
    where: { ...tenantWhere(principal, clubId), ...(opts?.status ? { status: opts.status } : {}) },
    include: { items: true, bankAccount: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function getBatch(principal: Principal, batchId: string) {
  const batch = await prisma.paymentBatch.findUnique({
    where: { id: batchId },
    include: {
      items: { include: { invoice: { include: { vendor: true } }, payment: true } },
      bankAccount: true,
      payments: { include: { vendor: true, postedJournalEntry: true } },
    },
  });
  if (!batch) throw new ConflictError("Batch not found");
  assertTenantOwned(batch, principal);
  return batch;
}

// "Suggest invoices due" — list POSTED invoices with outstanding balance, in
// due-date order, excluding blocked vendors and (for EFT) unverified banking.
export async function suggestInvoicesForBatch(clubId: string, opts: { paymentMethod: "EFT" | "CHEQUE"; asOf?: Date }) {
  const asOf = opts.asOf ?? new Date();
  const candidates = await prisma.aPInvoice.findMany({
    where: {
      clubId,
      status: { in: ["POSTED", "PARTIALLY_PAID"] },
      dueDate: { lte: new Date(asOf.getTime() + 14 * 86400000) }, // due within 14 days
    },
    include: { vendor: { include: { bankingProfiles: { where: { isActive: true, status: "VERIFIED" } } } } },
    orderBy: { dueDate: "asc" },
  });
  return candidates.filter((c) => {
    if (c.vendor.status === "BLOCKED") return false;
    if (opts.paymentMethod === "EFT" && c.vendor.bankingProfiles.length === 0) return false;
    return true;
  });
}
