// AR (accounts-receivable) service.
//
// Posting model:
//   - Charges, Payments, and AccountAdjustments are append-only.
//   - Mistakes are corrected via void (same-day fix) or reverse (post a contra
//     row that offsets the original; the original remains POSTED for audit).
//   - After any write, MemberAccount denormalized fields are recomputed.
//
// UI must never compute balances. All balance reads come from MemberAccount
// (denormalized) or calculateAging() (live).

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "./tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { calculateAging } from "./aging";
import { postChargeToGl, postPaymentToGl, postAdjustmentToGl } from "../accounting/events";
import { assertPostingAllowed } from "../posting-guard";

// ---------- enums -----------------------------------------------------------
export const CHARGE_CATEGORIES = ["DUES", "PRO_SHOP", "FOOD_BEVERAGE", "EVENT", "FINANCING", "INITIATION_FEE", "CAPITAL_ASSESSMENT", "ADJUSTMENT", "OTHER"] as const;
export const PAYMENT_METHODS = ["CREDIT_CARD", "EFT", "CHEQUE", "CASH", "OTHER"] as const;
export const ADJUSTMENT_TYPES = ["CREDIT", "DEBIT", "WRITE_OFF", "REFUND", "TRANSFER"] as const;

// ---------- post a charge ---------------------------------------------------
export const postChargeSchema = z.object({
  description: z.string().trim().min(1).max(200),
  category: z.enum(CHARGE_CATEGORIES),
  amount: z.number().positive(),
  transactionDate: z.string().optional(),
  dueDate: z.string().optional(),
});

export async function postCharge(principal: Principal, memberId: string, raw: unknown) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, include: { account: true } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "ar:write");
  await assertPostingAllowed(principal, member.clubId, "ar.charge.post", "Member", memberId);
  if (!member.account) throw new ConflictError("Member has no AR account");
  const parsed = postChargeSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);

  const txDate = parsed.data.transactionDate ? new Date(parsed.data.transactionDate) : new Date();
  const dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : txDate;

  const charge = await prisma.charge.create({
    data: {
      clubId: member.clubId,
      memberId,
      accountId: member.account.id,
      description: parsed.data.description,
      category: parsed.data.category,
      amount: round2(parsed.data.amount),
      transactionDate: txDate,
      dueDate,
      status: "POSTED",
      postedByUserId: principal.id,
    },
  });
  await recomputeAccount(memberId);
  await audit(principal, {
    action: "ar.charge.post",
    entityType: "Charge",
    entityId: charge.id,
    clubId: member.clubId,
    after: charge,
  });
  // GL adapter (idempotent; no-op if no COA/period yet).
  try { await postChargeToGl(principal, charge.id); } catch (e) { console.error("[gl] postChargeToGl failed", e); }
  return charge;
}

// ---------- void / reverse a charge ----------------------------------------
export async function voidCharge(principal: Principal, chargeId: string, reason: string) {
  const charge = await prisma.charge.findUnique({ where: { id: chargeId }, include: { member: true } });
  assertTenantOwned(charge, principal);
  requirePermission(principal, charge.clubId, "ar:void");
  await assertPostingAllowed(principal, charge.clubId, "ar.charge.void", "Charge", chargeId);
  if (charge.status !== "POSTED") throw new ConflictError("Only POSTED charges can be voided");

  const updated = await prisma.charge.update({
    where: { id: chargeId },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: principal.id, voidReason: reason.trim() || null },
  });
  await recomputeAccount(charge.memberId);
  await audit(principal, {
    action: "ar.charge.void",
    entityType: "Charge",
    entityId: chargeId,
    clubId: charge.clubId,
    before: charge,
    after: updated,
    meta: { reason },
  });
  return updated;
}

export async function reverseCharge(principal: Principal, chargeId: string, reason: string) {
  const charge = await prisma.charge.findUnique({ where: { id: chargeId }, include: { member: { include: { account: true } } } });
  assertTenantOwned(charge, principal);
  requirePermission(principal, charge.clubId, "ar:void");
  await assertPostingAllowed(principal, charge.clubId, "ar.charge.reverse", "Charge", chargeId);
  if (charge.status === "VOIDED" || charge.status === "REVERSED") throw new ConflictError(`Charge is already ${charge.status}`);
  if (!charge.member.account) throw new ConflictError("Member has no AR account");
  if (charge.reversesId) throw new ConflictError("Cannot reverse a reversing entry");

  const contra = await prisma.$transaction(async (tx) => {
    const contra = await tx.charge.create({
      data: {
        clubId: charge.clubId,
        memberId: charge.memberId,
        accountId: charge.member.account!.id,
        description: `Reversal of: ${charge.description}`,
        category: charge.category,
        amount: -round2(charge.amount),
        transactionDate: new Date(),
        dueDate: charge.dueDate,
        status: "POSTED",
        postedByUserId: principal.id,
        reversesId: charge.id,
      },
    });
    await tx.charge.update({
      where: { id: charge.id },
      data: { status: "REVERSED" },
    });
    return contra;
  });
  await recomputeAccount(charge.memberId);
  await audit(principal, {
    action: "ar.charge.reverse",
    entityType: "Charge",
    entityId: charge.id,
    clubId: charge.clubId,
    before: charge,
    after: { ...charge, status: "REVERSED" },
    meta: { reason, contraId: contra.id },
  });
  return contra;
}

