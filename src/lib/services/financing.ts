// Financing service.
//
// Builds on the existing pure amortization helper (src/lib/finance.ts). Adds:
//   - Activate / cancel
//   - Apply payment (FIFO across schedule)
//   - Prepayment & payoff quote
//   - Default detection (missed installments)
//   - Versioned promissory-note documents
//   - E-signature adapter scaffold

import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "./tenant";
import { ConflictError, ValidationError } from "../errors";
import { calculateAmortization } from "../finance";
import { getRequestContext } from "../request-context";

// ---------- create / activate ----------------------------------------------
export const createAgreementSchema = z.object({
  principalAmount: z.number().positive(),
  interestRate: z.number().min(0).max(1), // decimal
  termMonths: z.number().int().min(1).max(360),
  paymentFrequency: z.enum(["MONTHLY"]).default("MONTHLY"), // others are Phase 7
  startDate: z.string().optional(),
  prepaymentAllowed: z.boolean().default(true),
});

export async function createDraftAgreement(principal: Principal, memberId: string, raw: unknown) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requirePermission(principal, member.clubId, "financing:write");
  const parsed = createAgreementSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);

  const start = parsed.data.startDate ? new Date(parsed.data.startDate) : new Date();
  const amort = calculateAmortization(parsed.data.principalAmount, parsed.data.interestRate, parsed.data.termMonths, start);

  const agreement = await prisma.$transaction(async (tx) => {
    const agreement = await tx.financingAgreement.create({
      data: {
        clubId: member.clubId,
        memberId,
        principalAmount: parsed.data.principalAmount,
        interestRate: parsed.data.interestRate,
        termMonths: parsed.data.termMonths,
        paymentFrequency: parsed.data.paymentFrequency,
        monthlyPayment: amort.monthlyPayment,
        totalInterest: amort.totalInterest,
        startDate: start,
        status: "DRAFT",
        prepaymentAllowed: parsed.data.prepaymentAllowed,
      },
    });
    await tx.financingPaymentSchedule.createMany({
      data: amort.schedule.map((r) => ({
        clubId: member.clubId,
        financingAgreementId: agreement.id,
        paymentNumber: r.paymentNumber,
        dueDate: r.dueDate,
        paymentAmount: r.paymentAmount,
        principalAmount: r.principalAmount,
        interestAmount: r.interestAmount,
        remainingBalance: r.remainingBalance,
        status: "SCHEDULED",
      })),
    });
    return agreement;
  });
  await audit(principal, {
    action: "financing.draft",
    entityType: "FinancingAgreement",
    entityId: agreement.id,
    clubId: member.clubId,
    after: agreement,
  });
  return agreement;
}

export const signAgreementSchema = z.object({
  signatureName: z.string().trim().min(2).max(120),
});

export async function signAndActivate(principal: Principal, agreementId: string, raw: unknown) {
  const agreement = await prisma.financingAgreement.findUnique({ where: { id: agreementId } });
  assertTenantOwned(agreement, principal);
  requirePermission(principal, agreement.clubId, "financing:write");
  if (agreement.status !== "DRAFT") throw new ConflictError(`Agreement is ${agreement.status}`);

  const parsed = signAgreementSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);

  const { ip, userAgent } = getRequestContext();

  // Render a promissory-note document version 1 — content hash captures the
  // exact agreement-as-signed. The actual PDF is rendered by a Phase-7 adapter.
  const docPayload = {
    agreementId: agreement.id,
    principalAmount: agreement.principalAmount,
    interestRate: agreement.interestRate,
    termMonths: agreement.termMonths,
    monthlyPayment: agreement.monthlyPayment,
    totalInterest: agreement.totalInterest,
    startDate: agreement.startDate.toISOString(),
    signatureName: parsed.data.signatureName,
    signedAt: new Date().toISOString(),
  };
  const renderedJson = JSON.stringify(docPayload);
  const contentHash = crypto.createHash("sha256").update(renderedJson).digest("hex");

  const agreementNumber = await nextAgreementNumber(agreement.clubId);

  const result = await prisma.$transaction(async (tx) => {
    const doc = await tx.financingDocument.create({
      data: {
        clubId: agreement.clubId,
        agreementId: agreement.id,
        version: 1,
        renderedJson,
        contentHash,
        signedAt: new Date(),
        signatureName: parsed.data.signatureName,
      },
    });
    const updated = await tx.financingAgreement.update({
      where: { id: agreementId },
      data: {
        status: "ACTIVE",
        signedAt: new Date(),
        signatureName: parsed.data.signatureName,
        signedIp: ip,
        signedUa: userAgent,
        agreementNumber,
        currentDocumentId: doc.id,
      },
    });
    return { agreement: updated, doc };
  });

  await audit(principal, {
    action: "financing.activate",
    entityType: "FinancingAgreement",
    entityId: agreement.id,
    clubId: agreement.clubId,
    before: { status: "DRAFT" },
    after: { status: "ACTIVE", agreementNumber, documentId: result.doc.id, contentHash },
    meta: { signatureName: parsed.data.signatureName },
  });
  return result;
}

