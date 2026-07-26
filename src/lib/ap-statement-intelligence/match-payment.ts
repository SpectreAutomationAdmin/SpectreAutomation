// Sprint 3 Checkpoint 15G (2026-07-24) — Statement payment matching.
//
// Layered rules:
//   1. Vendor + processorRef + amount → EXACT_MATCH
//   2. Vendor + amount + date within tolerance → PROBABLE_MATCH
//   3. Payment status VOIDED → VOIDED_PAYMENT_CONFLICT (statement
//      shows a payment that Spectre voided)
//   4. Payment exists with matching processorRef but different
//      amount → PAYMENT_AMOUNT_MISMATCH
//   5. Nothing → PAYMENT_NOT_FOUND
//
// Note: Spectre AP has no first-class "unapplied payment" — the
// UNAPPLIED_PAYMENT state is only reachable when Phase K-style
// invoice-level application data is present. For this checkpoint we
// treat vendor-level matches without a linked invoice as PROBABLE.

import { prisma } from "@/lib/prisma";
import { toMoney } from "@/lib/accounting/decimal";
import type { ExtractedStatementLine, StatementMatchState } from "./types";

const AMOUNT_TOLERANCE_CENTS = 2;
const DATE_TOLERANCE_DAYS = 5;

export interface PaymentMatchArgs {
  clubId: string;
  canonicalVendorId: string;
  line: ExtractedStatementLine;
}

export interface PaymentMatchResult {
  state: StatementMatchState;
  matchedPaymentId: string | null;
  matchBasis: { ruleKey: string; signals: string[] };
  amountDifferenceCents: number | null;
  dateDifferenceDays: number | null;
}

function normaliseRef(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export async function matchPaymentLine(args: PaymentMatchArgs): Promise<PaymentMatchResult> {
  const line = args.line;
  // Payments on a statement typically appear as CREDIT amounts.
  const lineAmount = toMoney(line.creditAmount ?? line.debitAmount ?? "0").abs();
  if (lineAmount.isZero()) {
    return { state: "PAYMENT_NOT_FOUND", matchedPaymentId: null, matchBasis: { ruleKey: "payment.no_amount", signals: [] }, amountDifferenceCents: null, dateDifferenceDays: null };
  }
  const refNorm = normaliseRef(line.referenceNumber);
  const lineDate = line.transactionDate ? new Date(line.transactionDate) : null;

  // Signal 1: vendor + processorRef.
  if (refNorm.length >= 3) {
    const refHits = await prisma.vendorPayment.findMany({
      where: { clubId: args.clubId, vendorId: args.canonicalVendorId, NOT: { processorRef: null } },
      select: { id: true, processorRef: true, amount: true, paymentDate: true, status: true },
      take: 200,
    });
    const hits = refHits.filter((p) => normaliseRef(p.processorRef) === refNorm);
    if (hits.length === 1) {
      const hit = hits[0];
      const diffCents = Math.round(toMoney(hit.amount).minus(lineAmount).abs().mul(100).toNumber());
      const dateDiffDays = lineDate ? Math.abs((lineDate.getTime() - hit.paymentDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;
      if (hit.status === "VOIDED") {
        return {
          state: "VOIDED_PAYMENT_CONFLICT",
          matchedPaymentId: hit.id,
          matchBasis: { ruleKey: "payment.ref_match_voided", signals: ["ref"] },
          amountDifferenceCents: diffCents,
          dateDifferenceDays: Math.round(dateDiffDays),
        };
      }
      if (diffCents > AMOUNT_TOLERANCE_CENTS) {
        return {
          state: "PAYMENT_AMOUNT_MISMATCH",
          matchedPaymentId: hit.id,
          matchBasis: { ruleKey: "payment.ref_match_amount_differs", signals: ["ref"] },
          amountDifferenceCents: diffCents,
          dateDifferenceDays: Math.round(dateDiffDays),
        };
      }
      if (dateDiffDays > DATE_TOLERANCE_DAYS) {
        return {
          state: "PAYMENT_DATE_MISMATCH",
          matchedPaymentId: hit.id,
          matchBasis: { ruleKey: "payment.ref_match_date_differs", signals: ["ref", "amount"] },
          amountDifferenceCents: diffCents,
          dateDifferenceDays: Math.round(dateDiffDays),
        };
      }
      return {
        state: "EXACT_MATCH",
        matchedPaymentId: hit.id,
        matchBasis: { ruleKey: "payment.ref_amount_date_exact", signals: ["ref", "amount", "date"] },
        amountDifferenceCents: diffCents,
        dateDifferenceDays: Math.round(dateDiffDays),
      };
    }
  }

  // Signal 2: vendor + amount + date proximity.
  if (lineDate) {
    const dayMs = 24 * 60 * 60 * 1000;
    const dateFrom = new Date(lineDate.getTime() - DATE_TOLERANCE_DAYS * dayMs);
    const dateTo = new Date(lineDate.getTime() + DATE_TOLERANCE_DAYS * dayMs);
    const candidates = await prisma.vendorPayment.findMany({
      where: {
        clubId: args.clubId, vendorId: args.canonicalVendorId,
        paymentDate: { gte: dateFrom, lte: dateTo },
      },
      select: { id: true, amount: true, paymentDate: true, status: true, invoiceId: true },
      take: 200,
    });
    const amountHits = candidates.filter((p) => {
      const diff = Math.round(toMoney(p.amount).minus(lineAmount).abs().mul(100).toNumber());
      return diff <= AMOUNT_TOLERANCE_CENTS;
    });
    if (amountHits.length === 1) {
      const hit = amountHits[0];
      const dateDiffDays = Math.abs((lineDate.getTime() - hit.paymentDate.getTime()) / (1000 * 60 * 60 * 24));
      // No invoice application → we found the payment but can't prove
      // which invoice it settled. Flag as UNAPPLIED so the reviewer knows.
      if (!hit.invoiceId) {
        return {
          state: "UNAPPLIED_PAYMENT",
          matchedPaymentId: hit.id,
          matchBasis: { ruleKey: "payment.vendor_amount_date_no_invoice_link", signals: ["amount", "date"] },
          amountDifferenceCents: 0,
          dateDifferenceDays: Math.round(dateDiffDays),
        };
      }
      return {
        state: "PROBABLE_MATCH",
        matchedPaymentId: hit.id,
        matchBasis: { ruleKey: "payment.amount_date_probable", signals: ["amount", "date"] },
        amountDifferenceCents: 0,
        dateDifferenceDays: Math.round(dateDiffDays),
      };
    }
    if (amountHits.length > 1) {
      return {
        state: "AMBIGUOUS_MATCH",
        matchedPaymentId: amountHits[0].id,
        matchBasis: { ruleKey: "payment.amount_date_ambiguous", signals: ["amount", "date"] },
        amountDifferenceCents: 0,
        dateDifferenceDays: null,
      };
    }
  }

  return {
    state: "PAYMENT_NOT_FOUND",
    matchedPaymentId: null,
    matchBasis: { ruleKey: "payment.not_found", signals: [] },
    amountDifferenceCents: null,
    dateDifferenceDays: null,
  };
}