// ---------- post a payment --------------------------------------------------
export const postPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(PAYMENT_METHODS),
  paymentDate: z.string().optional(),
  paymentMethodId: z.string().optional().nullable(),
  processorRef: z.string().optional().nullable(),
  status: z.enum(["SUCCESS", "FAILED", "PENDING"]).default("SUCCESS"),
  failureReason: z.string().optional().nullable(),
});

export async function postPayment(principal: Principal, memberId: string, raw: unknown) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, include: { account: true } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "ar:write");
  await assertPostingAllowed(principal, member.clubId, "ar.payment.post", "Member", memberId);
  if (!member.account) throw new ConflictError("Member has no AR account");
  const parsed = postPaymentSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);

  const payment = await prisma.payment.create({
    data: {
      clubId: member.clubId,
      memberId,
      accountId: member.account.id,
      amount: round2(parsed.data.amount),
      method: parsed.data.method,
      paymentDate: parsed.data.paymentDate ? new Date(parsed.data.paymentDate) : new Date(),
      status: parsed.data.status,
      paymentMethodId: parsed.data.paymentMethodId ?? null,
      processorRef: parsed.data.processorRef ?? null,
      failureReason: parsed.data.failureReason ?? null,
      postedByUserId: principal.id,
    },
  });

  // FAILED payments don't reduce balance; we still recompute to refresh stamps.
  await recomputeAccount(memberId);
  await audit(principal, {
    action: parsed.data.status === "FAILED" ? "ar.payment.fail" : "ar.payment.post",
    entityType: "Payment",
    entityId: payment.id,
    clubId: member.clubId,
    after: payment,
  });
  if (parsed.data.status === "SUCCESS") {
    try { await postPaymentToGl(principal, payment.id); } catch (e) { console.error("[gl] postPaymentToGl failed", e); }
  }
  return payment;
}

export async function voidPayment(principal: Principal, paymentId: string, reason: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  assertTenantOwned(payment, principal);
  requirePermission(principal, payment.clubId, "ar:void");
  await assertPostingAllowed(principal, payment.clubId, "ar.payment.void", "Payment", paymentId);
  if (payment.status !== "SUCCESS") throw new ConflictError("Only SUCCESS payments can be voided");
  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: principal.id, voidReason: reason.trim() || null },
  });
  await recomputeAccount(payment.memberId);
  await audit(principal, {
    action: "ar.payment.void",
    entityType: "Payment",
    entityId: paymentId,
    clubId: payment.clubId,
    before: payment,
    after: updated,
    meta: { reason },
  });
  return updated;
}

// ---------- adjustments (credits / debits / write-offs / refunds) ----------
export const adjustmentSchema = z.object({
  type: z.enum(ADJUSTMENT_TYPES),
  amount: z.number().positive(),
  description: z.string().trim().min(1).max(200),
  category: z.string().trim().max(80).optional().nullable(),
  transactionDate: z.string().optional(),
});

export async function postAdjustment(principal: Principal, memberId: string, raw: unknown) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, include: { account: true } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "ar:adjust");
  await assertPostingAllowed(principal, member.clubId, "ar.adjustment.post", "Member", memberId);
  if (!member.account) throw new ConflictError("Member has no AR account");
  const parsed = adjustmentSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);

  const adj = await prisma.accountAdjustment.create({
    data: {
      clubId: member.clubId,
      memberId,
      accountId: member.account.id,
      type: parsed.data.type,
      amount: round2(parsed.data.amount),
      description: parsed.data.description,
      category: parsed.data.category ?? null,
      transactionDate: parsed.data.transactionDate ? new Date(parsed.data.transactionDate) : new Date(),
      status: "POSTED",
      postedByUserId: principal.id,
    },
  });
  await recomputeAccount(memberId);
  await audit(principal, {
    action: "ar.adjustment.post",
    entityType: "AccountAdjustment",
    entityId: adj.id,
    clubId: member.clubId,
    after: adj,
  });
  try { await postAdjustmentToGl(principal, adj.id); } catch (e) { console.error("[gl] postAdjustmentToGl failed", e); }
  return adj;
}