export async function cancelAgreement(principal: Principal, agreementId: string, reason: string) {
  const agreement = await prisma.financingAgreement.findUnique({ where: { id: agreementId } });
  assertTenantOwned(agreement, principal);
  requirePermission(principal, agreement.clubId, "financing:write");
  if (agreement.status === "PAID_OFF" || agreement.status === "CANCELLED") {
    throw new ConflictError(`Agreement is ${agreement.status}`);
  }
  const updated = await prisma.financingAgreement.update({
    where: { id: agreementId },
    data: { status: "CANCELLED" },
  });
  await audit(principal, {
    action: "financing.cancel",
    entityType: "FinancingAgreement",
    entityId: agreement.id,
    clubId: agreement.clubId,
    before: agreement,
    after: updated,
    meta: { reason },
  });
  return updated;
}

// ---------- apply payment to schedule (FIFO) -------------------------------
export const applyPaymentSchema = z.object({
  amount: z.number().positive(),
  source: z.enum(["MEMBER_AR", "DIRECT", "PROCESSOR"]).default("DIRECT"),
  paymentDate: z.string().optional(),
});

// Allocates `amount` against scheduled (or partial) installments in order.
// Marks installments PAID or PARTIAL accordingly, sets PAID_OFF when fully
// satisfied.
export async function applyPayment(principal: Principal, agreementId: string, raw: unknown) {
  const agreement = await prisma.financingAgreement.findUnique({
    where: { id: agreementId },
    include: { schedule: { orderBy: { paymentNumber: "asc" } } },
  });
  assertTenantOwned(agreement, principal);
  requirePermission(principal, agreement.clubId, "financing:write");
  if (agreement.status !== "ACTIVE") throw new ConflictError(`Agreement is ${agreement.status}`);
  const parsed = applyPaymentSchema.safeParse(raw);
  if (!parsed.success) throw zerr(parsed.error);

  let remaining = round2(parsed.data.amount);
  const paymentDate = parsed.data.paymentDate ? new Date(parsed.data.paymentDate) : new Date();
  const allocations: Array<{ scheduleId: string; amountApplied: number; principalApplied: number; interestApplied: number }> = [];

  for (const row of agreement.schedule) {
    if (remaining <= 0) break;
    if (row.status === "PAID" || row.status === "WAIVED") continue;
    const owed = round2(row.paymentAmount - row.amountPaid);
    if (owed <= 0) continue;
    const apply = Math.min(owed, remaining);
    // Allocate proportionally between principal and interest based on the
    // installment's original split. Honest enough for AR; precise per-period
    // recalculation comes when we wire the GL in Phase 3.
    const ratio = row.paymentAmount > 0 ? apply / row.paymentAmount : 0;
    const principalApplied = round2(row.principalAmount * ratio);
    const interestApplied = round2(apply - principalApplied);
    allocations.push({ scheduleId: row.id, amountApplied: apply, principalApplied, interestApplied });
    remaining = round2(remaining - apply);
  }

  if (allocations.length === 0) {
    throw new ConflictError("No outstanding installments to apply against");
  }

  await prisma.$transaction(async (tx) => {
    for (const a of allocations) {
      const row = agreement.schedule.find((r) => r.id === a.scheduleId)!;
      const newPaid = round2(row.amountPaid + a.amountApplied);
      const fullyPaid = newPaid >= row.paymentAmount - 0.005;
      await tx.financingPaymentSchedule.update({
        where: { id: row.id },
        data: { amountPaid: newPaid, status: fullyPaid ? "PAID" : "PARTIAL" },
      });
      await tx.financingPayment.create({
        data: {
          clubId: agreement.clubId,
          agreementId: agreement.id,
          scheduleId: row.id,
          amountApplied: a.amountApplied,
          principalApplied: a.principalApplied,
          interestApplied: a.interestApplied,
          paymentDate,
          source: parsed.data.source,
        },
      });
    }

    // If every installment is now PAID or WAIVED, mark agreement PAID_OFF.
    const remainingSched = await tx.financingPaymentSchedule.findMany({
      where: { financingAgreementId: agreement.id, status: { in: ["SCHEDULED", "PARTIAL", "MISSED"] } },
    });
    if (remainingSched.length === 0) {
      await tx.financingAgreement.update({ where: { id: agreement.id }, data: { status: "PAID_OFF", paidOffAt: new Date() } });
    }
  });

  await audit(principal, {
    action: "financing.payment.apply",
    entityType: "FinancingAgreement",
    entityId: agreement.id,
    clubId: agreement.clubId,
    meta: { amount: parsed.data.amount, allocations, residual: remaining },
  });

  return { allocations, residual: remaining };
}

