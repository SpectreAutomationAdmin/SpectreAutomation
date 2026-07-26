// Vendor payment service. Direct-pay (one-off) lives here; batch processing
// in payment-batches.ts uses these primitives.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, ValidationError } from "../errors";
import { toMoney } from "../accounting/decimal";
import { postPaymentToGl } from "./ap-events";
import { assertPostingAllowed } from "../posting-guard";

async function nextPaymentNumber(clubId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.vendorPayment.count({ where: { clubId, createdAt: { gte: new Date(year, 0, 1) } } });
  return `APPAY-${year}-${(count + 1).toString().padStart(6, "0")}`;
}

export const directPaymentSchema = z.object({
  invoiceId: z.string(),
  amount: z.number().positive(),
  paymentDate: z.string().or(z.date()).optional(),
  method: z.enum(["EFT", "CHEQUE", "CC", "CASH", "OTHER"]).default("EFT"),
  processorRef: z.string().trim().max(120).optional().nullable(),
});

// Create a PENDING payment and immediately process it (post to GL + update
// invoice balances). Use this for one-off direct pays; batch flow calls the
// `processPayment` step independently.
export async function payInvoice(principal: Principal, raw: unknown) {
  const parsed = directPaymentSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));

  const inv = await prisma.aPInvoice.findUnique({ where: { id: parsed.data.invoiceId }, include: { vendor: true } });
  assertTenantOwned(inv, principal);
  requirePermission(principal, inv.clubId, "ap:payment:process");
  await assertPostingAllowed(principal, inv.clubId, "ap.payment.pay", "APInvoice", inv.id);
  if (inv.status !== "POSTED" && inv.status !== "PARTIALLY_PAID") {
    throw new ConflictError(`Invoice is ${inv.status} — must be POSTED to pay`);
  }
  if (inv.vendor.status === "BLOCKED") throw new ConflictError("Vendor is BLOCKED");

  const outstanding = Number(inv.total.toString()) - Number(inv.amountPaid.toString());
  if (parsed.data.amount > outstanding + 0.005) {
    throw new ConflictError(`Payment exceeds outstanding balance ${outstanding.toFixed(2)}`);
  }

  // EFT requires a verified, active vendor banking profile.
  if (parsed.data.method === "EFT") {
    const banking = await prisma.vendorBankingProfile.findFirst({
      where: { vendorId: inv.vendorId, status: "VERIFIED", isActive: true },
    });
    if (!banking) throw new ConflictError("Vendor has no VERIFIED & active banking profile for EFT");
  }

  return await processPayment(principal, {
    clubId: inv.clubId,
    invoiceId: inv.id,
    vendorId: inv.vendorId,
    amount: parsed.data.amount,
    paymentDate: parsed.data.paymentDate ? new Date(parsed.data.paymentDate) : new Date(),
    method: parsed.data.method,
    processorRef: parsed.data.processorRef ?? null,
    batchId: null,
  });
}

// Internal: process a payment in PENDING → PROCESSED, post to GL, advance
// the invoice's amountPaid + status.
export async function processPayment(
  principal: Principal,
  args: {
    clubId: string;
    invoiceId: string;
    vendorId: string;
    amount: number;
    paymentDate: Date;
    method: "EFT" | "CHEQUE" | "CC" | "CASH" | "OTHER";
    processorRef: string | null;
    batchId: string | null;
  }
) {
  await assertPostingAllowed(principal, args.clubId, "ap.payment.process", "APInvoice", args.invoiceId);
  const paymentNumber = await nextPaymentNumber(args.clubId);
  const created = await prisma.vendorPayment.create({
    data: {
      clubId: args.clubId,
      vendorId: args.vendorId,
      invoiceId: args.invoiceId,
      batchId: args.batchId,
      paymentNumber,
      paymentDate: args.paymentDate,
      method: args.method,
      amount: toMoney(args.amount),
      processorRef: args.processorRef,
      status: "PENDING",
      createdByUserId: principal.id,
    },
  });
  const journal = await postPaymentToGl(principal, created.id);
  const updated = await prisma.vendorPayment.update({
    where: { id: created.id },
    data: { status: "PROCESSED", postedJournalEntryId: journal.id },
  });
  // Update invoice balance.
  const inv = await prisma.aPInvoice.findUnique({ where: { id: args.invoiceId } });
  if (inv) {
    const newPaid = Math.round((Number(inv.amountPaid.toString()) + args.amount) * 100) / 100;
    const total = Number(inv.total.toString());
    const fullyPaid = newPaid >= total - 0.005;
    await prisma.aPInvoice.update({
      where: { id: args.invoiceId },
      data: { amountPaid: newPaid, status: fullyPaid ? "PAID" : "PARTIALLY_PAID" },
    });
  }
  await audit(principal, {
    action: "ap.payment.process",
    entityType: "VendorPayment", entityId: created.id, clubId: args.clubId,
    after: { paymentNumber, amount: args.amount, status: "PROCESSED", journalEntryId: journal.id },
  });
  return updated;
}

export async function voidPayment(principal: Principal, paymentId: string, reason: string) {
  const payment = await prisma.vendorPayment.findUnique({ where: { id: paymentId } });
  assertTenantOwned(payment, principal);
  requirePermission(principal, payment.clubId, "ap:invoice:void");
  await assertPostingAllowed(principal, payment.clubId, "ap.payment.void", "VendorPayment", paymentId);
  if (payment.status !== "PROCESSED") throw new ConflictError(`Payment is ${payment.status}`);

  // Reverse the GL entry by reversing through the engine.
  // For simplicity in Phase 4 we mark the payment VOIDED and back out the
  // invoice balance. The accompanying JE reversal is created via the journal
  // engine's reverse() — but we keep that path one-shot here to avoid a
  // dependency cycle; call the same path from a controller action.
  const { reverse } = await import("../accounting/journal");
  if (payment.postedJournalEntryId) {
    await reverse(principal, payment.postedJournalEntryId, { reason: `Void payment ${payment.paymentNumber}: ${reason}` });
  }
  const updated = await prisma.vendorPayment.update({
    where: { id: paymentId },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: principal.id, voidReason: reason },
  });
  // Roll back the invoice's amountPaid.
  if (payment.invoiceId) {
    const inv = await prisma.aPInvoice.findUnique({ where: { id: payment.invoiceId } });
    if (inv) {
      const newPaid = Math.max(0, Math.round((Number(inv.amountPaid.toString()) - Number(payment.amount.toString())) * 100) / 100);
      const total = Number(inv.total.toString());
      const status = newPaid >= total - 0.005 ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "POSTED";
      await prisma.aPInvoice.update({ where: { id: payment.invoiceId }, data: { amountPaid: newPaid, status } });
    }
  }
  await audit(principal, {
    action: "ap.payment.void",
    entityType: "VendorPayment", entityId: paymentId, clubId: payment.clubId,
    before: { status: "PROCESSED" }, after: { status: "VOIDED" }, meta: { reason },
  });
  return updated;
}