export async function voidAdjustment(principal: Principal, id: string, reason: string) {
  const adj = await prisma.accountAdjustment.findUnique({ where: { id } });
  assertTenantOwned(adj, principal);
  requirePermission(principal, adj.clubId, "ar:void");
  await assertPostingAllowed(principal, adj.clubId, "ar.adjustment.void", "AccountAdjustment", id);
  if (adj.status !== "POSTED") throw new ConflictError("Only POSTED adjustments can be voided");
  const updated = await prisma.accountAdjustment.update({
    where: { id },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: principal.id, voidReason: reason.trim() || null },
  });
  await recomputeAccount(adj.memberId);
  await audit(principal, {
    action: "ar.adjustment.void",
    entityType: "AccountAdjustment",
    entityId: id,
    clubId: adj.clubId,
    before: adj,
    after: updated,
    meta: { reason },
  });
  return updated;
}

// ---------- recompute denormalized account totals ---------------------------
// Single source of truth for `MemberAccount.*Balance` fields.
export async function recomputeAccount(memberId: string): Promise<void> {
  const [charges, payments, adjustments, lastSuccessPayment] = await Promise.all([
    prisma.charge.findMany({ where: { memberId } }),
    prisma.payment.findMany({ where: { memberId } }),
    prisma.accountAdjustment.findMany({ where: { memberId } }),
    prisma.payment.findFirst({ where: { memberId, status: "SUCCESS" }, orderBy: { paymentDate: "desc" } }),
  ]);

  const aging = calculateAging({
    charges: charges.map((c) => ({ id: c.id, amount: c.amount, dueDate: c.dueDate, transactionDate: c.transactionDate, status: c.status, reversesId: c.reversesId })),
    payments: payments.map((p) => ({ id: p.id, amount: p.amount, paymentDate: p.paymentDate, status: p.status, reversesId: p.reversesId })),
    adjustments: adjustments.map((a) => ({ id: a.id, amount: a.amount, type: a.type, transactionDate: a.transactionDate, status: a.status })),
  });

  await prisma.memberAccount.update({
    where: { memberId },
    data: {
      currentBalance: aging.buckets.current,
      thirtyDayBalance: aging.buckets.d30,
      sixtyDayBalance: aging.buckets.d60,
      ninetyDayBalance: aging.buckets.d90,
      oneTwentyDayBalance: aging.buckets.d120,
      creditBalance: aging.creditBalance,
      lastPaymentDate: lastSuccessPayment?.paymentDate ?? null,
      lastRecomputedAt: new Date(),
    },
  });
}

// ---------- account notes ---------------------------------------------------
export async function addAccountNote(principal: Principal, memberId: string, body: string, pinned = false) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "ar:notes:write");
  if (!body.trim()) throw new ValidationError([{ path: "body", message: "Note cannot be empty" }]);
  const note = await prisma.accountNote.create({
    data: { clubId: member.clubId, memberId, body: body.trim(), pinned, authorUserId: principal.id },
  });
  await audit(principal, {
    action: "ar.note.add",
    entityType: "AccountNote",
    entityId: note.id,
    clubId: member.clubId,
    after: note,
  });
  return note;
}

// ---------- payment promises -----------------------------------------------
export async function recordPaymentPromise(
  principal: Principal,
  memberId: string,
  raw: { promisedAmount: number; promisedDate: string; notes?: string }
) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "collections:work");
  if (!Number.isFinite(raw.promisedAmount) || raw.promisedAmount <= 0) {
    throw new ValidationError([{ path: "promisedAmount", message: "Must be positive" }]);
  }
  const promise = await prisma.paymentPromise.create({
    data: {
      clubId: member.clubId,
      memberId,
      promisedAmount: round2(raw.promisedAmount),
      promisedDate: new Date(raw.promisedDate),
      notes: raw.notes ?? null,
      recordedByUserId: principal.id,
      status: "ACTIVE",
    },
  });
  await audit(principal, {
    action: "ar.promise.record",
    entityType: "PaymentPromise",
    entityId: promise.id,
    clubId: member.clubId,
    after: promise,
  });
  return promise;
}

export async function resolvePaymentPromise(
  principal: Principal,
  promiseId: string,
  status: "KEPT" | "BROKEN" | "CANCELLED"
) {
  const promise = await prisma.paymentPromise.findUnique({ where: { id: promiseId } });
  assertTenantOwned(promise, principal);
  requirePermission(principal, promise.clubId, "collections:work");
  const updated = await prisma.paymentPromise.update({
    where: { id: promiseId },
    data: { status, resolvedAt: new Date() },
  });
  await audit(principal, {
    action: "ar.promise.resolve",
    entityType: "PaymentPromise",
    entityId: promiseId,
    clubId: promise.clubId,
    before: promise,
    after: updated,
  });
  return updated;
}

// ---------- helpers ---------------------------------------------------------
function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
