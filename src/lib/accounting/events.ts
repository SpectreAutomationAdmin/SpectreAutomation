// System-generated accounting entries.
//
// Operational modules (AR, AP, payroll, …) call into this adapter rather than
// touching the GL directly. Adapters are responsible for:
//   1. Resolving the right GL accounts (per-club mapping).
//   2. Building a balanced journal entry payload.
//   3. Posting via `createPostedFromAdapter` which bypasses the manual-posting
//      restriction on control accounts and posts through soft-locked periods.
//
// Idempotency: each adapter writes ONE journal entry per source record. The
// (sourceEntityType, sourceEntityId) pair on JournalEntry is the natural key.

import { prisma } from "../prisma";
import { createPostedFromAdapter } from "./journal";
import { findPeriodForDate } from "./periods";
import type { Principal } from "../rbac";
import { AR_CATEGORY_TO_REVENUE } from "./coa-template";
import { toMoney } from "./decimal";

export type AdapterResult = { entryId: string | null; existing: boolean; skipped?: string };

async function existingFor(sourceEntityType: string, sourceEntityId: string) {
  return prisma.journalEntry.findFirst({
    where: { sourceEntityType, sourceEntityId, status: { in: ["POSTED", "DRAFT", "APPROVED"] } },
  });
}

// ---- AR Charge -> GL ----
// DR Member AR Control (1110), CR Revenue (by category mapping)
export async function postChargeToGl(principal: Principal, chargeId: string): Promise<AdapterResult> {
  const existing = await existingFor("Charge", chargeId);
  if (existing) return { entryId: existing.id, existing: true };

  const charge = await prisma.charge.findUnique({ where: { id: chargeId } });
  if (!charge) return { entryId: null, existing: false, skipped: "charge_missing" };
  if (charge.status !== "POSTED") return { entryId: null, existing: false, skipped: `status_${charge.status}` };
  if (!(await findPeriodForDate(charge.clubId, charge.transactionDate))) {
    return { entryId: null, existing: false, skipped: "no_period" };
  }

  const revenueAccountNum = AR_CATEGORY_TO_REVENUE[charge.category] ?? "4900";
  const amount = toMoney(charge.amount).toString();
  const entry = await createPostedFromAdapter(
    principal,
    charge.clubId,
    {
      entryDate: charge.transactionDate,
      description: `AR charge: ${charge.description}`,
      lines: [
        { accountNumber: "1110", debit: amount, description: charge.description, memberId: charge.memberId },
        { accountNumber: revenueAccountNum, credit: amount, description: charge.description, memberId: charge.memberId },
      ],
    },
    { source: "AR_CHARGE", sourceEntityType: "Charge", sourceEntityId: charge.id }
  );
  return { entryId: entry.id, existing: false };
}

// ---- AR Payment -> GL ----
// DR Operating Bank (1010), CR Member AR Control (1110)
export async function postPaymentToGl(principal: Principal, paymentId: string): Promise<AdapterResult> {
  const existing = await existingFor("Payment", paymentId);
  if (existing) return { entryId: existing.id, existing: true };

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return { entryId: null, existing: false, skipped: "payment_missing" };
  if (payment.status !== "SUCCESS") return { entryId: null, existing: false, skipped: `status_${payment.status}` };
  if (!(await findPeriodForDate(payment.clubId, payment.paymentDate))) {
    return { entryId: null, existing: false, skipped: "no_period" };
  }

  const amount = toMoney(payment.amount).toString();
  const entry = await createPostedFromAdapter(
    principal,
    payment.clubId,
    {
      entryDate: payment.paymentDate,
      description: `AR payment received (${payment.method})`,
      lines: [
        { accountNumber: "1010", debit: amount, description: "Cash receipt", memberId: payment.memberId },
        { accountNumber: "1110", credit: amount, description: "Member AR", memberId: payment.memberId },
      ],
    },
    { source: "AR_PAYMENT", sourceEntityType: "Payment", sourceEntityId: payment.id }
  );
  return { entryId: entry.id, existing: false };
}

// ---- AR Adjustment -> GL ----
// CREDIT  : DR Other Revenue (4900), CR Member AR (1110)
// DEBIT   : DR Member AR (1110), CR Other Revenue (4900)
// WRITE_OFF: DR Bad Debt (6500),  CR Member AR (1110)
// REFUND  : DR Member AR (1110), CR Operating Bank (1010)
export async function postAdjustmentToGl(principal: Principal, adjId: string): Promise<AdapterResult> {
  const existing = await existingFor("AccountAdjustment", adjId);
  if (existing) return { entryId: existing.id, existing: true };

  const adj = await prisma.accountAdjustment.findUnique({ where: { id: adjId } });
  if (!adj) return { entryId: null, existing: false, skipped: "adj_missing" };
  if (adj.status !== "POSTED") return { entryId: null, existing: false, skipped: `status_${adj.status}` };
  if (!(await findPeriodForDate(adj.clubId, adj.transactionDate))) {
    return { entryId: null, existing: false, skipped: "no_period" };
  }

  const amount = toMoney(adj.amount).toString();
  let dr: string, cr: string, description = adj.description;
  switch (adj.type) {
    case "CREDIT":    dr = "4900"; cr = "1110"; break;
    case "DEBIT":     dr = "1110"; cr = "4900"; break;
    case "WRITE_OFF": dr = "6500"; cr = "1110"; description = `Bad debt write-off: ${description}`; break;
    case "REFUND":    dr = "1110"; cr = "1010"; break;
    default:          return { entryId: null, existing: false, skipped: `type_${adj.type}` }; // TRANSFER deferred
  }

  const entry = await createPostedFromAdapter(
    principal,
    adj.clubId,
    {
      entryDate: adj.transactionDate,
      description,
      lines: [
        { accountNumber: dr, debit: amount, description, memberId: adj.memberId },
        { accountNumber: cr, credit: amount, description, memberId: adj.memberId },
      ],
    },
    { source: "AR_ADJUSTMENT", sourceEntityType: "AccountAdjustment", sourceEntityId: adj.id }
  );
  return { entryId: entry.id, existing: false };
}

// Replays all AR posts for a club. Used by the seed and by the controller's
// "rebuild GL" admin action. Returns counts of work performed.
export async function backfillArToGl(principal: Principal, clubId: string) {
  let chargesPosted = 0, paymentsPosted = 0, adjustmentsPosted = 0, skipped = 0;
  const charges = await prisma.charge.findMany({ where: { clubId, status: "POSTED" } });
  for (const c of charges) {
    const r = await postChargeToGl(principal, c.id);
    if (r.entryId && !r.existing) chargesPosted++;
    else if (!r.entryId) skipped++;
  }
  const payments = await prisma.payment.findMany({ where: { clubId, status: "SUCCESS" } });
  for (const p of payments) {
    const r = await postPaymentToGl(principal, p.id);
    if (r.entryId && !r.existing) paymentsPosted++;
    else if (!r.entryId) skipped++;
  }
  const adj = await prisma.accountAdjustment.findMany({ where: { clubId, status: "POSTED" } });
  for (const a of adj) {
    const r = await postAdjustmentToGl(principal, a.id);
    if (r.entryId && !r.existing) adjustmentsPosted++;
    else if (!r.entryId) skipped++;
  }
  return { chargesPosted, paymentsPosted, adjustmentsPosted, skipped };
}