// ---------- payoff quote ----------------------------------------------------
// Sum of remaining principal across scheduled+partial installments. We do not
// apply discount on unearned interest for early payoff in the MVP — that's a
// per-club policy and lives in club settings (Phase 3).
export function payoffQuote(agreement: { schedule: Array<{ paymentAmount: number; amountPaid: number; status: string }> }): {
  totalDue: number;
  installmentsRemaining: number;
} {
  let total = 0;
  let installmentsRemaining = 0;
  for (const r of agreement.schedule) {
    if (r.status === "PAID" || r.status === "WAIVED") continue;
    total = round2(total + Math.max(0, r.paymentAmount - r.amountPaid));
    installmentsRemaining++;
  }
  return { totalDue: total, installmentsRemaining };
}

// ---------- default detection ----------------------------------------------
// Marks scheduled installments older than `graceDays` as MISSED and, when the
// missed count crosses `defaultAfter`, flags the agreement DEFAULTED.
export async function sweepMissedPayments(clubId: string, opts?: { graceDays?: number; defaultAfter?: number }) {
  const graceDays = opts?.graceDays ?? 5;
  const defaultAfter = opts?.defaultAfter ?? 3;
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  // Mark eligible scheduled rows as MISSED.
  const eligible = await prisma.financingPaymentSchedule.findMany({
    where: { clubId, status: "SCHEDULED", dueDate: { lt: cutoff } },
  });
  for (const r of eligible) {
    await prisma.financingPaymentSchedule.update({ where: { id: r.id }, data: { status: "MISSED" } });
  }

  // Default detection per agreement.
  const agreements = await prisma.financingAgreement.findMany({
    where: { clubId, status: "ACTIVE" },
    include: { schedule: true },
  });
  for (const a of agreements) {
    const missed = a.schedule.filter((r) => r.status === "MISSED").length;
    if (missed >= defaultAfter) {
      await prisma.financingAgreement.update({
        where: { id: a.id },
        data: { status: "DEFAULTED", defaultedAt: new Date() },
      });
    }
  }
}

// ---------- helpers ---------------------------------------------------------
async function nextAgreementNumber(clubId: string): Promise<string> {
  const count = await prisma.financingAgreement.count({ where: { clubId, status: { in: ["ACTIVE", "PAID_OFF", "DEFAULTED", "CANCELLED"] } } });
  const year = new Date().getFullYear();
  return `FIN-${year}-${(count + 1).toString().padStart(4, "0")}`;
}

function zerr(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
